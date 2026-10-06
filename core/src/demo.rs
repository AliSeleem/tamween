use std::collections::HashMap;

use serde::Serialize;
use serde_json::json;

use crate::bail;
use crate::cards::{create_card, CardInput};
use crate::context::Ctx;
use crate::distribution::{record_distribution, DistributionInput, DistributionItem};
use crate::error::Result;
use crate::inventory::{record_movement, MovementInput};
use crate::periods::{get_config, open_period, save_period_config, CardValue, Price};
use crate::pos::{create_batch, record_pos_transaction, BatchInput, PosInput, PosItem};
use crate::products::list_products;
use crate::util::add_months;

const NAMES: [&str; 12] = [
    "محمد أحمد علي",
    "فاطمة محمود حسن",
    "أحمد سيد إبراهيم",
    "سعاد عبد الله",
    "محمود عبد الرحمن",
    "نادية فتحي",
    "خالد مصطفى",
    "هدى السيد",
    "عبد الله رمضان",
    "منى عادل",
    "حسن شعبان",
    "زينب كمال",
];
const MEMBERS: [i64; 12] = [2, 2, 4, 5, 3, 1, 6, 4, 3, 2, 7, 4];
const PRICES: [(&str, i64); 6] = [("سكر", 1250), ("زيت", 3000), ("مكرونة", 800), ("جبنة", 1500), ("بسكويت", 250), ("طحينة", 2000)];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DemoResult {
    pub month: String,
    pub cards: i64,
}

