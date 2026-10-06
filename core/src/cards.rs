use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{as_int, trimmed, Ctx, Role};
use crate::distribution::{list_distributions, Distribution, DistributionFilter};
use crate::error::{Error, Result};
use crate::ledger::{card_rights, RightsRow};
use crate::periods::{include_card_in_month, latest_open_month};
use crate::pos::{list_pos_transactions, PosFilter, PosTransaction};
use crate::util::{arabic_key, normalize_digits, squash_spaces};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: i64,
    /// official card number; optional because shop registers often key citizens by name and secret number
    pub card_number: Option<String>,
    pub holder_name: String,
    pub secret_ref: Option<String>,
    pub bakery: Option<String>,
    pub members: i64,
    pub status: String,
    pub group_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardInput {
    #[serde(default)]
    pub card_number: Option<String>,
    pub holder_name: String,
    #[serde(default)]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub bakery: Option<String>,
    pub members: f64,
    pub status: String,
    #[serde(default)]
    pub group_name: Option<String>,
}

/// A validated card input: members is a whole number and at least one identifier is present.
struct Clean {
    card_number: Option<String>,
    holder_name: String,
    secret_ref: Option<String>,
    bakery: Option<String>,
    members: i64,
    status: String,
    group_name: Option<String>,
}

const SELECT: &str = "SELECT id, card_number AS cardNumber, holder_name AS holderName, secret_ref AS secretRef, bakery, members, status,
   group_name AS groupName, created_at AS createdAt, updated_at AS updatedAt FROM cards";

pub fn get_card(ctx: &Ctx, id: i64) -> Result<Card> {
    ctx.db.get(&format!("{SELECT} WHERE id = ?"), [id])?.ok_or_else(|| Error::App("البطاقة غير موجودة".into()))
}

pub fn find_card_by_number(ctx: &Ctx, card_number: &str) -> Result<Option<Card>> {
    ctx.db.get(&format!("{SELECT} WHERE card_number = ?"), [normalize_digits(card_number).trim()])
}

