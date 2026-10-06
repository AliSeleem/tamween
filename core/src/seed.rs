use rusqlite::params;

use crate::auth::hash_password;
use crate::db::Db;
use crate::error::Result;

/// Entitlement table confirmed in the PRD (members -> [sugar kg, oil bottles]). Editable per month.
pub const DEFAULT_CORE_RULES: [(i64, i64, i64); 7] = [(1, 1, 1), (2, 2, 2), (3, 3, 3), (4, 4, 4), (5, 5, 4), (6, 6, 4), (7, 6, 4)];

/// First-run data: an admin account and the product list named in the PRD.
pub fn seed_if_empty(db: &Db) -> Result<()> {
    db.tx(|| {
        if !db.exists("SELECT 1 FROM users LIMIT 1", [])? {
            db.run(
                "INSERT INTO users (username, display_name, role, password_hash, must_change_password) VALUES ('admin', 'المدير', 'admin', ?, 1)",
                [hash_password("admin")?],
            )?;
        }
        if !db.exists("SELECT 1 FROM products LIMIT 1", [])? {
            let products = [
                ("سكر", "كجم", Some("sugar")),
                ("زيت", "زجاجة", Some("oil")),
                ("مكرونة", "كيس", None),
                ("جبنة", "عبوة", None),
                ("بسكويت", "عبوة", None),
                ("طحينة", "عبوة", None),
            ];
            for (i, (name, unit, key)) in products.into_iter().enumerate() {
                db.run("INSERT INTO products (name, unit, limit_key, sort_order) VALUES (?, ?, ?, ?)", params![name, unit, key, i as i64 + 1])?;
            }
        }
        Ok(())
    })
}
