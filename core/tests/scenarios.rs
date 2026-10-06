//! The PRD §22 scenarios and the rules around them, ported from the Electron version's vitest suite.

mod common;

use common::{dist_item, id, pos_item, setup, Env};
use serde_json::{json, Value};

fn strike(env: &Env, batch: i64, card: i64, date: &str, items: Vec<Value>) -> Value {
    env.ok("pos.record", json!({ "batchId": batch, "cardId": card, "executedAt": date, "items": items }))
}

fn receive(env: &Env, card: i64, month: &str, items: Vec<Value>) -> Value {
    env.ok("distribution.record", json!({ "cardId": card, "month": month, "items": items }))
}

mod monthly_entitlement {
    use super::*;

    #[test]
    fn uses_the_prd_table_and_the_members_frozen_at_the_start_of_the_month() {
        let env = setup();
        let card = env.add_card("1001", 4);
        let card_id = id(&card);
        env.open_month("2026-09");
        assert_eq!(env.rights(card_id, "2026-09", env.sugar).entitled, 4);
        assert_eq!(env.rights(card_id, "2026-09", env.oil).entitled, 4);

        // Members change during September does not change September.
        let mut changed = card.clone();
        changed["members"] = json!(5);
        let _: Value = env.ok("cards.update", json!({ "id": card_id, "card": changed, "reason": "مولود جديد" }));
        assert_eq!(env.rights(card_id, "2026-09", env.sugar).entitled, 4);
        assert_eq!(env.month_context(card_id, "2026-09")["snapshotMembers"], json!(4));

        // October uses 5 members: 5 sugar + 4 oil.
        let _: Value = env.ok("periods.close", json!({ "month": "2026-09" }));
        env.open_month("2026-10");
        assert_eq!(env.rights(card_id, "2026-10", env.sugar).entitled, 5);
        assert_eq!(env.rights(card_id, "2026-10", env.oil).entitled, 4);
        let statement: Value = env.ok("cards.statement", json!({ "id": card_id }));
        let latest = &statement["history"][0];
        assert_eq!(latest["field"], "members");
        assert_eq!(latest["oldValue"], "4");
        assert_eq!(latest["newValue"], "5");
    }

    #[test]
    fn caps_at_the_highest_defined_row_for_large_families() {
        let env = setup();
        let card = id(&env.add_card("1002", 9));
        env.open_month("2026-09");
        assert_eq!(env.rights(card, "2026-09", env.sugar).entitled, 6);
        assert_eq!(env.rights(card, "2026-09", env.oil).entitled, 4);
    }

    #[test]
    fn rule_edits_on_an_open_month_adjust_entitlements_through_ledger_rows() {
        let env = setup();
        let card = id(&env.add_card("1003", 2));
        env.open_month("2026-09");
        let mut cfg: Value = env.ok("periods.config", json!({ "month": "2026-09" }));
        for rule in cfg["rules"].as_array_mut().expect("rules") {
            if rule["productId"].as_i64() == Some(env.sugar) && rule["members"].as_f64() == Some(2.0) {
                rule["quantity"] = json!(3);
            }
        }
        let _: Value = env.ok("periods.saveConfig", cfg);
        assert_eq!(env.rights(card, "2026-09", env.sugar).entitled, 3);
        let statement: Value = env.ok("cards.statement", json!({ "id": card }));
        let mut quantities: Vec<i64> = statement["ledger"]
            .as_array()
            .expect("ledger")
            .iter()
            .filter(|l| l["entryType"] == "entitlement" && l["productName"] == "سكر")
            .map(|l| l["quantity"].as_i64().unwrap_or(0))
            .collect();
        quantities.sort();
        assert_eq!(quantities, vec![1, 2]);
    }
}

mod prd_22_scenarios {
    use super::*;

    struct Prepared {
        env: Env,
        card: i64,
        batch: i64,
    }

    fn prepared() -> Prepared {
        let env = setup();
        let card = id(&env.add_card("2001", 2));
        env.open_month("2026-10");
        let batch: Value = env.ok("pos.createBatch", json!({ "month": "2026-10" }));
        for product in [env.sugar, env.oil, env.pasta] {
            let _: i64 = env.ok("inventory.record", json!({ "productId": product, "type": "opening", "quantity": 100 }));
        }
        Prepared { card, batch: id(&batch), env }
    }

