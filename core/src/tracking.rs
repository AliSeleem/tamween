use std::collections::HashMap;

use rusqlite::{named_params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::cards::{get_card, Card};
use crate::context::Ctx;
use crate::distribution::{list_distributions, Distribution, DistributionFilter};
use crate::error::Result;
use crate::inventory::inventory_balances;
use crate::ledger::{card_rights, month_statuses, CardMonthStatus, RightsRow};
use crate::periods::{get_config, latest_open_month, period_status, Price};
use crate::pos::{batch_summary, list_batches, list_pos_transactions, remaining_card_value, PosFilter, PosTransaction};
use crate::settings::get_settings;
use crate::util::{add_months, arabic_key, format_money, ltr, month_label, normalize_digits, squash_spaces};

pub const FILTERS: [&str; 7] =
    ["all", "struck_not_received", "received_not_struck", "struck_and_received", "neither", "partial_receipt", "has_balance"];

fn matches(filter: &str, s: &CardMonthStatus) -> bool {
    let struck = s.pos_status != "none";
    let received = s.receipt_status != "none";
    match filter {
        "struck_not_received" => struck && !received,
        "received_not_struck" => received && !struck,
        "struck_and_received" => struck && received,
        "neither" => !struck && !received,
        "partial_receipt" => s.receipt_status == "partial",
        "has_balance" => s.remaining_units > 0,
        _ => true,
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackingRow {
    pub card_id: i64,
    pub card_number: Option<String>,
    pub secret_ref: Option<String>,
    pub holder_name: String,
    pub members: i64,
    pub pos_status: String,
    pub receipt_status: String,
    pub remaining_units: i64,
    pub owed_units: i64,
    pub needs_link: bool,
}

#[derive(Serialize, Debug)]
pub struct TrackingResult {
    pub rows: Vec<TrackingRow>,
    pub total: i64,
    pub counts: HashMap<String, i64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackingArgs {
    pub month: String,
    pub filter: String,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

pub fn tracking(ctx: &Ctx, args: TrackingArgs) -> Result<TrackingResult> {
    #[derive(Deserialize)]
    struct Row {
        id: i64,
        card_number: Option<String>,
        secret_ref: Option<String>,
        holder_name: String,
        members: Option<i64>,
    }
    let statuses = month_statuses(ctx, &args.month, None)?;
    let cards: Vec<Row> = ctx.db.all(
        "SELECT c.id, c.card_number, c.secret_ref, c.holder_name, s.members
         FROM cards c LEFT JOIN card_monthly_snapshots s ON s.card_id = c.id AND s.month = ?
         ORDER BY c.card_number IS NULL, c.card_number, c.holder_name",
        [&args.month],
    )?;
    let q = squash_spaces(&normalize_digits(args.query.as_deref().unwrap_or("")));
    let mut counts: HashMap<String, i64> = FILTERS.iter().map(|f| (f.to_string(), 0)).collect();
    let mut matched = Vec::new();
    for c in cards {
        let Some(s) = statuses.get(&c.id) else { continue };
        for f in FILTERS {
            if matches(f, s) {
                *counts.get_mut(f).expect("counts has every filter") += 1;
            }
        }
        if !matches(&args.filter, s) {
            continue;
        }
        if !q.is_empty() {
            let hit = c.card_number.as_deref().is_some_and(|n| n.starts_with(&q))
                || c.secret_ref.as_deref() == Some(q.as_str())
                || arabic_key(&c.holder_name).contains(&arabic_key(&q));
            if !hit {
                continue;
            }
        }
        matched.push(TrackingRow {
            card_id: c.id,
            card_number: c.card_number,
            secret_ref: c.secret_ref,
            holder_name: c.holder_name,
            members: c.members.unwrap_or(0),
            pos_status: s.pos_status.to_string(),
            receipt_status: s.receipt_status.to_string(),
            remaining_units: s.remaining_units,
            owed_units: s.owed_units,
            needs_link: s.needs_link,
        });
    }
    let total = matched.len() as i64;
    let offset = args.offset.unwrap_or(0).max(0) as usize;
    let limit = args.limit.unwrap_or(200).max(0) as usize;
    let rows = matched.into_iter().skip(offset).take(limit).collect();
    Ok(TrackingResult { rows, total, counts })
}

/// Everything the POS and receipt screens need about one card in one month.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardMonthContext {
    pub card: Card,
    pub month: String,
    pub period_open: bool,
    pub snapshot_members: Option<i64>,
    pub entitled_value_piasters: Option<i64>,
    pub rights: Vec<RightsRow>,
    pub next_month_rights: Vec<RightsRow>,
    pub pos_status: String,
    pub receipt_status: String,
    pub pos_transactions: Vec<PosTransaction>,
    pub distributions: Vec<Distribution>,
    pub prices: Vec<Price>,
}

pub fn card_month_context(ctx: &Ctx, card_id: i64, month: &str) -> Result<CardMonthContext> {
    let card = get_card(ctx, card_id)?;
    let snapshot_members: Option<i64> =
        ctx.db.value("SELECT members FROM card_monthly_snapshots WHERE month = ? AND card_id = ?", rusqlite::params![month, card_id])?;
    let status = month_statuses(ctx, month, Some(card_id))?.remove(&card_id);
    Ok(CardMonthContext {
        card,
        month: month.to_string(),
        period_open: period_status(ctx, month)?.as_deref() == Some("open"),
        entitled_value_piasters: match snapshot_members {
            Some(_) => remaining_card_value(ctx, card_id, month)?,
            None => None,
        },
        snapshot_members,
        rights: card_rights(ctx, card_id, Some(month))?,
        next_month_rights: card_rights(ctx, card_id, Some(&add_months(month, 1)))?,
        pos_status: status.as_ref().map_or("none", |s| s.pos_status).to_string(),
        receipt_status: status.as_ref().map_or("none", |s| s.receipt_status).to_string(),
        pos_transactions: list_pos_transactions(ctx, PosFilter { card_id: Some(card_id), month: Some(month.to_string()), ..Default::default() })?,
        distributions: list_distributions(ctx, DistributionFilter { card_id: Some(card_id), month: Some(month.to_string()) })?,
        prices: get_config(ctx, month)?.prices,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

fn alert(level: &str, message: String, link: Option<&str>) -> Alert {
    Alert { level: level.to_string(), message, link: link.map(String::from) }
}

/// Alerts from PRD §17: batch limits, unmatched cards, outstanding balances, stock issues.
pub fn alerts(ctx: &Ctx, month: Option<&str>) -> Result<Vec<Alert>> {
    let threshold = get_settings(ctx)?.alert_threshold_percent / 100.0;
    let Some(month) = month else {
        return Ok(vec![alert("info", "لا يوجد شهر مفتوح. افتح شهرًا من الإعدادات لبدء التشغيل.".into(), Some("/settings"))]);
    };
    let mut out = Vec::new();
    for b in list_batches(ctx, Some(month))?.into_iter().filter(|b| b.status == "open") {
        let s = batch_summary(ctx, b.id)?;
        let link = format!("/pos/{}", b.id);
        let checks = [
            ("الحد المالي", s.money_used_piasters, b.money_limit_piasters),
            ("السكر", s.sugar_used, b.sugar_limit),
            ("الزيت", s.oil_used, b.oil_limit),
        ];
        for (name, used, limit) in checks {
            if limit > 0 && used >= limit {
                out.push(alert("danger", format!("الدفعة {}: تم الوصول إلى {name}", ltr(&b.batch_number)), Some(&link)));
            } else if limit > 0 && used as f64 >= limit as f64 * threshold {
                let percent = (used as f64 / limit as f64 * 100.0).round();
                out.push(alert("warning", format!("الدفعة {}: اقتربت من {name} ({percent}٪)", ltr(&b.batch_number)), Some(&link)));
            }
        }
        if s.overage_piasters > 0 {
            out.push(alert(
                "info",
                format!("الدفعة {}: فروق زيادة متراكمة {} جنيه", ltr(&b.batch_number), format_money(s.overage_piasters)),
                Some(&link),
            ));
        }
    }
    let statuses: Vec<CardMonthStatus> = month_statuses(ctx, month, None)?.into_values().collect();
    let count = |f: &str| statuses.iter().filter(|s| matches(f, s)).count();
    let received_not_struck = count("received_not_struck");
    let struck_not_received = count("struck_not_received");
    let with_balance = count("has_balance");
    let owing = statuses.iter().filter(|s| s.owed_units > 0 && !s.needs_link).count();
    if received_not_struck > 0 {
        out.push(alert("warning", format!("{received_not_struck} بطاقة استلمت ولم تُضرب"), Some("/tracking?filter=received_not_struck")));
    }
    if struck_not_received > 0 {
        out.push(alert("warning", format!("{struck_not_received} بطاقة ضُربت ولم تستلم"), Some("/tracking?filter=struck_not_received")));
    }
    if with_balance > 0 {
        out.push(alert("info", format!("{with_balance} بطاقة لها رصيد متبقٍ في {}", month_label(month)), Some("/tracking?filter=has_balance")));
    }
    if owing > 0 {
        out.push(alert("info", format!("{owing} بطاقة استلمت أكثر من رصيدها (مقدم أو صرف قبل الضرب)"), Some("/tracking")));
    }
    for b in inventory_balances(ctx, None)? {
        if b.balance < 0 {
            out.push(alert("danger", format!("رصيد {} بالسالب ({}). راجع الوارد والصرف", b.product_name, b.balance), Some("/inventory")));
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoreRow {
    pub product_id: i64,
    pub product_name: String,
    pub unit: String,
    pub entitled: i64,
    pub delivered: i64,
    pub struck: i64,
    #[serde(default)]
    pub stock: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub month: Option<String>,
    pub card_count: i64,
    pub active_card_count: i64,
    pub members_total: i64,
    pub struck_count: i64,
    pub received_count: i64,
    pub full_cycle_count: i64,
    pub pos_total_piasters: i64,
    pub overage_piasters: i64,
    pub core: Vec<CoreRow>,
    pub alerts: Vec<Alert>,
}

/// Answers the PRD §25 questions for one month.
pub fn dashboard(ctx: &Ctx, month_arg: Option<&str>) -> Result<DashboardSummary> {
    let month = match month_arg.filter(|m| !m.is_empty()) {
        Some(m) => Some(m.to_string()),
        None => latest_open_month(ctx)?,
    };
    let mut out = DashboardSummary {
        month: month.clone(),
        card_count: ctx.db.int("SELECT COUNT(*) FROM cards", [])?,
        active_card_count: ctx.db.int("SELECT COUNT(*) FROM cards WHERE status = 'active'", [])?,
        members_total: 0,
        struck_count: 0,
        received_count: 0,
        full_cycle_count: 0,
        pos_total_piasters: 0,
        overage_piasters: 0,
        core: vec![],
        alerts: alerts(ctx, month.as_deref())?,
    };
    let Some(month) = month else { return Ok(out) };
    out.members_total = ctx.db.int("SELECT SUM(members) FROM card_monthly_snapshots WHERE month = ?", [&month])?;
    let statuses: Vec<CardMonthStatus> = month_statuses(ctx, &month, None)?.into_values().collect();
    out.struck_count = statuses.iter().filter(|s| s.pos_status != "none").count() as i64;
    out.received_count = statuses.iter().filter(|s| s.receipt_status != "none").count() as i64;
    out.full_cycle_count = statuses.iter().filter(|s| s.pos_status == "struck" && s.receipt_status == "full").count() as i64;
    out.pos_total_piasters = ctx.db.int("SELECT SUM(total_piasters) FROM pos_transactions WHERE month = ? AND status = 'active'", [&month])?;
    out.overage_piasters = ctx.db.int(
        "SELECT SUM(CASE WHEN difference_piasters > 0 THEN difference_piasters ELSE 0 END)
         FROM pos_transactions WHERE month = ? AND status = 'active'",
        [&month],
    )?;
    let stock: HashMap<i64, i64> = inventory_balances(ctx, None)?.into_iter().map(|b| (b.product_id, b.balance)).collect();
    out.core = ctx
        .db
        .all::<CoreRow>(
            "SELECT p.id AS productId, p.name AS productName, p.unit,
               COALESCE((SELECT SUM(quantity) FROM citizen_ledger WHERE month = :m AND product_id = p.id AND entry_type IN ('entitlement', 'carry_in', 'pos_right')), 0) AS entitled,
               COALESCE((SELECT -SUM(quantity) FROM citizen_ledger WHERE month = :m AND product_id = p.id AND entry_type = 'delivery'), 0) AS delivered,
               COALESCE((SELECT SUM(i.quantity) FROM pos_transaction_items i JOIN pos_transactions t ON t.id = i.transaction_id
                         WHERE t.month = :m AND t.status = 'active' AND i.product_id = p.id), 0) AS struck
             FROM products p WHERE p.active = 1 ORDER BY p.sort_order, p.id",
            named_params! { ":m": month },
        )?
        .into_iter()
        .map(|mut r| {
            r.stock = stock.get(&r.product_id).copied().unwrap_or(0);
            r
        })
        .collect();
    Ok(out)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub user_name: Option<String>,
    pub action: String,
    pub entity: String,
    pub entity_id: Option<String>,
    pub details: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilter {
    #[serde(default)]
    pub entity: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

pub fn list_audit(ctx: &Ctx, f: AuditFilter) -> Result<Vec<AuditEntry>> {
    ctx.require_admin()?;
    let entity = f.entity.filter(|e| !e.is_empty());
    let mut p: Vec<rusqlite::types::Value> = Vec::new();
    let w = match &entity {
        Some(e) => {
            p.push(e.clone().into());
            "WHERE a.entity = ?"
        }
        None => "",
    };
    p.push(f.limit.unwrap_or(200).into());
    p.push(f.offset.unwrap_or(0).into());
    ctx.db.all(
        &format!(
            "SELECT a.id, a.at, u.display_name AS userName, a.action, a.entity, a.entity_id AS entityId, a.details
             FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
             {w} ORDER BY a.id DESC LIMIT ? OFFSET ?"
        ),
        params_from_iter(p.iter()),
    )
}