/// For registers without card numbers: the same secret number and the same name (spelling variants folded).
pub fn find_card_by_secret_and_name(ctx: &Ctx, secret_ref: &str, holder_name: &str) -> Result<Option<Card>> {
    let key = arabic_key(holder_name);
    let rows: Vec<Card> = ctx.db.all(&format!("{SELECT} WHERE secret_ref = ?"), [normalize_digits(secret_ref).trim()])?;
    Ok(rows.into_iter().find(|c| arabic_key(&c.holder_name) == key))
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CardSearch {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct CardPage {
    pub rows: Vec<Card>,
    pub total: i64,
}

/// Search by card number (prefix), secret number (exact) or holder name (contains). Exact matches come first.
pub fn search_cards(ctx: &Ctx, args: CardSearch) -> Result<CardPage> {
    let q = squash_spaces(&normalize_digits(args.query.as_deref().unwrap_or("")));
    let status = args.status.filter(|s| !s.is_empty() && s != "all");
    let mut where_parts: Vec<&str> = Vec::new();
    let mut filter_params: Vec<rusqlite::types::Value> = Vec::new();
    if !q.is_empty() {
        where_parts.push("(card_number LIKE ? OR arkey(holder_name) LIKE ? OR secret_ref = ?)");
        filter_params.push(format!("{q}%").into());
        filter_params.push(format!("%{}%", arabic_key(&q)).into());
        filter_params.push(q.clone().into());
    }
    if let Some(s) = &status {
        where_parts.push("status = ?");
        filter_params.push(s.clone().into());
    }
    let w = if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };
    let total = ctx.db.int(&format!("SELECT COUNT(*) AS n FROM cards {w}"), params_from_iter(filter_params.iter()))?;
    let order = if q.is_empty() {
        "card_number IS NULL, card_number, holder_name".to_string()
    } else {
        "CASE WHEN card_number = ? OR secret_ref = ? THEN 0 ELSE 1 END, holder_name".to_string()
    };
    let mut row_params = filter_params;
    if !q.is_empty() {
        row_params.push(q.clone().into());
        row_params.push(q.into());
    }
    row_params.push(args.limit.unwrap_or(50).into());
    row_params.push(args.offset.unwrap_or(0).into());
    let rows = ctx.db.all(&format!("{SELECT} {w} ORDER BY {order} LIMIT ? OFFSET ?"), params_from_iter(row_params.iter()))?;
    Ok(CardPage { rows, total })
}

fn validate(input: &CardInput) -> Result<Clean> {
    let card_number = trimmed(&input.card_number.as_deref().map(normalize_digits));
    let holder_name = squash_spaces(&input.holder_name);
    let secret_ref = trimmed(&input.secret_ref.as_deref().map(normalize_digits));
    if card_number.is_none() && secret_ref.is_none() {
        bail!("أدخل رقم البطاقة أو الرقم السري");
    }
    if holder_name.is_empty() {
        bail!("اسم صاحب البطاقة مطلوب");
    }
    let Some(members) = as_int(input.members).filter(|&m| (1..=30).contains(&m)) else { bail!("عدد الأفراد غير صحيح") };
    if !["active", "suspended", "cancelled"].contains(&input.status.as_str()) {
        bail!("حالة البطاقة غير صحيحة");
    }
    Ok(Clean {
        card_number,
        holder_name,
        secret_ref,
        bakery: trimmed(&input.bakery.as_deref().map(normalize_digits)),
        members,
        status: input.status.clone(),
        group_name: trimmed(&input.group_name.as_deref().map(normalize_digits)),
    })
}

impl Clean {
    fn as_json(&self, source: &str) -> serde_json::Value {
        json!({
            "cardNumber": self.card_number, "holderName": self.holder_name, "secretRef": self.secret_ref,
            "bakery": self.bakery, "members": self.members, "status": self.status, "groupName": self.group_name,
            "source": source,
        })
    }
}

pub fn create_card(ctx: &Ctx, input: &CardInput, source: &str) -> Result<Card> {
    ctx.require_user()?;
    let c = validate(input)?;
    ctx.db.tx(|| {
        if let Some(n) = &c.card_number {
            if find_card_by_number(ctx, n)?.is_some() {
                bail!("رقم البطاقة {n} مسجل من قبل");
            }
        } else if let Some(s) = &c.secret_ref {
            if find_card_by_secret_and_name(ctx, s, &c.holder_name)?.is_some() {
                bail!("يوجد بطاقة بنفس الاسم والرقم السري {s}");
            }
        }
        let id = ctx
            .db
            .run(
                "INSERT INTO cards (card_number, holder_name, secret_ref, bakery, members, status, group_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![c.card_number, c.holder_name, c.secret_ref, c.bakery, c.members, c.status, c.group_name],
            )?
            .last_id;
        // A card added while a month is running joins that month with its current members.
        if c.status == "active" {
            if let Some(open) = latest_open_month(ctx)? {
                include_card_in_month(ctx, id, &open, None)?;
            }
        }
        ctx.audit("create", "card", Some(id.to_string()), Some(&c.as_json(source)))?;
        get_card(ctx, id)
    })
}

/// Updates a card and records each changed field in card_history. A members change does not touch
/// months already opened: their snapshot keeps the count from the start of the month.
pub fn update_card(ctx: &Ctx, id: i64, input: &CardInput, reason: Option<&str>) -> Result<Card> {
    let user = ctx.require_user()?;
    let c = validate(input)?;
    ctx.db.tx(|| {
        let before = get_card(ctx, id)?;
        if c.card_number != before.card_number {
            if user.role != Role::Admin {
                bail!("تغيير رقم البطاقة يحتاج صلاحية المدير");
            }
            if let Some(n) = &c.card_number {
                if find_card_by_number(ctx, n)?.is_some() {
                    bail!("رقم البطاقة {n} مسجل من قبل");
                }
            }
        }
        let members = c.members.to_string();
        let fields: [(&str, &str, Option<&str>, Option<&str>); 7] = [
            ("cardNumber", "card_number", before.card_number.as_deref(), c.card_number.as_deref()),
            ("holderName", "holder_name", Some(&before.holder_name), Some(&c.holder_name)),
            ("secretRef", "secret_ref", before.secret_ref.as_deref(), c.secret_ref.as_deref()),
            ("bakery", "bakery", before.bakery.as_deref(), c.bakery.as_deref()),
            ("members", "members", Some(&before.members.to_string()), Some(&members)),
            ("status", "status", Some(&before.status), Some(&c.status)),
            ("groupName", "group_name", before.group_name.as_deref(), c.group_name.as_deref()),
        ];
        let changes: Vec<_> = fields.iter().filter(|(_, _, old, new)| old != new).collect();
        if changes.is_empty() {
            return Ok(before);
        }
        let sets = changes.iter().map(|(_, col, _, _)| format!("{col} = ?")).collect::<Vec<_>>().join(", ");
        let mut values: Vec<rusqlite::types::Value> = changes.iter().map(|(_, _, _, new)| new.map(String::from).into()).collect();
        values.push(id.into());
        ctx.db.run(
            &format!("UPDATE cards SET {sets}, updated_at = datetime('now', 'localtime') WHERE id = ?"),
            params_from_iter(values.iter()),
        )?;
        for (field, _, old, new) in &changes {
            ctx.db.run(
                "INSERT INTO card_history (card_id, field, old_value, new_value, reason, user_id) VALUES (?, ?, ?, ?, ?, ?)",
                params![id, field, old, new, reason, user.id],
            )?;
        }
        let logged: Vec<_> = changes.iter().map(|(field, _, old, new)| json!({ "field": field, "old": old, "new": new })).collect();
        ctx.audit("update", "card", Some(id.to_string()), Some(&json!({ "changes": logged, "reason": reason })))?;
        get_card(ctx, id)
    })
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardHistoryEntry {
    pub id: i64,
    pub field: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub reason: Option<String>,
    pub user_name: Option<String>,
    pub changed_at: String,
}

pub fn card_history(ctx: &Ctx, id: i64) -> Result<Vec<CardHistoryEntry>> {
    ctx.db.all(
        "SELECT h.id, h.field, h.old_value AS oldValue, h.new_value AS newValue, h.reason, u.display_name AS userName, h.changed_at AS changedAt
         FROM card_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.card_id = ? ORDER BY h.id DESC",
        [id],
    )
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub month: String,
    pub members: i64,
    pub value_piasters: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub id: i64,
    pub month: String,
    pub product_name: String,
    pub entry_type: String,
    pub quantity: i64,
    pub note: Option<String>,
    pub user_name: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardStatement {
    pub card: Card,
    pub snapshots: Vec<Snapshot>,
    pub rights: Vec<RightsRow>,
    pub ledger: Vec<LedgerRow>,
    pub pos_transactions: Vec<PosTransaction>,
    pub distributions: Vec<Distribution>,
    pub history: Vec<CardHistoryEntry>,
}

pub fn card_statement(ctx: &Ctx, id: i64) -> Result<CardStatement> {
    Ok(CardStatement {
        card: get_card(ctx, id)?,
        snapshots: ctx.db.all(
            "SELECT month, members, value_piasters AS valuePiasters FROM card_monthly_snapshots WHERE card_id = ? ORDER BY month DESC",
            [id],
        )?,
        rights: card_rights(ctx, id, None)?,
        ledger: ctx.db.all(
            "SELECT l.id, l.month, p.name AS productName, l.entry_type AS entryType, l.quantity, l.note,
               u.display_name AS userName, l.created_at AS createdAt
             FROM citizen_ledger l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.user_id
             WHERE l.card_id = ? ORDER BY l.id DESC",
            [id],
        )?,
        pos_transactions: list_pos_transactions(ctx, PosFilter { card_id: Some(id), ..Default::default() })?,
        distributions: list_distributions(ctx, DistributionFilter { card_id: Some(id), month: None })?,
        history: card_history(ctx, id)?,
    })
}

pub fn include_card(ctx: &Ctx, card_id: i64, month: &str) -> Result<()> {
    ctx.require_admin()?;
    ctx.db.tx(|| {
        if crate::periods::period_status(ctx, month)?.as_deref() != Some("open") {
            bail!("الشهر غير مفتوح");
        }
        if !include_card_in_month(ctx, card_id, month, None)? {
            bail!("البطاقة مدرجة في هذا الشهر بالفعل");
        }
        ctx.audit("include_in_month", "card", Some(card_id.to_string()), Some(&json!({ "month": month })))
    })
}