/// Fills an empty database with a sample month so the screens can be tried out: cards, prices, opening stock,
/// a POS batch with strikes (some above the card value), and receipts covering every tracking case.
pub fn load_demo_data(ctx: &Ctx) -> Result<DemoResult> {
    ctx.require_admin()?;
    if ctx.db.exists("SELECT 1 FROM cards LIMIT 1", [])? || ctx.db.exists("SELECT 1 FROM periods LIMIT 1", [])? {
        bail!("البيانات التجريبية تُحمّل على قاعدة بيانات فارغة فقط");
    }
    let month = ctx.db.current_month()?;
    let today = ctx.db.today()?;
    ctx.db.tx(|| {
        let mut card_ids = Vec::new();
        for (i, name) in NAMES.iter().enumerate() {
            let card = create_card(
                ctx,
                &CardInput {
                    card_number: Some((1_200_345_600 + i as i64).to_string()),
                    holder_name: name.to_string(),
                    secret_ref: Some((4000 + i as i64).to_string()),
                    bakery: Some(if i % 2 == 1 { "مخبز الأمل" } else { "مخبز النور" }.to_string()),
                    members: MEMBERS[i] as f64,
                    status: "active".into(),
                    group_name: None,
                },
                "demo",
            )?;
            card_ids.push(card.id);
        }
        open_period(ctx, &month)?;
        let pid: HashMap<String, i64> = list_products(ctx)?.into_iter().map(|p| (p.name, p.id)).collect();
        let price: HashMap<&str, i64> = PRICES.into_iter().collect();
        save_period_config(
            ctx,
            crate::periods::PeriodConfig {
                card_values: (1..=7).map(|m| CardValue { members: m as f64, value_piasters: (4925 * m) as f64 }).collect(),
                prices: PRICES
                    .iter()
                    .filter_map(|(n, p)| pid.get(*n).map(|&id| Price { product_id: id, price_piasters: *p as f64 }))
                    .collect(),
                ..get_config(ctx, &month)?
            },
        )?;
        let product = |name: &str| -> Result<i64> {
            pid.get(name).copied().ok_or_else(|| crate::error::Error::Internal(format!("demo product {name} is missing")))
        };
        let day_one = format!("{month}-01");
        for (n, q) in [("سكر", 300), ("زيت", 250), ("مكرونة", 100), ("جبنة", 60), ("بسكويت", 200), ("طحينة", 40)] {
            record_movement(
                ctx,
                MovementInput {
                    product_id: product(n)?,
                    kind: "opening".into(),
                    quantity: q as f64,
                    date: Some(day_one.clone()),
                    document_ref: None,
                    note: Some("بيانات تجريبية".into()),
                },
            )?;
        }
        record_movement(
            ctx,
            MovementInput {
                product_id: product("سكر")?,
                kind: "receipt".into(),
                quantity: 500.0,
                date: Some(today.clone()),
                document_ref: Some("ف-تجريبي/1".into()),
                note: None,
            },
        )?;
        record_movement(
            ctx,
            MovementInput {
                product_id: product("زيت")?,
                kind: "damage".into(),
                quantity: 2.0,
                date: Some(today.clone()),
                document_ref: None,
                note: Some("زجاجتان مكسورتان".into()),
            },
        )?;

        let batch = create_batch(
            ctx,
            BatchInput {
                month: month.clone(),
                batch_number: None,
                institution: Some("الشركة المصرية لتجارة الجملة".into()),
                money_limit_piasters: None,
                sugar_limit: None,
                oil_limit: None,
                notes: Some("دفعة تجريبية".into()),
            },
        )?;
        let strike = |i: usize, extra: &[(&str, i64)]| -> Result<()> {
            let m = MEMBERS[i];
            let mut items = vec![
                PosItem {
                    product_id: product("سكر")?,
                    product_name: None,
                    quantity: m.min(6) as f64,
                    unit_price_piasters: price["سكر"] as f64,
                    line_total_piasters: None,
                },
                PosItem {
                    product_id: product("زيت")?,
                    product_name: None,
                    quantity: m.min(4) as f64,
                    unit_price_piasters: price["زيت"] as f64,
                    line_total_piasters: None,
                },
            ];
            for &(n, q) in extra {
                items.push(PosItem {
                    product_id: product(n)?,
                    product_name: None,
                    quantity: q as f64,
                    unit_price_piasters: price[n] as f64,
                    line_total_piasters: None,
                });
            }
            record_pos_transaction(
                ctx,
                PosInput { batch_id: batch.id, card_id: card_ids[i], executed_at: today.clone(), items, notes: None, allow_additional: false },
            )?;
            Ok(())
        };
        let receive = |i: usize, items: &[(&str, i64)], applies_to: &str| -> Result<()> {
            record_distribution(
                ctx,
                DistributionInput {
                    card_id: card_ids[i],
                    month: month.clone(),
                    distributed_at: Some(today.clone()),
                    items: items
                        .iter()
                        .map(|&(n, q)| {
                            Ok(DistributionItem {
                                product_id: product(n)?,
                                product_name: None,
                                quantity: q as f64,
                                applies_to_month: applies_to.to_string(),
                            })
                        })
                        .collect::<Result<_>>()?,
                    notes: None,
                },
            )?;
            Ok(())
        };
        let next = add_months(&month, 1);
        // Struck and fully received
        strike(0, &[("مكرونة", 2), ("بسكويت", 1)])?;
        receive(0, &[("سكر", 2), ("زيت", 2), ("مكرونة", 2), ("بسكويت", 1)], &month)?;
        // Struck, not received
        strike(1, &[("جبنة", 1)])?;
        strike(7, &[("مكرونة", 3)])?;
        // Struck, partially received
        strike(2, &[("مكرونة", 3)])?;
        receive(2, &[("سكر", 2), ("زيت", 4)], &month)?;
        strike(3, &[])?;
        receive(3, &[("سكر", 5), ("زيت", 4)], &month)?;
        // Received before the strike (needs linking)
        receive(4, &[("سكر", 3), ("زيت", 3)], &month)?;
        receive(9, &[("سكر", 1)], &month)?;
        // Advance against next month
        receive(5, &[("سكر", 1), ("زيت", 1)], &month)?;
        receive(5, &[("زيت", 1)], &next)?;
        // Cards 6, 8, 10, 11: neither struck nor received
        ctx.audit("load_demo", "database", None, Some(&json!({ "month": month, "cards": card_ids.len() })))?;
        Ok(DemoResult { month: month.clone(), cards: card_ids.len() as i64 })
    })
}
