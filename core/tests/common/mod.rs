use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tamween_core::api::{self, NoDialogs};
use tamween_core::ledger::RightsRow;
use tamween_core::periods::{CardValue, PeriodConfig, Price};
use tamween_core::{Ctx, Db, Error};

pub struct Env {
    pub ctx: Ctx,
    pub sugar: i64,
    pub oil: i64,
    pub pasta: i64,
    pub cheese: i64,
}

/// An in-memory database, seeded and signed in as the admin, plus the ids of the core products.
pub fn setup() -> Env {
    let db = Db::open(":memory:").expect("open :memory:");
    tamween_core::seed::seed_if_empty(&db).expect("seed");
    let env = Env { ctx: Ctx::new(db), sugar: 0, oil: 0, pasta: 0, cheese: 0 };
    env.call("auth.login", json!({ "username": "admin", "password": "admin" })).expect("login as admin");
    let products = tamween_core::products::list_products(&env.ctx).expect("list products");
    let pid = |name: &str| products.iter().find(|p| p.name == name).expect("seeded product").id;
    Env { sugar: pid("سكر"), oil: pid("زيت"), pasta: pid("مكرونة"), cheese: pid("جبنة"), ..env }
}

impl Env {
    pub fn call(&self, method: &str, args: Value) -> Result<Value, Error> {
        api::call(&self.ctx, &NoDialogs, method, args)
    }

    /// Calls a method and decodes its result; panics with the Arabic message on failure.
    pub fn ok<T: DeserializeOwned>(&self, method: &str, args: Value) -> T {
        let v = self.call(method, args).unwrap_or_else(|e| panic!("{method}: {e}"));
        serde_json::from_value(v).unwrap_or_else(|e| panic!("{method} returned an unexpected shape: {e}"))
    }

    /// The Arabic error message of a call that must fail.
    pub fn err(&self, method: &str, args: Value) -> String {
        match self.call(method, args) {
            Ok(v) => panic!("{method} was expected to fail but returned {v}"),
            Err(e) => e.to_string(),
        }
    }

    pub fn add_card(&self, card_number: &str, members: i64) -> Value {
        self.ok(
            "cards.create",
            json!({ "cardNumber": card_number, "holderName": format!("مواطن {card_number}"), "secretRef": null,
                    "bakery": null, "members": members, "status": "active", "groupName": null }),
        )
    }

    /// Opens a month with sugar 9.00 / oil 30.00 / pasta 10.00 / cheese 12.50 and card value 49.25 per member.
    pub fn open_month(&self, month: &str) {
        let _: Value = self.ok("periods.open", json!({ "month": month }));
        let cfg: PeriodConfig = self.ok("periods.config", json!({ "month": month }));
        let prices = [(self.sugar, 900), (self.oil, 3000), (self.pasta, 1000), (self.cheese, 1250)];
        let _: Value = self.ok(
            "periods.saveConfig",
            serde_json::to_value(PeriodConfig {
                card_values: (1..=7).map(|m| CardValue { members: m as f64, value_piasters: (4925 * m) as f64 }).collect(),
                prices: prices.into_iter().map(|(id, p)| Price { product_id: id, price_piasters: p as f64 }).collect(),
                ..cfg
            })
            .expect("serialize config"),
        );
    }

    pub fn month_context(&self, card_id: i64, month: &str) -> Value {
        self.ok("cards.monthContext", json!({ "cardId": card_id, "month": month }))
    }

    /// The rights row of one product in one month, from the card's month context.
    pub fn rights(&self, card_id: i64, month: &str, product_id: i64) -> RightsRow {
        let ctx = self.month_context(card_id, month);
        let rows: Vec<RightsRow> = serde_json::from_value(ctx["rights"].clone()).expect("rights rows");
        rows.into_iter().find(|r| r.product_id == product_id).unwrap_or_else(|| panic!("no rights row for product {product_id}"))
    }

    pub fn stock(&self, product_id: i64) -> i64 {
        let balances: Vec<Value> = self.ok("inventory.balances", json!({}));
        balances
            .iter()
            .find(|b| b["productId"].as_i64() == Some(product_id))
            .map(|b| b["balance"].as_i64().unwrap_or(0))
            .unwrap_or_else(|| panic!("no balance row for product {product_id}"))
    }
}

pub fn id(v: &Value) -> i64 {
    v["id"].as_i64().expect("id")
}

pub fn pos_item(product_id: i64, quantity: i64, price: i64) -> Value {
    json!({ "productId": product_id, "quantity": quantity, "unitPricePiasters": price })
}

pub fn dist_item(product_id: i64, quantity: i64, month: &str) -> Value {
    json!({ "productId": product_id, "quantity": quantity, "appliesToMonth": month })
}
