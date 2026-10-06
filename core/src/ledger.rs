use std::collections::HashMap;

use rusqlite::{named_params, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::context::Ctx;
use crate::error::Result;

pub struct LedgerEntry<'a> {
    pub card_id: i64,
    pub month: &'a str,
    pub product_id: i64,
    /// entitlement | pos_right | delivery | carry_in | carry_out | expire
    pub kind: &'a str,
    pub quantity: i64,
    pub ref_type: Option<&'a str>,
    pub ref_id: Option<i64>,
    pub note: Option<&'a str>,
}

pub fn add_ledger(ctx: &Ctx, e: LedgerEntry) -> Result<()> {
    if e.quantity == 0 {
        return Ok(());
    }
    ctx.db.run(
        "INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity, ref_type, ref_id, note, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![e.card_id, e.month, e.product_id, e.kind, e.quantity, e.ref_type, e.ref_id, e.note, ctx.user_id()],
    )?;
    Ok(())
}

/// Writes the opposite of every ledger row that a voided operation created.
pub fn reverse_ledger_refs(ctx: &Ctx, ref_type: &str, ref_id: i64, note: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Row {
        card_id: i64,
        month: String,
        product_id: i64,
        entry_type: String,
        quantity: i64,
    }
    let rows: Vec<Row> = ctx.db.all(
        "SELECT card_id, month, product_id, entry_type, quantity FROM citizen_ledger WHERE ref_type = ? AND ref_id = ?",
        params![ref_type, ref_id],
    )?;
    for r in rows {
        add_ledger(
            ctx,
            LedgerEntry {
                card_id: r.card_id,
                month: &r.month,
                product_id: r.product_id,
                kind: &r.entry_type,
                quantity: -r.quantity,
                ref_type: Some("void"),
                ref_id: Some(ref_id),
                note: Some(note),
            },
        )?;
    }
    Ok(())
}

/// One row of the citizen rights ledger summary for a card, month and product.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RightsRow {
    pub month: String,
    pub product_id: i64,
    pub product_name: String,
    pub unit: String,
    pub entitled: i64,
    pub pos_right: i64,
    pub carried_in: i64,
    pub delivered: i64,
    pub carried_out: i64,
    pub expired: i64,
    pub remaining: i64,
    #[serde(default)]
    pub pos_quantity: i64,
}