    #[test]
    fn scenario_1_strike_then_receive_completes_the_cycle_and_moves_stock() {
        let Prepared { env, card, batch } = prepared();
        strike(
            &env,
            batch,
            card,
            "2026-10-05",
            vec![pos_item(env.sugar, 2, 900), pos_item(env.oil, 2, 3000), pos_item(env.pasta, 2, 1000)],
        );
        let ctx = env.month_context(card, "2026-10");
        assert_eq!(ctx["posStatus"], "struck");
        assert_eq!(ctx["receiptStatus"], "none");
        assert_eq!(env.rights(card, "2026-10", env.pasta).remaining, 2); // pasta right comes from the strike

        receive(
            &env,
            card,
            "2026-10",
            vec![dist_item(env.sugar, 2, "2026-10"), dist_item(env.oil, 2, "2026-10"), dist_item(env.pasta, 2, "2026-10")],
        );
        let ctx = env.month_context(card, "2026-10");
        assert_eq!(ctx["receiptStatus"], "full");
        assert!(ctx["rights"].as_array().expect("rights").iter().all(|r| r["remaining"] == 0));
        assert_eq!(env.stock(env.sugar), 98);
        assert_eq!(env.stock(env.pasta), 98);
    }

    #[test]
    fn scenario_2_receive_before_strike_shows_received_not_struck_then_links() {
        let Prepared { env, card, batch } = prepared();
        let _: Value = env.ok(
            "distribution.record",
            json!({ "cardId": card, "month": "2026-10", "distributedAt": "2026-10-11",
                    "items": [dist_item(env.sugar, 2, "2026-10"), dist_item(env.oil, 2, "2026-10")] }),
        );
        let t: Value = env.ok("tracking.list", json!({ "month": "2026-10", "filter": "received_not_struck" }));
        assert_eq!(t["rows"].as_array().expect("rows").len(), 1);
        assert_eq!(t["rows"][0]["cardId"], json!(card));
        assert_eq!(t["rows"][0]["needsLink"], json!(true));
        assert_eq!(t["rows"][0]["posStatus"], "none");

        strike(&env, batch, card, "2026-10-15", vec![pos_item(env.sugar, 2, 900), pos_item(env.oil, 2, 3000)]);
        let t: Value = env.ok("tracking.list", json!({ "month": "2026-10", "filter": "struck_and_received" }));
        let row = &t["rows"][0];
        assert_eq!(row["cardId"], json!(card));
        assert_eq!(row["posStatus"], "struck");
        assert_eq!(row["receiptStatus"], "full");
        assert_eq!(row["needsLink"], json!(false));
    }

    #[test]
    fn scenario_3_strike_without_receipt_keeps_the_right_visible() {
        let Prepared { env, card, batch } = prepared();
        strike(&env, batch, card, "2026-10-05", vec![pos_item(env.sugar, 2, 900), pos_item(env.oil, 2, 3000)]);
        let t: Value = env.ok("tracking.list", json!({ "month": "2026-10", "filter": "struck_not_received" }));
        assert_eq!(t["rows"][0]["cardId"], json!(card));
        assert_eq!(t["rows"][0]["remainingUnits"], json!(4));
        assert_eq!(t["counts"]["has_balance"], json!(1));
    }

    #[test]
    fn scenario_4_partial_receipt_leaves_a_balance_and_blocks_over_delivery() {
        let Prepared { env, card, .. } = prepared();
        receive(&env, card, "2026-10", vec![dist_item(env.sugar, 1, "2026-10")]);
        assert_eq!(env.month_context(card, "2026-10")["receiptStatus"], "partial");
        assert_eq!(env.rights(card, "2026-10", env.sugar).remaining, 1);
        let message = env.err(
            "distribution.record",
            json!({ "cardId": card, "month": "2026-10", "items": [dist_item(env.sugar, 2, "2026-10")] }),
        );
        assert!(message.contains("أكبر من المتبقي"), "{message}");
    }

    #[test]
    fn scenario_5_strike_above_card_value_is_a_settlement_difference_summed_per_batch() {
        let Prepared { env, card, batch } = prepared();
        // Card value for 2 members is 98.50. Strike 100.50: 2 sugar (18) + 2 oil (60) + 2 cheese (22.50).
        let items = vec![pos_item(env.sugar, 2, 900), pos_item(env.oil, 2, 3000), pos_item(env.cheese, 2, 1125)];
        let tx = strike(&env, batch, card, "2026-10-05", items.clone());
        assert_eq!(tx["entitledValuePiasters"], json!(9850));
        assert_eq!(tx["totalPiasters"], json!(10050));
        assert_eq!(tx["differencePiasters"], json!(200));

        for i in 0..9 {
            let c: Value = env.ok(
                "cards.create",
                json!({ "cardNumber": format!("3{i}"), "holderName": "x", "secretRef": null, "bakery": null,
                        "members": 2, "status": "active", "groupName": null }),
            );
            strike(&env, batch, id(&c), "2026-10-05", items.clone());
        }
        let s: Value = env.ok("pos.batchSummary", json!({ "id": batch }));
        assert_eq!(s["overagePiasters"], json!(2000)); // ten cards x 2.00 = 20.00
        assert_eq!(s["sugarUsed"], json!(20));
        assert_eq!(s["oilUsed"], json!(20));
        assert_eq!(s["moneyUsedPiasters"], json!(100500));
    }
}

