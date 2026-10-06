use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::bail;
use crate::context::Ctx;
use crate::db::int_bool;
use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: i64,
    pub name: String,
    pub unit: String,
    pub limit_key: Option<String>,
    #[serde(deserialize_with = "int_bool")]
    pub carryover_allowed: bool,
    #[serde(deserialize_with = "int_bool")]
    pub active: bool,
    pub sort_order: i64,
}

const SELECT: &str = "SELECT id, name, unit, limit_key AS limitKey, carryover_allowed AS carryoverAllowed, active, sort_order AS sortOrder FROM products";

pub fn list_products(ctx: &Ctx) -> Result<Vec<Product>> {
    ctx.db.all(&format!("{SELECT} ORDER BY sort_order, id"), [])
}

pub fn get_product(ctx: &Ctx, id: i64) -> Result<Product> {
    ctx.db.get(&format!("{SELECT} WHERE id = ?"), [id])?.ok_or_else(|| Error::App("الصنف غير موجود".into()))
}

pub fn product_id_by_limit_key(ctx: &Ctx, key: &str) -> Result<Option<i64>> {
    ctx.db.value("SELECT id FROM products WHERE limit_key = ?", [key])
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProductInput {
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    pub unit: String,
    #[serde(default)]
    pub limit_key: Option<String>,
    pub carryover_allowed: bool,
    pub active: bool,
    #[serde(default)]
    pub sort_order: i64,
}

pub fn save_product(ctx: &Ctx, input: ProductInput) -> Result<Product> {
    ctx.require_admin()?;
    let name = input.name.trim();
    let unit = input.unit.trim();
    if name.is_empty() || unit.is_empty() {
        bail!("اسم الصنف والوحدة مطلوبان");
    }
    let limit_key = input.limit_key.as_deref().filter(|k| !k.is_empty());
    if limit_key.is_some_and(|k| k != "sugar" && k != "oil") {
        bail!("الحد المربوط غير صحيح");
    }
    let input_id = input.id.filter(|&id| id != 0);
    ctx.db.tx(|| {
        let dup: Option<i64> = ctx.db.value("SELECT id FROM products WHERE name = ?", [name])?;
        if dup.is_some() && dup != input_id {
            bail!("يوجد صنف بنفس الاسم");
        }
        if let Some(k) = limit_key {
            let other = product_id_by_limit_key(ctx, k)?;
            if other.is_some() && other != input_id {
                bail!("هناك صنف آخر مربوط بنفس الحد");
            }
        }
        let id = match input_id {
            Some(id) => {
                ctx.db.run(
                    "UPDATE products SET name = ?, unit = ?, limit_key = ?, carryover_allowed = ?, active = ?, sort_order = ? WHERE id = ?",
                    params![name, unit, limit_key, input.carryover_allowed, input.active, input.sort_order, id],
                )?;
                ctx.audit("update", "product", Some(id.to_string()), Some(&input))?;
                id
            }
            None => {
                let id = ctx
                    .db
                    .run(
                        "INSERT INTO products (name, unit, limit_key, carryover_allowed, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                        params![name, unit, limit_key, input.carryover_allowed, input.active, input.sort_order],
                    )?
                    .last_id;
                ctx.audit("create", "product", Some(id.to_string()), Some(&input))?;
                id
            }
        };
        get_product(ctx, id)
    })
}
