use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{as_int, Ctx};
use crate::error::{Error, Result};
use crate::ledger::{add_ledger, LedgerEntry};
use crate::products::product_id_by_limit_key;
use crate::seed::DEFAULT_CORE_RULES;
use crate::util::{add_months, is_month};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub month: String,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub card_count: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub product_id: i64,
    pub members: f64,
    pub quantity: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardValue {
    pub members: f64,
    pub value_piasters: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub product_id: i64,
    pub price_piasters: f64,
}

/// Per-month entitlement quantities and card value by members count, and product prices.
/// Numbers arrive from the UI as JS numbers, so they are validated as whole numbers on save.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodConfig {
    pub month: String,
    pub rules: Vec<Rule>,
    pub card_values: Vec<CardValue>,
    pub prices: Vec<Price>,
}

pub fn list_periods(ctx: &Ctx) -> Result<Vec<Period>> {
    ctx.db.all(
        "SELECT p.month, p.status, p.opened_at AS openedAt, p.closed_at AS closedAt,
           (SELECT COUNT(*) FROM card_monthly_snapshots s WHERE s.month = p.month) AS cardCount
         FROM periods p ORDER BY p.month DESC",
        [],
    )
}

pub fn get_period(ctx: &Ctx, month: &str) -> Result<Period> {
    list_periods(ctx)?.into_iter().find(|p| p.month == month).ok_or_else(|| Error::App(format!("شهر {month} غير موجود")))
}

pub fn period_status(ctx: &Ctx, month: &str) -> Result<Option<String>> {
    ctx.db.value("SELECT status FROM periods WHERE month = ?", [month])
}

pub fn require_open_period(ctx: &Ctx, month: &str) -> Result<()> {
    match period_status(ctx, month)?.as_deref() {
        None => bail!("شهر {month} غير مفتوح في النظام"),
        Some("open") => Ok(()),
        Some(_) => bail!("شهر {month} مغلق ولا يقبل عمليات جديدة"),
    }
}

pub fn latest_open_month(ctx: &Ctx) -> Result<Option<String>> {
    ctx.db.value("SELECT month FROM periods WHERE status = 'open' ORDER BY month DESC LIMIT 1", [])
}

pub fn get_config(ctx: &Ctx, month: &str) -> Result<PeriodConfig> {
    Ok(PeriodConfig {
        month: month.to_string(),
        rules: ctx.db.all(
            "SELECT product_id AS productId, members, quantity FROM entitlement_rules WHERE month = ? ORDER BY product_id, members",
            [month],
        )?,
        card_values: ctx
            .db
            .all("SELECT members, value_piasters AS valuePiasters FROM card_value_rules WHERE month = ? ORDER BY members", [month])?,
        prices: ctx.db.all(
            "SELECT product_id AS productId, price_piasters AS pricePiasters FROM product_prices WHERE month = ? ORDER BY product_id",
            [month],
        )?,
    })
}

/// Entitlement per product for a members count: the row for the largest members count not above it
/// (a 9-member card uses the 7-member row). Products with zero are left out.
pub fn entitlements_for(config: &PeriodConfig, members: i64) -> BTreeMap<i64, i64> {
    let mut best: BTreeMap<i64, &Rule> = BTreeMap::new();
    for r in &config.rules {
        if r.members as i64 <= members && best.get(&r.product_id).is_none_or(|b| r.members > b.members) {
            best.insert(r.product_id, r);
        }
    }
    best.into_iter().map(|(pid, r)| (pid, r.quantity as i64)).filter(|&(_, q)| q > 0).collect()
}

pub fn card_value_for(config: &PeriodConfig, members: i64) -> Option<i64> {
    config
        .card_values
        .iter()
        .filter(|v| v.members as i64 <= members)
        .max_by(|a, b| a.members.total_cmp(&b.members))
        .map(|v| v.value_piasters as i64)
}

