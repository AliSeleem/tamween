use std::collections::BTreeMap;

use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{positive_int, trimmed, Ctx};
use crate::error::{Error, Result};
use crate::inventory::{add_inventory, reverse_inventory_refs, InventoryEntry};
use crate::ledger::{add_ledger, reverse_ledger_refs, LedgerEntry};
use crate::periods::{period_status, require_open_period};
use crate::util::{add_months, is_month};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DistributionItem {
    pub product_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    pub quantity: f64,
    pub applies_to_month: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub id: i64,
    pub card_id: i64,
    pub card_number: Option<String>,
    pub secret_ref: Option<String>,
    pub holder_name: String,
    pub month: String,
    pub distributed_at: String,
    pub status: String,
    pub void_reason: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub items: Vec<DistributionItem>,
    pub created_by: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFilter {
    #[serde(default)]
    pub card_id: Option<i64>,
    #[serde(default)]
    pub month: Option<String>,
}

pub fn list_distributions(ctx: &Ctx, f: DistributionFilter) -> Result<Vec<Distribution>> {
    let mut where_parts: Vec<&str> = Vec::new();
    let mut p: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(id) = f.card_id {
        where_parts.push("d.card_id = ?");
        p.push(id.into());
    }
    if let Some(m) = f.month.filter(|m| !m.is_empty()) {
        where_parts.push("d.month = ?");
        p.push(m.into());
    }
    let w = if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };
    let mut rows: Vec<Distribution> = ctx.db.all(
        &format!(
            "SELECT d.id, d.card_id AS cardId, c.card_number AS cardNumber, c.secret_ref AS secretRef, c.holder_name AS holderName, d.month,
               d.distributed_at AS distributedAt, d.status, d.void_reason AS voidReason, d.notes, u.display_name AS createdBy
             FROM distributions d JOIN cards c ON c.id = d.card_id LEFT JOIN users u ON u.id = d.created_by
             {w} ORDER BY d.id DESC"
        ),
        params_from_iter(p.iter()),
    )?;
    if rows.is_empty() {
        return Ok(rows);
    }
    #[derive(Deserialize)]
    struct ItemRow {
        distribution_id: i64,
        product_id: i64,
        product_name: String,
        quantity: i64,
        applies_to_month: String,
    }
    let placeholders = vec!["?"; rows.len()].join(",");
    let ids: Vec<rusqlite::types::Value> = rows.iter().map(|r| r.id.into()).collect();
    let items: Vec<ItemRow> = ctx.db.all(
        &format!(
            "SELECT i.distribution_id, i.product_id, p.name AS product_name, i.quantity, i.applies_to_month
             FROM distribution_items i JOIN products p ON p.id = i.product_id
             WHERE i.distribution_id IN ({placeholders}) ORDER BY p.sort_order, p.id"
        ),
        params_from_iter(ids.iter()),
    )?;
    for r in &mut rows {
        r.items = items
            .iter()
            .filter(|i| i.distribution_id == r.id)
            .map(|i| DistributionItem {
                product_id: i.product_id,
                product_name: Some(i.product_name.clone()),
                quantity: i.quantity as f64,
                applies_to_month: i.applies_to_month.clone(),
            })
            .collect();
    }
    Ok(rows)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DistributionInput {
    pub card_id: i64,
    pub month: String,
    #[serde(default)]
    pub distributed_at: Option<String>,
    pub items: Vec<DistributionItem>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Records goods physically handed to the citizen. Independent of the POS: it may come before or after the
/// strike, and the two meet in the ledger of the same card and month. Each item is taken from the right of
/// `appliesToMonth`; the month after the operation's month makes it an advance against next month.
pub fn record_distribution(ctx: &Ctx, input: DistributionInput) -> Result<Distribution> {
    let user = ctx.require_user()?;
    ctx.db.tx(|| {
        require_open_period(ctx, &input.month)?;
        if !ctx.db.exists("SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?", params![input.month, input.card_id])? {
            bail!("البطاقة غير مدرجة في هذا الشهر");
        }
        let items: Vec<(i64, i64, &str)> = input
            .items
            .iter()
            .filter(|i| i.quantity != 0.0)
            .map(|i| Ok((i.product_id, positive_int(i.quantity, "الكمية")?, i.applies_to_month.as_str())))
            .collect::<Result<_>>()?;
        if items.is_empty() {
            bail!("أدخل كمية صنف واحد على الأقل");
        }
        let advance_month = add_months(&input.month, 1);
        let mut requested: BTreeMap<(&str, i64), i64> = BTreeMap::new();
        for &(pid, qty, month) in &items {
            if !is_month(month) {
                bail!("شهر الاستحقاق غير صحيح");
            }
            *requested.entry((month, pid)).or_insert(0) += qty;
        }
        for (&(m, pid), &qty) in &requested {
            let Some(name) = ctx.db.value::<String>("SELECT name FROM products WHERE id = ?", [pid])? else { bail!("صنف غير معروف") };
            if m == advance_month {
                continue; // advance: deducted from next month's right when it opens
            }
            if period_status(ctx, m)?.as_deref() != Some("open") {
                bail!("لا يمكن الصرف على حساب شهر {m}");
            }
            let is_rule_product = ctx
                .db
                .exists("SELECT 1 FROM entitlement_rules WHERE month = ? AND product_id = ? AND quantity > 0", params![m, pid])?;
            if !is_rule_product {
                continue; // items outside the rules may be handed out before their POS strike
            }
            let remaining = ctx.db.int(
                "SELECT SUM(quantity) FROM citizen_ledger WHERE card_id = ? AND month = ? AND product_id = ?",
                params![input.card_id, m, pid],
            )?;
            if qty > remaining {
                bail!(
                    "الكمية المطلوبة من {name} ({qty}) أكبر من المتبقي للمواطن ({remaining}). سجّل الزيادة كمقدم على الشهر التالي إذا كان متفقًا عليه"
                );
            }
        }

        let date = match trimmed(&input.distributed_at) {
            Some(d) => d,
            None => ctx.db.today()?,
        };
        let id = ctx
            .db
            .run(
                "INSERT INTO distributions (card_id, month, distributed_at, notes, created_by) VALUES (?, ?, ?, ?, ?)",
                params![input.card_id, input.month, date, trimmed(&input.notes), user.id],
            )?
            .last_id;
        for &(product_id, quantity, applies_to) in &items {
            ctx.db.run(
                "INSERT INTO distribution_items (distribution_id, product_id, quantity, applies_to_month) VALUES (?, ?, ?, ?)",
                params![id, product_id, quantity, applies_to],
            )?;
            let advance_note = format!("مقدم من {}", input.month);
            add_ledger(
                ctx,
                LedgerEntry {
                    card_id: input.card_id,
                    month: applies_to,
                    product_id,
                    kind: "delivery",
                    quantity: -quantity,
                    ref_type: Some("distribution"),
                    ref_id: Some(id),
                    note: Some(if applies_to == advance_month { &advance_note } else { "استلام فعلي" }),
                },
            )?;
            add_inventory(
                ctx,
                InventoryEntry {
                    product_id,
                    kind: "distribution",
                    quantity: -quantity,
                    date: &date,
                    document_ref: None,
                    ref_type: Some("distribution"),
                    ref_id: Some(id),
                    note: Some("صرف للبطاقة"),
                },
            )?;
        }
        let logged: Vec<_> = items
            .iter()
            .map(|&(pid, qty, m)| json!({ "productId": pid, "quantity": qty, "appliesToMonth": m }))
            .collect();
        ctx.audit(
            "create",
            "distribution",
            Some(id.to_string()),
            Some(&json!({ "cardId": input.card_id, "month": input.month, "items": logged })),
        )?;
        list_distributions(ctx, DistributionFilter { card_id: Some(input.card_id), month: None })?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| Error::Internal("the new distribution was not found".into()))
    })
}

pub fn void_distribution(ctx: &Ctx, id: i64, reason: &str) -> Result<()> {
    let user = ctx.require_admin()?;
    let reason = reason.trim();
    if reason.is_empty() {
        bail!("سبب الإلغاء مطلوب");
    }
    ctx.db.tx(|| {
        #[derive(Deserialize)]
        struct Row {
            status: String,
            month: String,
        }
        let Some(d) = ctx.db.get::<Row>("SELECT status, month FROM distributions WHERE id = ?", [id])? else {
            bail!("العملية غير موجودة")
        };
        if d.status != "active" {
            bail!("العملية ملغاة من قبل");
        }
        require_open_period(ctx, &d.month)?;
        let closed: Option<String> = ctx.db.value(
            "SELECT p.month FROM distribution_items i JOIN periods p ON p.month = i.applies_to_month
             WHERE i.distribution_id = ? AND p.status = 'closed' LIMIT 1",
            [id],
        )?;
        if let Some(month) = closed {
            bail!("لا يمكن الإلغاء: الصرف محسوب على شهر {month} المغلق");
        }
        ctx.db.run(
            "UPDATE distributions SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = datetime('now', 'localtime') WHERE id = ?",
            params![reason, user.id, id],
        )?;
        reverse_ledger_refs(ctx, "distribution", id, &format!("إلغاء استلام: {reason}"))?;
        reverse_inventory_refs(ctx, "distribution", id, &format!("إلغاء استلام: {reason}"))?;
        ctx.audit("void", "distribution", Some(id.to_string()), Some(&json!({ "reason": reason })))
    })
}