mod batch_limits {
    use super::*;

    #[test]
    fn rejects_strikes_that_exceed_the_sugar_limit_or_repeat_a_card() {
        let env = setup();
        let a = id(&env.add_card("4001", 4));
        let b = id(&env.add_card("4002", 4));
        env.open_month("2026-10");
        let batch = id(&env.ok::<Value>("pos.createBatch", json!({ "month": "2026-10", "sugarLimit": 6 })));
        let items = vec![pos_item(env.sugar, 4, 900)];
        strike(&env, batch, a, "2026-10-01", items.clone());
        let message = env.err("pos.record", json!({ "batchId": batch, "cardId": b, "executedAt": "2026-10-01", "items": items }));
        assert!(message.contains("حد السكر"), "{message}");
        let message = env.err(
            "pos.record",
            json!({ "batchId": batch, "cardId": a, "executedAt": "2026-10-01", "items": [pos_item(env.oil, 1, 3000)] }),
        );
        assert!(message.contains("مضروبة من قبل"), "{message}");
    }

    #[test]
    fn voiding_a_strike_reverses_its_rights_and_frees_the_batch() {
        let env = setup();
        let a = id(&env.add_card("4101", 2));
        env.open_month("2026-10");
        let batch = id(&env.ok::<Value>("pos.createBatch", json!({ "month": "2026-10" })));
        let tx = strike(&env, batch, a, "2026-10-01", vec![pos_item(env.pasta, 3, 1000)]);
        assert_eq!(env.rights(a, "2026-10", env.pasta).remaining, 3);
        let _: Value = env.ok("pos.void", json!({ "id": id(&tx), "reason": "خطأ إدخال" }));
        assert_eq!(env.rights(a, "2026-10", env.pasta).remaining, 0);
        let s: Value = env.ok("pos.batchSummary", json!({ "id": batch }));
        assert_eq!(s["moneyUsedPiasters"], json!(0));
        assert_eq!(env.month_context(a, "2026-10")["posStatus"], "none");
    }
}

mod carry_over_and_advance {
    use super::*;

    #[test]
    fn closing_a_month_carries_unreceived_balance_into_the_next_month() {
        let env = setup();
        let card = id(&env.add_card("5001", 4));
        env.open_month("2026-09");
        receive(&env, card, "2026-09", vec![dist_item(env.sugar, 3, "2026-09"), dist_item(env.oil, 4, "2026-09")]);
        let _: Value = env.ok("periods.close", json!({ "month": "2026-09" }));
        let sep = env.rights(card, "2026-09", env.sugar);
        assert_eq!((sep.remaining, sep.carried_out), (0, 1));
        env.open_month("2026-10");
        let oct = env.rights(card, "2026-10", env.sugar);
        assert_eq!((oct.carried_in, oct.entitled, oct.remaining), (1, 4, 5));
    }

    #[test]
    fn products_that_do_not_allow_carry_over_expire_at_close() {
        let env = setup();
        let card = id(&env.add_card("5002", 1));
        let products: Vec<Value> = env.ok("products.list", json!({}));
        let mut oil = products.into_iter().find(|p| p["id"].as_i64() == Some(env.oil)).expect("oil product");
        oil["carryoverAllowed"] = json!(false);
        let _: Value = env.ok("products.save", oil);
        env.open_month("2026-09");
        let _: Value = env.ok("periods.close", json!({ "month": "2026-09" }));
        let row = env.rights(card, "2026-09", env.oil);
        assert_eq!((row.expired, row.remaining), (1, 0));
    }

    #[test]
    fn an_advance_is_deducted_from_next_month() {
        let env = setup();
        let card = id(&env.add_card("5003", 2));
        env.open_month("2026-09");
        receive(&env, card, "2026-09", vec![dist_item(env.oil, 2, "2026-09")]);
        receive(&env, card, "2026-09", vec![dist_item(env.oil, 1, "2026-10")]);
        let next = &env.month_context(card, "2026-09")["nextMonthRights"][0];
        assert_eq!(next["delivered"], json!(1));
        assert_eq!(next["remaining"], json!(-1));
        env.open_month("2026-10");
        let row = env.rights(card, "2026-10", env.oil);
        assert_eq!((row.entitled, row.delivered, row.remaining), (2, 1, 1));
    }
}

