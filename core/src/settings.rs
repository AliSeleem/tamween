use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::context::Ctx;
use crate::error::Result;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shop_name: String,
    pub default_money_limit_piasters: i64,
    pub default_sugar_limit: i64,
    pub default_oil_limit: i64,
    /// warn when a batch reaches this percentage of a limit
    pub alert_threshold_percent: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            shop_name: "محل التموين".into(),
            default_money_limit_piasters: 4_710_000,
            default_sugar_limit: 954,
            default_oil_limit: 876,
            alert_threshold_percent: 90.0,
        }
    }
}

fn default_map() -> Map<String, Value> {
    match serde_json::to_value(AppSettings::default()) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// Stored as one JSON value per key, like the Electron version.
pub fn get_settings(ctx: &Ctx) -> Result<AppSettings> {
    #[derive(Deserialize)]
    struct Row {
        key: String,
        value: String,
    }
    let mut out = default_map();
    for r in ctx.db.all::<Row>("SELECT key, value FROM settings", [])? {
        if out.contains_key(&r.key) {
            if let Ok(v) = serde_json::from_str::<Value>(&r.value) {
                out.insert(r.key, v);
            }
        }
    }
    // A stored value of the wrong type falls back to the defaults rather than failing every screen.
    Ok(serde_json::from_value(Value::Object(out)).unwrap_or_default())
}

pub fn save_settings(ctx: &Ctx, patch: Map<String, Value>) -> Result<AppSettings> {
    ctx.require_admin()?;
    let known = default_map();
    ctx.db.tx(|| {
        for (k, v) in &patch {
            if !known.contains_key(k) {
                continue;
            }
            ctx.db.run(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, serde_json::to_string(v)?],
            )?;
        }
        ctx.audit("update", "settings", None, Some(&patch))
    })?;
    get_settings(ctx)
}
