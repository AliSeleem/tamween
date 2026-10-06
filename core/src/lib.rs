//! Tamween shop logic: schema, citizen ledger, POS batches, receipts, inventory and the Excel import.
//! Nothing here depends on Tauri, so `cargo test` exercises the whole system.

pub mod api;
pub mod auth;
pub mod cards;
pub mod context;
pub mod db;
pub mod demo;
pub mod distribution;
pub mod error;
pub mod importer;
pub mod inventory;
pub mod ledger;
pub mod periods;
pub mod pos;
pub mod products;
pub mod schema;
pub mod seed;
pub mod settings;
pub mod tracking;
pub mod util;

pub use context::Ctx;
pub use db::Db;
pub use error::{Error, Result};

/// Opens (and migrates) the database and seeds first-run data.
pub fn open(path: &str) -> Result<Ctx> {
    let db = Db::open(path)?;
    seed::seed_if_empty(&db)?;
    Ok(Ctx::new(db))
}