fn write_config(ctx: &Ctx, config: &PeriodConfig) -> Result<()> {
    let m = &config.month;
    ctx.db.run("DELETE FROM entitlement_rules WHERE month = ?", [m])?;
    ctx.db.run("DELETE FROM card_value_rules WHERE month = ?", [m])?;
    ctx.db.run("DELETE FROM product_prices WHERE month = ?", [m])?;
    for r in &config.rules {
        let (Some(members), Some(quantity)) = (as_int(r.members), as_int(r.quantity)) else { bail!("قيم قواعد الاستحقاق غير صحيحة") };
        if members < 1 || quantity < 0 {
            bail!("قيم قواعد الاستحقاق غير صحيحة");
        }
        ctx.db.run(
            "INSERT INTO entitlement_rules (month, product_id, members, quantity) VALUES (?, ?, ?, ?)",
            params![m, r.product_id, members, quantity],
        )?;
    }
    for v in &config.card_values {
        let (Some(members), Some(value)) = (as_int(v.members), as_int(v.value_piasters)) else { bail!("قيم البطاقة غير صحيحة") };
        if members < 1 || value < 0 {
            bail!("قيم البطاقة غير صحيحة");
        }
        ctx.db.run("INSERT INTO card_value_rules (month, members, value_piasters) VALUES (?, ?, ?)", params![m, members, value])?;
    }
    for p in &config.prices {
        let Some(price) = as_int(p.price_piasters).filter(|&v| v >= 0) else { bail!("سعر الصنف غير صحيح") };
        ctx.db.run("INSERT INTO product_prices (month, product_id, price_piasters) VALUES (?, ?, ?)", params![m, p.product_id, price])?;
    }
    Ok(())
}

fn default_config(ctx: &Ctx, month: &str) -> Result<PeriodConfig> {
    let prev: Option<String> = ctx.db.value(
        "SELECT month FROM entitlement_rules WHERE month < ? UNION SELECT month FROM product_prices WHERE month < ? ORDER BY month DESC LIMIT 1",
        [month, month],
    )?;
    if let Some(prev) = prev {
        return Ok(PeriodConfig { month: month.to_string(), ..get_config(ctx, &prev)? });
    }
    let sugar = product_id_by_limit_key(ctx, "sugar")?;
    let oil = product_id_by_limit_key(ctx, "oil")?;
    let mut rules = Vec::new();
    for (members, s, o) in DEFAULT_CORE_RULES {
        if let Some(pid) = sugar {
            rules.push(Rule { product_id: pid, members: members as f64, quantity: s as f64 });
        }
        if let Some(pid) = oil {
            rules.push(Rule { product_id: pid, members: members as f64, quantity: o as f64 });
        }
    }
    Ok(PeriodConfig { month: month.to_string(), rules, card_values: vec![], prices: vec![] })
}

/// Freezes the card's members for the month and writes its entitlement rows. Returns false if already included.
pub fn include_card_in_month(ctx: &Ctx, card_id: i64, month: &str, config: Option<&PeriodConfig>) -> Result<bool> {
    if ctx.db.exists("SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?", params![month, card_id])? {
        return Ok(false);
    }
    let Some(members) = ctx.db.value::<i64>("SELECT members FROM cards WHERE id = ?", [card_id])? else {
        bail!("البطاقة غير موجودة")
    };
    let loaded;
    let config = match config {
        Some(c) => c,
        None => {
            loaded = get_config(ctx, month)?;
            &loaded
        }
    };
    ctx.db.run(
        "INSERT INTO card_monthly_snapshots (month, card_id, members, value_piasters) VALUES (?, ?, ?, ?)",
        params![month, card_id, members, card_value_for(config, members)],
    )?;
    for (product_id, qty) in entitlements_for(config, members) {
        add_ledger(
            ctx,
            LedgerEntry {
                card_id,
                month,
                product_id,
                kind: "entitlement",
                quantity: qty,
                ref_type: Some("period"),
                ref_id: None,
                note: Some("استحقاق الشهر"),
            },
        )?;
    }
    Ok(true)
}

pub fn open_period(ctx: &Ctx, month: &str) -> Result<Period> {
    let user = ctx.require_admin()?;
    if !is_month(month) {
        bail!("صيغة الشهر غير صحيحة");
    }
    ctx.db.tx(|| {
        if ctx.db.exists("SELECT 1 FROM periods WHERE month = ?", [month])? {
            bail!("هذا الشهر مفتوح من قبل");
        }
        let config = default_config(ctx, month)?;
        write_config(ctx, &config)?;
        ctx.db.run("INSERT INTO periods (month, status, opened_by) VALUES (?, 'open', ?)", params![month, user.id])?;
        let cards: Vec<i64> = ctx.db.raw().prepare("SELECT id FROM cards WHERE status = 'active'")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for &c in &cards {
            include_card_in_month(ctx, c, month, Some(&config))?;
        }
        ctx.audit("open", "period", Some(month.to_string()), Some(&json!({ "cards": cards.len() })))?;
        get_period(ctx, month)
    })
}

