use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{positive_int, trimmed, Ctx, Role};

use crate::error::Result;

pub struct InventoryEntry<'a> {
    pub product_id: i64,
    /// opening | receipt | distribution | return | damage | stocktake
    pub kind: &'a str,
    pub quantity: i64,
    pub date: &'a str,
    pub document_ref: Option<&'a str>,
    pub ref_type: Option<&'a str>,
    pub ref_id: Option<i64>,
    pub note: Option<&'a str>,
}

pub fn add_inventory(ctx: &Ctx, e: InventoryEntry) -> Result<i64> {
    Ok(ctx
        .db
        .run(
            "INSERT INTO inventory_transactions (product_id, tx_type, quantity, tx_date, document_ref, ref_type, ref_id, note, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![e.product_id, e.kind, e.quantity, e.date, e.document_ref, e.ref_type, e.ref_id, e.note, ctx.user_id()],
        )?
        .last_id)
}

fn reverse_row(ctx: &Ctx, row_id: i64, note: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Row {
        product_id: i64,
        tx_type: String,
        quantity: i64,
        document_ref: Option<String>,
        reversed_by: Option<i64>,
    }
    let Some(r) = ctx.db.get::<Row>(
        "SELECT product_id, tx_type, quantity, document_ref, reversed_by FROM inventory_transactions WHERE id = ?",
        [row_id],
    )? else {
        bail!("الحركة غير موجودة")
    };
    if r.reversed_by.is_some() {
        bail!("الحركة معكوسة من قبل");
    }
    let today = ctx.db.today()?;
    let rev_id = add_inventory(
        ctx,
        InventoryEntry {
            product_id: r.product_id,
            kind: &r.tx_type,
            quantity: -r.quantity,
            date: &today,
            document_ref: r.document_ref.as_deref(),
            ref_type: Some("reversal"),
            ref_id: Some(row_id),
            note: Some(note),
        },
    )?;
    ctx.db.run("UPDATE inventory_transactions SET reversed_by = ? WHERE id = ?", params![rev_id, row_id])?;
    Ok(())
}

