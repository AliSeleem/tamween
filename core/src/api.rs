//! One dispatcher for everything the UI can ask for: the same method names as the Electron IPC
//! contract, so the React code keeps calling `call('cards.search', …)`.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::{auth, cards, demo, distribution, importer, inventory, periods, pos, products, settings, tracking};

/// Methods callable before login. Everything else requires a signed-in user.
pub const PUBLIC_METHODS: [&str; 2] = ["auth.login", "auth.me"];

/// Things only the shell can do (native dialogs); injected so the API can run in tests.
pub trait Platform {
    fn pick_import_file(&self) -> Result<Option<String>>;
    fn pick_backup_path(&self) -> Result<Option<String>>;
}

/// A platform that answers "cancelled" to every dialog, for tests and headless runs.
pub struct NoDialogs;

impl Platform for NoDialogs {
    fn pick_import_file(&self) -> Result<Option<String>> {
        Ok(None)
    }
    fn pick_backup_path(&self) -> Result<Option<String>> {
        Ok(None)
    }
}

fn args<T: DeserializeOwned>(method: &str, value: Value) -> Result<T> {
    let value = if value.is_null() { json!({}) } else { value };
    serde_json::from_value(value).map_err(|e| Error::Internal(format!("{method}: {e}")))
}

fn out<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty())
}

fn id_field(v: &Value, key: &str) -> Result<i64> {
    v.get(key).and_then(Value::as_i64).ok_or_else(|| Error::Internal(format!("{key} is required")))
}

/// Runs one API method. `a` is the method's argument object as the UI sent it.
pub fn call(ctx: &Ctx, platform: &dyn Platform, method: &str, a: Value) -> Result<Value> {
    if ctx.user().is_none() && !PUBLIC_METHODS.contains(&method) {
        return Err(Error::App("يجب تسجيل الدخول أولاً".into()));
    }
    match method {
        "auth.login" => out(auth::login(ctx, &str_field(&a, "username"), &str_field(&a, "password"))?),
        "auth.logout" => out(auth::logout(ctx)?),
        "auth.me" => out(auth::me(ctx)?),
        "auth.changePassword" => out(auth::change_password(ctx, &str_field(&a, "oldPassword"), &str_field(&a, "newPassword"))?),
        "users.list" => out(auth::list_users(ctx)?),
        "users.save" => out(auth::save_user(ctx, args(method, a)?)?),

        "settings.get" => out(settings::get_settings(ctx)?),
        "settings.save" => out(settings::save_settings(ctx, args(method, a)?)?),

        "products.list" => out(products::list_products(ctx)?),
        "products.save" => out(products::save_product(ctx, args(method, a)?)?),

        "periods.list" => out(periods::list_periods(ctx)?),
        "periods.open" => out(periods::open_period(ctx, &str_field(&a, "month"))?),
        "periods.close" => out(periods::close_period(ctx, &str_field(&a, "month"))?),
        "periods.config" => out(periods::get_config(ctx, &str_field(&a, "month"))?),
        "periods.saveConfig" => out(periods::save_period_config(ctx, args(method, a)?)?),

        "cards.search" => out(cards::search_cards(ctx, args(method, a)?)?),
        "cards.get" => out(cards::get_card(ctx, id_field(&a, "id")?)?),
        "cards.findByNumber" => out(cards::find_card_by_number(ctx, &str_field(&a, "cardNumber"))?),
        "cards.create" => out(cards::create_card(ctx, &args(method, a)?, "manual")?),
        "cards.update" => {
            let id = id_field(&a, "id")?;
            let reason = opt_str_field(&a, "reason");
            let input = args(method, a.get("card").cloned().unwrap_or(Value::Null))?;
            out(cards::update_card(ctx, id, &input, reason.as_deref())?)
        }
        "cards.statement" => out(cards::card_statement(ctx, id_field(&a, "id")?)?),
        "cards.includeInMonth" => out(cards::include_card(ctx, id_field(&a, "cardId")?, &str_field(&a, "month"))?),
        "cards.monthContext" => out(tracking::card_month_context(ctx, id_field(&a, "cardId")?, &str_field(&a, "month"))?),

        "pos.batches" => out(pos::list_batches(ctx, opt_str_field(&a, "month").as_deref())?),
        "pos.createBatch" => out(pos::create_batch(ctx, args(method, a)?)?),
        "pos.setBatchStatus" => out(pos::set_batch_status(ctx, id_field(&a, "id")?, &str_field(&a, "status"))?),
        "pos.batchSummary" => out(pos::batch_summary(ctx, id_field(&a, "id")?)?),
        "pos.record" => out(pos::record_pos_transaction(ctx, args(method, a)?)?),
        "pos.void" => out(pos::void_pos_transaction(ctx, id_field(&a, "id")?, &str_field(&a, "reason"))?),

        "distribution.record" => out(distribution::record_distribution(ctx, args(method, a)?)?),
        "distribution.void" => out(distribution::void_distribution(ctx, id_field(&a, "id")?, &str_field(&a, "reason"))?),
        "distribution.list" => out(distribution::list_distributions(ctx, args(method, a)?)?),

        "tracking.list" => out(tracking::tracking(ctx, args(method, a)?)?),
        "dashboard.get" => out(tracking::dashboard(ctx, opt_str_field(&a, "month").as_deref())?),

        "inventory.balances" => out(inventory::inventory_balances(ctx, opt_str_field(&a, "asOf").as_deref())?),
        "inventory.movements" => out(inventory::list_movements(ctx, args(method, a)?)?),
        "inventory.record" => out(inventory::record_movement(ctx, args(method, a)?)?),
        "inventory.stocktake" => out(inventory::record_stocktake(ctx, args(method, a)?)?),
        "inventory.reverse" => out(inventory::reverse_movement(ctx, id_field(&a, "id")?, &str_field(&a, "reason"))?),

        "audit.list" => out(tracking::list_audit(ctx, args(method, a)?)?),

        "import.pickFile" => {
            ctx.require_admin()?;
            match platform.pick_import_file()? {
                None => Ok(Value::Null),
                Some(path) => out(json!({ "sheets": importer::pick_sheets(&path)? })),
            }
        }
        "import.preview" => {
            ctx.require_user()?;
            let sheet: importer::ImportSheet = args(method, a.get("sheet").cloned().unwrap_or(Value::Null))?;
            let mapping: importer::ImportMapping = args(method, a.get("mapping").cloned().unwrap_or(Value::Null))?;
            out(importer::preview_import(ctx, &sheet, &mapping)?)
        }
        "import.commit" => {
            let update_existing = a.get("updateExisting").and_then(Value::as_bool).unwrap_or(false);
            let sheet: importer::ImportSheet = args(method, a.get("sheet").cloned().unwrap_or(Value::Null))?;
            let mapping: importer::ImportMapping = args(method, a.get("mapping").cloned().unwrap_or(Value::Null))?;
            out(importer::commit_import(ctx, &sheet, &mapping, update_existing)?)
        }

        "demo.load" => out(demo::load_demo_data(ctx)?),

        "backup.create" => {
            ctx.require_admin()?;
            match platform.pick_backup_path()? {
                None => Ok(Value::Null),
                Some(path) => {
                    ctx.db.run("VACUUM INTO ?", [&path])?;
                    ctx.audit("backup", "database", None, Some(&json!({ "path": path })))?;
                    out(json!({ "path": path }))
                }
            }
        }

        _ => Err(Error::App(format!("طلب غير معروف: {method}"))),
    }
}