/// Replaces the month's rules, card values and prices. For an open month, existing entitlements are brought
/// in line by writing difference rows, so the history of what changed stays in the ledger.
pub fn save_period_config(ctx: &Ctx, config: PeriodConfig) -> Result<PeriodConfig> {
    ctx.require_admin()?;
    ctx.db.tx(|| {
        let month = config.month.as_str();
        require_open_period(ctx, month)?;
        let before = get_config(ctx, month)?;
        write_config(ctx, &config)?;
        #[derive(Deserialize)]
        struct Snap {
            card_id: i64,
            members: i64,
        }
        #[derive(Deserialize)]
        struct Current {
            product_id: i64,
            q: i64,
        }
        let snaps: Vec<Snap> = ctx.db.all("SELECT card_id, members FROM card_monthly_snapshots WHERE month = ?", [month])?;
        let mut adjusted = 0;
        for s in snaps {
            ctx.db.run(
                "UPDATE card_monthly_snapshots SET value_piasters = ? WHERE month = ? AND card_id = ?",
                params![card_value_for(&config, s.members), month, s.card_id],
            )?;
            let desired = entitlements_for(&config, s.members);
            let current: HashMap<i64, i64> = ctx
                .db
                .all::<Current>(
                    "SELECT product_id, SUM(quantity) AS q FROM citizen_ledger WHERE card_id = ? AND month = ? AND entry_type = 'entitlement' GROUP BY product_id",
                    params![s.card_id, month],
                )?
                .into_iter()
                .map(|r| (r.product_id, r.q))
                .collect();
            let pids: BTreeSet<i64> = desired.keys().chain(current.keys()).copied().collect();
            for pid in pids {
                let delta = desired.get(&pid).copied().unwrap_or(0) - current.get(&pid).copied().unwrap_or(0);
                if delta != 0 {
                    add_ledger(
                        ctx,
                        LedgerEntry {
                            card_id: s.card_id,
                            month,
                            product_id: pid,
                            kind: "entitlement",
                            quantity: delta,
                            ref_type: Some("rules"),
                            ref_id: None,
                            note: Some("تعديل قواعد الاستحقاق"),
                        },
                    )?;
                    adjusted += 1;
                }
            }
        }
        ctx.audit(
            "update_config",
            "period",
            Some(month.to_string()),
            Some(&json!({ "before": before, "after": config, "adjustedEntries": adjusted })),
        )?;
        get_config(ctx, month)
    })
}

/// Closes the month. Each card's remaining balance moves to next month as carry_out/carry_in rows, or expires
/// when the product does not allow carrying over. Negative balances (taken ahead) always carry.
pub fn close_period(ctx: &Ctx, month: &str) -> Result<Period> {
    let user = ctx.require_admin()?;
    ctx.db.tx(|| {
        require_open_period(ctx, month)?;
        if ctx.db.exists("SELECT 1 FROM pos_batches WHERE month = ? AND status = 'open'", [month])? {
            bail!("أغلق دفعات الضرب المفتوحة لهذا الشهر أولاً");
        }
        let next = add_months(month, 1);
        #[derive(Deserialize)]
        struct Balance {
            card_id: i64,
            product_id: i64,
            remaining: i64,
            carryover_allowed: i64,
        }
        let balances: Vec<Balance> = ctx.db.all(
            "SELECT l.card_id, l.product_id, SUM(l.quantity) AS remaining, p.carryover_allowed
             FROM citizen_ledger l JOIN products p ON p.id = l.product_id
             WHERE l.month = ? GROUP BY l.card_id, l.product_id HAVING SUM(l.quantity) <> 0",
            [month],
        )?;
        let (mut carried, mut expired) = (0, 0);
        let out_note = format!("ترحيل إلى {next}");
        let in_note = format!("مرحل من {month}");
        for b in balances {
            let entry = |m, kind, quantity, note| LedgerEntry {
                card_id: b.card_id,
                month: m,
                product_id: b.product_id,
                kind,
                quantity,
                ref_type: Some("period_close"),
                ref_id: None,
                note: Some(note),
            };
            if b.remaining > 0 && b.carryover_allowed == 0 {
                add_ledger(ctx, entry(month, "expire", -b.remaining, "انتهاء الرصيد بإغلاق الشهر"))?;
                expired += 1;
            } else {
                add_ledger(ctx, entry(month, "carry_out", -b.remaining, &out_note))?;
                add_ledger(ctx, entry(&next, "carry_in", b.remaining, &in_note))?;
                carried += 1;
            }
        }
        ctx.db.run(
            "UPDATE periods SET status = 'closed', closed_at = datetime('now', 'localtime'), closed_by = ? WHERE month = ?",
            params![user.id, month],
        )?;
        ctx.audit("close", "period", Some(month.to_string()), Some(&json!({ "carried": carried, "expired": expired })))?;
        get_period(ctx, month)
    })
}