/// Rights summary per month and product for one card; optionally limited to one month.
pub fn card_rights(ctx: &Ctx, card_id: i64, month: Option<&str>) -> Result<Vec<RightsRow>> {
    let mut params: Vec<rusqlite::types::Value> = vec![card_id.into()];
    if let Some(m) = month {
        params.push(m.to_string().into());
    }
    let month_filter = if month.is_some() { " AND l.month = ?" } else { "" };
    let mut out: Vec<RightsRow> = ctx.db.all(
        &format!(
            "SELECT l.month, l.product_id AS productId, p.name AS productName, p.unit,
               SUM(CASE WHEN entry_type = 'entitlement' THEN quantity ELSE 0 END) AS entitled,
               SUM(CASE WHEN entry_type = 'pos_right' THEN quantity ELSE 0 END) AS posRight,
               SUM(CASE WHEN entry_type = 'carry_in' THEN quantity ELSE 0 END) AS carriedIn,
               -SUM(CASE WHEN entry_type = 'delivery' THEN quantity ELSE 0 END) AS delivered,
               -SUM(CASE WHEN entry_type = 'carry_out' THEN quantity ELSE 0 END) AS carriedOut,
               -SUM(CASE WHEN entry_type = 'expire' THEN quantity ELSE 0 END) AS expired,
               SUM(quantity) AS remaining
             FROM citizen_ledger l JOIN products p ON p.id = l.product_id
             WHERE l.card_id = ?{month_filter}
             GROUP BY l.month, l.product_id
             ORDER BY l.month DESC, p.sort_order, p.id"
        ),
        params_from_iter(params.iter()),
    )?;
    #[derive(Deserialize)]
    struct Pos {
        month: String,
        product_id: i64,
        qty: i64,
        name: String,
        unit: String,
    }
    let month_filter = if month.is_some() { " AND t.month = ?" } else { "" };
    let pos: Vec<Pos> = ctx.db.all(
        &format!(
            "SELECT t.month, i.product_id, SUM(i.quantity) AS qty, p.name, p.unit
             FROM pos_transactions t JOIN pos_transaction_items i ON i.transaction_id = t.id JOIN products p ON p.id = i.product_id
             WHERE t.card_id = ? AND t.status = 'active'{month_filter}
             GROUP BY t.month, i.product_id"
        ),
        params_from_iter(params.iter()),
    )?;
    let pos_map: HashMap<(&str, i64), i64> = pos.iter().map(|p| ((p.month.as_str(), p.product_id), p.qty)).collect();
    for r in &mut out {
        r.pos_quantity = pos_map.get(&(r.month.as_str(), r.product_id)).copied().unwrap_or(0);
    }
    // Products struck on the POS but with no ledger rows (rule products struck before any entitlement) still show up.
    for p in &pos {
        if !out.iter().any(|o| o.month == p.month && o.product_id == p.product_id) {
            out.push(RightsRow {
                month: p.month.clone(),
                product_id: p.product_id,
                product_name: p.name.clone(),
                unit: p.unit.clone(),
                entitled: 0,
                pos_right: 0,
                carried_in: 0,
                delivered: 0,
                carried_out: 0,
                expired: 0,
                remaining: 0,
                pos_quantity: p.qty,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct CardMonthStatus {
    pub card_id: i64,
    /// none | struck | partial
    pub pos_status: &'static str,
    /// none | full | partial
    pub receipt_status: &'static str,
    pub remaining_units: i64,
    pub owed_units: i64,
    pub needs_link: bool,
    pub delivered: i64,
    pub pos_count: i64,
}

/// POS and receipt status of every card in a month (or one card), computed from the ledger and POS transactions.
pub fn month_statuses(ctx: &Ctx, month: &str, card_id: Option<i64>) -> Result<HashMap<i64, CardMonthStatus>> {
    #[derive(Deserialize)]
    struct Row {
        card_id: i64,
        pos_rem: Option<i64>,
        neg_rem: Option<i64>,
        delivered: Option<i64>,
        entitled: Option<i64>,
        tx_count: Option<i64>,
        core_struck: Option<i64>,
    }
    // :card is NULL for all cards
    let rows: Vec<Row> = ctx.db.all(
        "WITH l AS (
           SELECT card_id, product_id,
             SUM(quantity) AS remaining,
             -SUM(CASE WHEN entry_type = 'delivery' THEN quantity ELSE 0 END) AS delivered,
             SUM(CASE WHEN entry_type = 'entitlement' THEN quantity ELSE 0 END) AS entitled
           FROM citizen_ledger WHERE month = :m AND (:card IS NULL OR card_id = :card)
           GROUP BY card_id, product_id
         ),
         lc AS (
           SELECT card_id, SUM(MAX(remaining, 0)) AS pos_rem, SUM(MAX(-remaining, 0)) AS neg_rem,
             SUM(delivered) AS delivered, SUM(entitled) AS entitled
           FROM l GROUP BY card_id
         ),
         rp AS (SELECT DISTINCT product_id FROM entitlement_rules WHERE month = :m AND quantity > 0),
         p AS (
           SELECT t.card_id, COUNT(DISTINCT t.id) AS tx_count,
             SUM(CASE WHEN rp.product_id IS NOT NULL THEN i.quantity ELSE 0 END) AS core_struck
           FROM pos_transactions t
           JOIN pos_transaction_items i ON i.transaction_id = t.id
           LEFT JOIN rp ON rp.product_id = i.product_id
           WHERE t.month = :m AND t.status = 'active' AND (:card IS NULL OR t.card_id = :card)
           GROUP BY t.card_id
         ),
         ids AS (
           SELECT card_id FROM card_monthly_snapshots WHERE month = :m AND (:card IS NULL OR card_id = :card)
           UNION SELECT card_id FROM lc UNION SELECT card_id FROM p
         )
         SELECT ids.card_id, lc.pos_rem, lc.neg_rem, lc.delivered, lc.entitled, p.tx_count, p.core_struck
         FROM ids LEFT JOIN lc ON lc.card_id = ids.card_id LEFT JOIN p ON p.card_id = ids.card_id",
        named_params! { ":m": month, ":card": card_id },
    )?;
    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        let tx_count = r.tx_count.unwrap_or(0);
        let delivered = r.delivered.unwrap_or(0);
        let remaining = r.pos_rem.unwrap_or(0);
        let pos_status = if tx_count == 0 {
            "none"
        } else if r.core_struck.unwrap_or(0) < r.entitled.unwrap_or(0) {
            "partial"
        } else {
            "struck"
        };
        let receipt_status = if delivered <= 0 {
            "none"
        } else if remaining == 0 {
            "full"
        } else {
            "partial"
        };
        out.insert(
            r.card_id,
            CardMonthStatus {
                card_id: r.card_id,
                pos_status,
                receipt_status,
                remaining_units: remaining,
                owed_units: r.neg_rem.unwrap_or(0),
                needs_link: delivered > 0 && tx_count == 0,
                delivered,
                pos_count: tx_count,
            },
        );
    }
    Ok(out)
}