mod inventory {
    use super::*;

    #[test]
    fn follows_opening_plus_receipts_plus_returns_minus_distributed_and_damaged() {
        let env = setup();
        let record = |body: Value| -> i64 { env.ok("inventory.record", body) };
        record(json!({ "productId": env.sugar, "type": "opening", "quantity": 50 }));
        record(json!({ "productId": env.sugar, "type": "receipt", "quantity": 954, "documentRef": "INV-1" }));
        record(json!({ "productId": env.sugar, "type": "return", "quantity": 2 }));
        let dmg = record(json!({ "productId": env.sugar, "type": "damage", "quantity": 3, "note": "كيس مقطوع" }));
        let take: Value = env.ok("inventory.stocktake", json!({ "productId": env.sugar, "counted": 1000 }));
        assert_eq!(take["difference"], json!(-3));
        let balances: Vec<Value> = env.ok("inventory.balances", json!({}));
        let b = balances.iter().find(|b| b["productId"].as_i64() == Some(env.sugar)).expect("sugar balance");
        assert_eq!(b["opening"], json!(50));
        assert_eq!(b["receipts"], json!(954));
        assert_eq!(b["returns"], json!(2));
        assert_eq!(b["damaged"], json!(3));
        assert_eq!(b["stocktake"], json!(-3));
        assert_eq!(b["balance"], json!(1000));
        let _: Value = env.ok("inventory.reverse", json!({ "id": dmg, "reason": "تم إعادة التعبئة بدون فقد" }));
        assert_eq!(env.stock(env.sugar), 1003);
        let message = env.err("inventory.reverse", json!({ "id": dmg, "reason": "مرة أخرى" }));
        assert!(message.contains("معكوسة"), "{message}");
    }
}

mod permissions_and_audit {
    use super::*;

    #[test]
    fn clerks_cannot_void_or_change_rules_and_every_operation_is_audited() {
        let env = setup();
        let _: Value = env.ok(
            "users.save",
            json!({ "username": "clerk", "displayName": "موظف", "role": "clerk", "active": true, "password": "pass1" }),
        );
        let _: Value = env.ok("auth.logout", json!({}));
        let _: Value = env.ok("auth.login", json!({ "username": "clerk", "password": "pass1" }));
        assert!(env.err("periods.open", json!({ "month": "2026-10" })).contains("صلاحية المدير"));
        assert!(env.err("pos.void", json!({ "id": 1, "reason": "x" })).contains("صلاحية المدير"));
        env.add_card("6001", 3);
        let _: Value = env.ok("auth.logout", json!({}));
        let _: Value = env.ok("auth.login", json!({ "username": "admin", "password": "admin" }));
        let log: Vec<Value> = env.ok("audit.list", json!({}));
        assert!(log
            .iter()
            .any(|l| l["entity"] == "card" && l["action"] == "create" && l["userName"] == "موظف"));
    }

    #[test]
    fn methods_other_than_login_need_a_signed_in_user() {
        let env = setup();
        let _: Value = env.ok("auth.logout", json!({}));
        assert!(env.err("cards.search", json!({})).contains("تسجيل الدخول"));
        assert!(env.call("auth.me", json!({})).expect("auth.me is public").is_null());
    }
}

mod demo_data {
    use super::*;

    #[test]
    fn loads_once_into_an_empty_database_and_covers_every_tracking_case() {
        let env = setup();
        let loaded: Value = env.ok("demo.load", json!({}));
        assert_eq!(loaded["cards"], json!(12));
        let month = loaded["month"].as_str().expect("month").to_string();
        let t: Value = env.ok("tracking.list", json!({ "month": month, "filter": "all" }));
        assert_eq!(t["total"], json!(12));
        for k in ["struck_not_received", "received_not_struck", "struck_and_received", "neither", "partial_receipt", "has_balance"] {
            assert!(t["counts"][k].as_i64().unwrap_or(0) > 0, "no cards in the {k} case");
        }
        let s: Value = env.ok("pos.batchSummary", json!({ "id": 1 }));
        assert!(s["overagePiasters"].as_i64().unwrap_or(0) > 0);
        assert!(env.err("demo.load", json!({})).contains("فارغة"));
    }
}