pub fn reverse_inventory_refs(ctx: &Ctx, ref_type: &str, ref_id: i64, note: &str) -> Result<()> {
    let ids: Vec<i64> = ctx
        .db
        .raw()
        .prepare("SELECT id FROM inventory_transactions WHERE ref_type = ? AND ref_id = ? AND reversed_by IS NULL")?
        .query_map(params![ref_type, ref_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        reverse_row(ctx, id, note)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InventoryBalance {
    pub product_id: i64,
    pub product_name: String,
    pub unit: String,
    pub opening: i64,
    pub receipts: i64,
    pub returns: i64,
    pub distributed: i64,
    pub damaged: i64,
    pub stocktake: i64,
    pub balance: i64,
}

pub fn inventory_balances(ctx: &Ctx, as_of: Option<&str>) -> Result<Vec<InventoryBalance>> {
    let as_of = as_of.filter(|s| !s.is_empty());
    let date_filter = if as_of.is_some() { "AND t.tx_date <= ?" } else { "" };
    let p: Vec<rusqlite::types::Value> = as_of.map(|d| d.to_string().into()).into_iter().collect();
    ctx.db.all(
        &format!(
            "SELECT p.id AS productId, p.name AS productName, p.unit,
               COALESCE(SUM(CASE WHEN t.tx_type = 'opening' THEN t.quantity END), 0) AS opening,
               COALESCE(SUM(CASE WHEN t.tx_type = 'receipt' THEN t.quantity END), 0) AS receipts,
               COALESCE(SUM(CASE WHEN t.tx_type = 'return' THEN t.quantity END), 0) AS returns,
               -COALESCE(SUM(CASE WHEN t.tx_type = 'distribution' THEN t.quantity END), 0) AS distributed,
               -COALESCE(SUM(CASE WHEN t.tx_type = 'damage' THEN t.quantity END), 0) AS damaged,
               COALESCE(SUM(CASE WHEN t.tx_type = 'stocktake' THEN t.quantity END), 0) AS stocktake,
               COALESCE(SUM(t.quantity), 0) AS balance
             FROM products p LEFT JOIN inventory_transactions t ON t.product_id = p.id {date_filter}
             WHERE p.active = 1 OR t.id IS NOT NULL
             GROUP BY p.id ORDER BY p.sort_order, p.id"
        ),
        params_from_iter(p.iter()),
    )
}

pub fn stock_of(ctx: &Ctx, product_id: i64) -> Result<i64> {
    ctx.db.int("SELECT SUM(quantity) FROM inventory_transactions WHERE product_id = ?", [product_id])
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InventoryMovement {
    pub id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub tx_type: String,
    pub quantity: i64,
    pub tx_date: String,
    pub document_ref: Option<String>,
    pub note: Option<String>,
    pub reversed: bool,
    pub is_reversal: bool,
    pub user_name: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MovementFilter {
    #[serde(default)]
    pub product_id: Option<i64>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub fn list_movements(ctx: &Ctx, f: MovementFilter) -> Result<Vec<InventoryMovement>> {
    #[derive(Deserialize)]
    struct Row {
        id: i64,
        product_id: i64,
        product_name: String,
        tx_type: String,
        quantity: i64,
        tx_date: String,
        document_ref: Option<String>,
        note: Option<String>,
        reversed_by: Option<i64>,
        ref_type: Option<String>,
        user_name: Option<String>,
        created_at: String,
    }
    let mut where_parts: Vec<&str> = Vec::new();
    let mut p: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(id) = f.product_id {
        where_parts.push("t.product_id = ?");
        p.push(id.into());
    }
    if let Some(k) = f.kind.filter(|k| !k.is_empty()) {
        where_parts.push("t.tx_type = ?");
        p.push(k.into());
    }
    if let Some(d) = f.from.filter(|d| !d.is_empty()) {
        where_parts.push("t.tx_date >= ?");
        p.push(d.into());
    }
    if let Some(d) = f.to.filter(|d| !d.is_empty()) {
        where_parts.push("t.tx_date <= ?");
        p.push(d.into());
    }
    p.push(f.limit.unwrap_or(500).into());
    let w = if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };
    let rows: Vec<Row> = ctx.db.all(
        &format!(
            "SELECT t.id, t.product_id, p.name AS product_name, t.tx_type, t.quantity, t.tx_date,
               t.document_ref, t.note, t.reversed_by, t.ref_type, u.display_name AS user_name, t.created_at
             FROM inventory_transactions t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.user_id
             {w} ORDER BY t.tx_date DESC, t.id DESC LIMIT ?"
        ),
        params_from_iter(p.iter()),
    )?;
    Ok(rows
        .into_iter()
        .map(|r| InventoryMovement {
            id: r.id,
            product_id: r.product_id,
            product_name: r.product_name,
            tx_type: r.tx_type,
            quantity: r.quantity,
            tx_date: r.tx_date,
            document_ref: r.document_ref,
            note: r.note,
            reversed: r.reversed_by.is_some(),
            is_reversal: r.ref_type.as_deref() == Some("reversal"),
            user_name: r.user_name,
            created_at: r.created_at,
        })
        .collect())
}

const MANUAL_TYPES: [&str; 4] = ["opening", "receipt", "return", "damage"];

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MovementInput {
    pub product_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub quantity: f64,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub document_ref: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Manual stock movement. Quantities are entered positive; damage is stored negative.
/// Repacking an opened bag without loss is not a movement at all and should not be recorded here.
pub fn record_movement(ctx: &Ctx, input: MovementInput) -> Result<i64> {
    let user = ctx.require_user()?;
    if !MANUAL_TYPES.contains(&input.kind.as_str()) {
        bail!("نوع الحركة غير مسموح من هذه الشاشة");
    }
    if input.kind == "opening" && user.role != Role::Admin {
        bail!("رصيد أول المدة يحتاج صلاحية المدير");
    }
    let quantity = positive_int(input.quantity, "الكمية")?;
    let document_ref = trimmed(&input.document_ref);
    let note = trimmed(&input.note);
    if input.kind == "receipt" && document_ref.is_none() {
        bail!("رقم مستند الوارد مطلوب");
    }
    if input.kind == "damage" && note.is_none() {
        bail!("اكتب سبب التالف");
    }
    ctx.db.tx(|| {
        if !ctx.db.exists("SELECT 1 FROM products WHERE id = ?", [input.product_id])? {
            bail!("صنف غير معروف");
        }
        let date = match trimmed(&input.date) {
            Some(d) => d,
            None => ctx.db.today()?,
        };
        let id = add_inventory(
            ctx,
            InventoryEntry {
                product_id: input.product_id,
                kind: &input.kind,
                quantity: if input.kind == "damage" { -quantity } else { quantity },
                date: &date,
                document_ref: document_ref.as_deref(),
                ref_type: Some("manual"),
                ref_id: None,
                note: note.as_deref(),
            },
        )?;
        ctx.audit("create", "inventory_tx", Some(id.to_string()), Some(&input))?;
        Ok(id)
    })
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StocktakeInput {
    pub product_id: i64,
    pub counted: f64,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct StocktakeResult {
    pub difference: i64,
}

/// Records a physical count; the difference from the book balance is stored as a stocktake movement.
pub fn record_stocktake(ctx: &Ctx, input: StocktakeInput) -> Result<StocktakeResult> {
    ctx.require_admin()?;
    let Some(counted) = crate::context::as_int(input.counted).filter(|&c| c >= 0) else { bail!("الكمية الفعلية غير صحيحة") };
    ctx.db.tx(|| {
        let book = stock_of(ctx, input.product_id)?;
        let difference = counted - book;
        let details = json!({ "productId": input.product_id, "counted": counted, "date": input.date, "note": input.note, "book": book, "difference": difference });
        if difference != 0 {
            let date = match trimmed(&input.date) {
                Some(d) => d,
                None => ctx.db.today()?,
            };
            let note = trimmed(&input.note).unwrap_or_else(|| format!("جرد: الدفتري {book} والفعلي {counted}"));
            let id = add_inventory(
                ctx,
                InventoryEntry {
                    product_id: input.product_id,
                    kind: "stocktake",
                    quantity: difference,
                    date: &date,
                    document_ref: None,
                    ref_type: Some("manual"),
                    ref_id: None,
                    note: Some(&note),
                },
            )?;
            ctx.audit("stocktake", "inventory_tx", Some(id.to_string()), Some(&details))?;
        } else {
            ctx.audit("stocktake", "product", Some(input.product_id.to_string()), Some(&details))?;
        }
        Ok(StocktakeResult { difference })
    })
}

pub fn reverse_movement(ctx: &Ctx, id: i64, reason: &str) -> Result<()> {
    ctx.require_admin()?;
    let reason = reason.trim();
    if reason.is_empty() {
        bail!("سبب العكس مطلوب");
    }
    ctx.db.tx(|| {
        let Some(ref_type) = ctx.db.value::<Option<String>>("SELECT ref_type FROM inventory_transactions WHERE id = ?", [id])? else {
            bail!("الحركة غير موجودة")
        };
        if ref_type.as_deref() != Some("manual") {
            bail!("هذه الحركة ناتجة عن عملية أخرى؛ ألغِ العملية الأصلية بدلًا منها");
        }
        reverse_row(ctx, id, &format!("عكس: {reason}"))?;
        ctx.audit("reverse", "inventory_tx", Some(id.to_string()), Some(&json!({ "reason": reason })))
    })
}

