use std::collections::BTreeMap;

use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{as_int, positive_int, trimmed, Ctx};
use crate::error::{Error, Result};
use crate::ledger::{add_ledger, reverse_ledger_refs, LedgerEntry};
use crate::periods::require_open_period;
use crate::settings::get_settings;
use crate::util::{format_money, is_month};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PosBatch {
    pub id: i64,
    pub batch_number: String,
    pub month: String,
    pub institution: Option<String>,
    pub money_limit_piasters: i64,
    pub sugar_limit: i64,
    pub oil_limit: i64,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: String,
}

const SELECT_BATCH: &str = "SELECT id, batch_number AS batchNumber, month, institution, money_limit_piasters AS moneyLimitPiasters,
   sugar_limit AS sugarLimit, oil_limit AS oilLimit, status, notes, created_at AS createdAt FROM pos_batches";

pub fn list_batches(ctx: &Ctx, month: Option<&str>) -> Result<Vec<PosBatch>> {
    match month.filter(|m| !m.is_empty()) {
        Some(m) => ctx.db.all(&format!("{SELECT_BATCH} WHERE month = ? ORDER BY id DESC"), [m]),
        None => ctx.db.all(&format!("{SELECT_BATCH} ORDER BY id DESC"), []),
    }
}

pub fn get_batch(ctx: &Ctx, id: i64) -> Result<PosBatch> {
    ctx.db.get(&format!("{SELECT_BATCH} WHERE id = ?"), [id])?.ok_or_else(|| Error::App("الدفعة غير موجودة".into()))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchInput {
    pub month: String,
    #[serde(default)]
    pub batch_number: Option<String>,
    #[serde(default)]
    pub institution: Option<String>,
    #[serde(default)]
    pub money_limit_piasters: Option<f64>,
    #[serde(default)]
    pub sugar_limit: Option<f64>,
    #[serde(default)]
    pub oil_limit: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
}

pub fn create_batch(ctx: &Ctx, input: BatchInput) -> Result<PosBatch> {
    let user = ctx.require_user()?;
    if !is_month(&input.month) {
        bail!("صيغة الشهر غير صحيحة");
    }
    let s = get_settings(ctx)?;
    ctx.db.tx(|| {
        require_open_period(ctx, &input.month)?;
        let number = match trimmed(&input.batch_number) {
            Some(n) => {
                if ctx.db.exists("SELECT 1 FROM pos_batches WHERE batch_number = ?", [&n])? {
                    bail!("رقم الدفعة مستخدم من قبل");
                }
                n
            }
            None => {
                let n = ctx.db.int("SELECT COUNT(*) AS n FROM pos_batches WHERE month = ?", [&input.month])?;
                let mut number = format!("{}/{}", input.month, n + 1);
                while ctx.db.exists("SELECT 1 FROM pos_batches WHERE batch_number = ?", [&number])? {
                    number.push('*');
                }
                number
            }
        };
        let limits = [
            (input.money_limit_piasters, s.default_money_limit_piasters),
            (input.sugar_limit, s.default_sugar_limit),
            (input.oil_limit, s.default_oil_limit),
        ];
        let mut values = [0i64; 3];
        for (i, (given, default)) in limits.into_iter().enumerate() {
            values[i] = match given {
                Some(v) => match as_int(v).filter(|&v| v >= 0) {
                    Some(v) => v,
                    None => bail!("حدود الدفعة غير صحيحة"),
                },
                None => default,
            };
        }
        let [money, sugar, oil] = values;
        let id = ctx
            .db
            .run(
                "INSERT INTO pos_batches (batch_number, month, institution, money_limit_piasters, sugar_limit, oil_limit, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![number, input.month, trimmed(&input.institution), money, sugar, oil, trimmed(&input.notes), user.id],
            )?
            .last_id;
        ctx.audit(
            "create",
            "pos_batch",
            Some(id.to_string()),
            Some(&json!({ "number": number, "month": input.month, "money": money, "sugar": sugar, "oil": oil })),
        )?;
        get_batch(ctx, id)
    })
}

pub fn set_batch_status(ctx: &Ctx, id: i64, status: &str) -> Result<PosBatch> {
    ctx.require_admin()?;
    if status != "open" && status != "closed" {
        bail!("حالة الدفعة غير صحيحة");
    }
    ctx.db.tx(|| {
        let b = get_batch(ctx, id)?;
        if status == "open" {
            require_open_period(ctx, &b.month)?;
        }
        ctx.db.run("UPDATE pos_batches SET status = ? WHERE id = ?", params![status, id])?;
        ctx.audit0(if status == "closed" { "close" } else { "reopen" }, "pos_batch", Some(id.to_string()))?;
        get_batch(ctx, id)
    })
}

struct BatchUsage {
    count: i64,
    money: i64,
    sugar: i64,
    oil: i64,
    overage: i64,
    shortfall: i64,
}

fn batch_usage(ctx: &Ctx, batch_id: i64) -> Result<BatchUsage> {
    #[derive(Deserialize)]
    struct Totals {
        count: i64,
        money: Option<i64>,
        overage: Option<i64>,
        shortfall: Option<i64>,
    }
    let t: Totals = ctx
        .db
        .get(
            "SELECT COUNT(*) AS count, SUM(total_piasters) AS money,
               SUM(CASE WHEN difference_piasters > 0 THEN difference_piasters ELSE 0 END) AS overage,
               SUM(CASE WHEN difference_piasters < 0 THEN -difference_piasters ELSE 0 END) AS shortfall
             FROM pos_transactions WHERE batch_id = ? AND status = 'active'",
            [batch_id],
        )?
        .ok_or_else(|| Error::Internal("batch usage returned no row".into()))?;
    #[derive(Deserialize)]
    struct Qty {
        limit_key: String,
        qty: i64,
    }
    let q: Vec<Qty> = ctx.db.all(
        "SELECT p.limit_key, SUM(i.quantity) AS qty
         FROM pos_transactions t JOIN pos_transaction_items i ON i.transaction_id = t.id JOIN products p ON p.id = i.product_id
         WHERE t.batch_id = ? AND t.status = 'active' AND p.limit_key IS NOT NULL GROUP BY p.limit_key",
        [batch_id],
    )?;
    let of = |key: &str| q.iter().find(|r| r.limit_key == key).map_or(0, |r| r.qty);
    Ok(BatchUsage {
        count: t.count,
        money: t.money.unwrap_or(0),
        sugar: of("sugar"),
        oil: of("oil"),
        overage: t.overage.unwrap_or(0),
        shortfall: t.shortfall.unwrap_or(0),
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub batch: PosBatch,
    pub transaction_count: i64,
    pub money_used_piasters: i64,
    pub sugar_used: i64,
    pub oil_used: i64,
    pub overage_piasters: i64,
    pub shortfall_piasters: i64,
    pub transactions: Vec<PosTransaction>,
}

pub fn batch_summary(ctx: &Ctx, id: i64) -> Result<BatchSummary> {
    let batch = get_batch(ctx, id)?;
    let u = batch_usage(ctx, id)?;
    Ok(BatchSummary {
        batch,
        transaction_count: u.count,
        money_used_piasters: u.money,
        sugar_used: u.sugar,
        oil_used: u.oil,
        overage_piasters: u.overage,
        shortfall_piasters: u.shortfall,
        transactions: list_pos_transactions(ctx, PosFilter { batch_id: Some(id), ..Default::default() })?,
    })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PosItem {
    pub product_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    pub quantity: f64,
    pub unit_price_piasters: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_total_piasters: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PosTransaction {
    pub id: i64,
    pub batch_id: i64,
    pub batch_number: String,
    pub card_id: i64,
    pub card_number: Option<String>,
    pub secret_ref: Option<String>,
    pub holder_name: String,
    pub month: String,
    pub executed_at: String,
    pub total_piasters: i64,
    pub entitled_value_piasters: Option<i64>,
    pub difference_piasters: i64,
    pub status: String,
    pub void_reason: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub items: Vec<PosItem>,
    pub created_by: Option<String>,
}

#[derive(Debug, Default)]
pub struct PosFilter {
    pub card_id: Option<i64>,
    pub batch_id: Option<i64>,
    pub month: Option<String>,
}

pub fn list_pos_transactions(ctx: &Ctx, f: PosFilter) -> Result<Vec<PosTransaction>> {
    let mut where_parts: Vec<&str> = Vec::new();
    let mut p: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(id) = f.card_id {
        where_parts.push("t.card_id = ?");
        p.push(id.into());
    }
    if let Some(id) = f.batch_id {
        where_parts.push("t.batch_id = ?");
        p.push(id.into());
    }
    if let Some(m) = f.month.filter(|m| !m.is_empty()) {
        where_parts.push("t.month = ?");
        p.push(m.into());
    }
    let w = if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };
    let mut rows: Vec<PosTransaction> = ctx.db.all(
        &format!(
            "SELECT t.id, t.batch_id AS batchId, b.batch_number AS batchNumber, t.card_id AS cardId, c.card_number AS cardNumber,
               c.secret_ref AS secretRef, c.holder_name AS holderName, t.month, t.executed_at AS executedAt, t.total_piasters AS totalPiasters,
               t.entitled_value_piasters AS entitledValuePiasters, t.difference_piasters AS differencePiasters, t.status,
               t.void_reason AS voidReason, t.notes, u.display_name AS createdBy
             FROM pos_transactions t JOIN pos_batches b ON b.id = t.batch_id JOIN cards c ON c.id = t.card_id
             LEFT JOIN users u ON u.id = t.created_by
             {w} ORDER BY t.id DESC"
        ),
        params_from_iter(p.iter()),
    )?;
    if rows.is_empty() {
        return Ok(rows);
    }
    #[derive(Deserialize)]
    struct ItemRow {
        transaction_id: i64,
        product_id: i64,
        product_name: String,
        quantity: i64,
        unit_price_piasters: i64,
        line_total_piasters: i64,
    }
    let placeholders = vec!["?"; rows.len()].join(",");
    let ids: Vec<rusqlite::types::Value> = rows.iter().map(|r| r.id.into()).collect();
    let items: Vec<ItemRow> = ctx.db.all(
        &format!(
            "SELECT i.transaction_id, i.product_id, p.name AS product_name, i.quantity, i.unit_price_piasters, i.line_total_piasters
             FROM pos_transaction_items i JOIN products p ON p.id = i.product_id
             WHERE i.transaction_id IN ({placeholders}) ORDER BY p.sort_order, p.id"
        ),
        params_from_iter(ids.iter()),
    )?;
    for r in &mut rows {
        r.items = items
            .iter()
            .filter(|i| i.transaction_id == r.id)
            .map(|i| PosItem {
                product_id: i.product_id,
                product_name: Some(i.product_name.clone()),
                quantity: i.quantity as f64,
                unit_price_piasters: i.unit_price_piasters as f64,
                line_total_piasters: Some(i.line_total_piasters),
            })
            .collect();
    }
    Ok(rows)
}

/// Value of the card still available in the month, before this strike.
pub fn remaining_card_value(ctx: &Ctx, card_id: i64, month: &str) -> Result<Option<i64>> {
    let snap: Option<Option<i64>> =
        ctx.db.value("SELECT value_piasters FROM card_monthly_snapshots WHERE month = ? AND card_id = ?", params![month, card_id])?;
    let Some(Some(value)) = snap else { return Ok(None) };
    let used = ctx.db.int(
        "SELECT SUM(total_piasters) FROM pos_transactions WHERE card_id = ? AND month = ? AND status = 'active'",
        params![card_id, month],
    )?;
    Ok(Some(value - used))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PosInput {
    pub batch_id: i64,
    pub card_id: i64,
    pub executed_at: String,
    pub items: Vec<PosItem>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub allow_additional: bool,
}

/// Records what was struck on the POS for a card. This is not a receipt: it changes neither stock nor
/// delivered quantities. Products outside the month's entitlement rules (pasta, cheese, ...) become a right
/// for the citizen, since the card's value was spent on them. A total above the card's value is a settlement
/// difference owed to the institution, not a right for the citizen or revenue for the shop.
pub fn record_pos_transaction(ctx: &Ctx, input: PosInput) -> Result<PosTransaction> {
    let user = ctx.require_user()?;
    ctx.db.tx(|| {
        let batch = get_batch(ctx, input.batch_id)?;
        if batch.status != "open" {
            bail!("الدفعة مغلقة");
        }
        require_open_period(ctx, &batch.month)?;
        let month = batch.month.as_str();
        if !ctx.db.exists("SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?", params![month, input.card_id])? {
            bail!("البطاقة غير مدرجة في هذا الشهر (لم تكن نشطة عند فتح الشهر)");
        }
        let prior = ctx.db.int(
            "SELECT COUNT(*) FROM pos_transactions WHERE card_id = ? AND month = ? AND status = 'active'",
            params![input.card_id, month],
        )?;
        if prior > 0 && !input.allow_additional {
            bail!("هذه البطاقة مضروبة من قبل في هذا الشهر. اختر \"ضرب إضافي\" إذا كان ذلك مقصودًا");
        }

        // Repeated lines of the same product are merged, and must agree on the price.
        let mut merged: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
        let mut order: Vec<i64> = Vec::new();
        for it in &input.items {
            let quantity = positive_int(it.quantity, "الكمية")?;
            let Some(price) = as_int(it.unit_price_piasters).filter(|&p| p >= 0) else { bail!("سعر الوحدة غير صحيح") };
            if !ctx.db.exists("SELECT 1 FROM products WHERE id = ?", [it.product_id])? {
                bail!("صنف غير معروف");
            }
            match merged.get_mut(&it.product_id) {
                Some(entry) => {
                    if entry.1 != price {
                        bail!("نفس الصنف مكرر بسعرين مختلفين");
                    }
                    entry.0 += quantity;
                }
                None => {
                    merged.insert(it.product_id, (quantity, price));
                    order.push(it.product_id);
                }
            }
        }
        if merged.is_empty() {
            bail!("أدخل صنفًا واحدًا على الأقل");
        }

        let total: i64 = merged.values().map(|(q, p)| q * p).sum();
        let remaining_value = remaining_card_value(ctx, input.card_id, month)?;
        let difference = remaining_value.map_or(0, |r| total - r);

        // Batch limits
        let u = batch_usage(ctx, batch.id)?;
        let limit_qty = |key: &str| -> Result<i64> {
            let mut sum = 0;
            for (&pid, (q, _)) in &merged {
                let k: Option<Option<String>> = ctx.db.value("SELECT limit_key FROM products WHERE id = ?", [pid])?;
                if k.flatten().as_deref() == Some(key) {
                    sum += q;
                }
            }
            Ok(sum)
        };
        if u.money + total > batch.money_limit_piasters {
            bail!("تتجاوز العملية الحد المالي للدفعة (المتبقي {} جنيه)", format_money(batch.money_limit_piasters - u.money));
        }
        if u.sugar + limit_qty("sugar")? > batch.sugar_limit {
            bail!("تتجاوز العملية حد السكر للدفعة (المتبقي {})", batch.sugar_limit - u.sugar);
        }
        if u.oil + limit_qty("oil")? > batch.oil_limit {
            bail!("تتجاوز العملية حد الزيت للدفعة (المتبقي {})", batch.oil_limit - u.oil);
        }

        let id = ctx
            .db
            .run(
                "INSERT INTO pos_transactions (batch_id, card_id, month, executed_at, total_piasters, entitled_value_piasters, difference_piasters, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![batch.id, input.card_id, month, input.executed_at, total, remaining_value, difference, trimmed(&input.notes), user.id],
            )?
            .last_id;
        let rule_products: Vec<i64> = ctx
            .db
            .raw()
            .prepare("SELECT DISTINCT product_id FROM entitlement_rules WHERE month = ? AND quantity > 0")?
            .query_map([month], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for pid in order {
            let (quantity, price) = merged[&pid];
            ctx.db.run(
                "INSERT INTO pos_transaction_items (transaction_id, product_id, quantity, unit_price_piasters, line_total_piasters) VALUES (?, ?, ?, ?, ?)",
                params![id, pid, quantity, price, quantity * price],
            )?;
            if !rule_products.contains(&pid) {
                add_ledger(
                    ctx,
                    LedgerEntry {
                        card_id: input.card_id,
                        month,
                        product_id: pid,
                        kind: "pos_right",
                        quantity,
                        ref_type: Some("pos"),
                        ref_id: Some(id),
                        note: Some("مضروب على الـPOS"),
                    },
                )?;
            }
        }
        ctx.audit(
            "create",
            "pos_transaction",
            Some(id.to_string()),
            Some(&json!({ "cardId": input.card_id, "batch": batch.batch_number, "total": total, "difference": difference })),
        )?;
        list_pos_transactions(ctx, PosFilter { card_id: Some(input.card_id), ..Default::default() })?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| Error::Internal("the new POS transaction was not found".into()))
    })
}

pub fn void_pos_transaction(ctx: &Ctx, id: i64, reason: &str) -> Result<()> {
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
        let Some(t) = ctx.db.get::<Row>("SELECT status, month FROM pos_transactions WHERE id = ?", [id])? else {
            bail!("العملية غير موجودة")
        };
        if t.status != "active" {
            bail!("العملية ملغاة من قبل");
        }
        require_open_period(ctx, &t.month)?;
        ctx.db.run(
            "UPDATE pos_transactions SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = datetime('now', 'localtime') WHERE id = ?",
            params![reason, user.id, id],
        )?;
        reverse_ledger_refs(ctx, "pos", id, &format!("إلغاء ضرب: {reason}"))?;
        ctx.audit("void", "pos_transaction", Some(id.to_string()), Some(&json!({ "reason": reason })))
    })
}
