//! The Tauri shell: one window, one `api` command, and the native dialogs the API needs.
//! All the logic lives in the `tamween-core` crate, which knows nothing about Tauri.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tamween_core::api::{self, Platform};
use tamween_core::{Ctx, Error};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Mirrors the Electron IPC response so the React code is unchanged.
#[derive(Serialize)]
#[serde(untagged)]
enum ApiResponse {
    Ok { ok: bool, data: Value },
    Err { ok: bool, error: String },
}

struct App {
    ctx: Arc<Mutex<Ctx>>,
}

/// Native dialogs. Only reached from a blocking worker thread, never the main thread.
struct Dialogs {
    app: AppHandle,
}

fn path_string(p: FilePath) -> Option<String> {
    p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

impl Platform for Dialogs {
    fn pick_import_file(&self) -> tamween_core::Result<Option<String>> {
        let file = self
            .app
            .dialog()
            .file()
            .set_title("اختر ملف البطاقات")
            .add_filter("Excel / CSV", &["xlsx", "xlsm", "xlsb", "xls", "csv"])
            .blocking_pick_file();
        Ok(file.and_then(path_string))
    }

    fn pick_backup_path(&self) -> tamween_core::Result<Option<String>> {
        let today = {
            let ctx = self.app.state::<App>().ctx.clone();
            let ctx = ctx.lock().map_err(|_| Error::Internal("the database is busy".into()))?;
            ctx.db.today()?
        };
        let file = self
            .app
            .dialog()
            .file()
            .set_title("حفظ نسخة احتياطية")
            .set_file_name(format!("tamween-backup-{today}.sqlite"))
            .add_filter("SQLite", &["sqlite"])
            .blocking_save_file();
        Ok(file.and_then(path_string))
    }
}

#[tauri::command]
async fn api(app: AppHandle, method: String, args: Option<Value>) -> ApiResponse {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let ctx = state.ctx.clone();
        let platform = Dialogs { app: app.clone() };
        let ctx = ctx.lock().map_err(|_| Error::Internal("the database is busy".into()))?;
        api::call(&ctx, &platform, &method, args.unwrap_or(Value::Null))
    })
    .await;
    match result {
        Ok(Ok(data)) => ApiResponse::Ok { ok: true, data },
        Ok(Err(e)) => {
            if matches!(e, Error::Internal(_)) {
                eprintln!("[api] {e}");
            }
            ApiResponse::Err { ok: false, error: e.to_string() }
        }
        Err(e) => ApiResponse::Err { ok: false, error: Error::Internal(e.to_string()).to_string() },
    }
}

/// `TAMWEEN_DB`, else `tamween.sqlite` in the app's data directory (`%APPDATA%/eg.tamween.desktop` on Windows).
fn database_path(app: &AppHandle) -> tamween_core::Result<String> {
    if let Some(path) = std::env::var_os("TAMWEEN_DB") {
        return Ok(path.to_string_lossy().into_owned());
    }
    let dir = app.path().app_data_dir().map_err(|e| Error::Internal(format!("no app data directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("tamween.sqlite");
    // First run after the Electron version: bring its database (and any unmerged WAL) over.
    if !path.exists() {
        if let Ok(config) = app.path().config_dir() {
            let old = config.join("Tamween").join("tamween.sqlite");
            if old.exists() {
                std::fs::copy(&old, &path)?;
                for ext in ["-wal", "-shm"] {
                    let side = old.with_file_name(format!("tamween.sqlite{ext}"));
                    if side.exists() {
                        std::fs::copy(&side, dir.join(format!("tamween.sqlite{ext}")))?;
                    }
                }
            }
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![api])
        .setup(|app| {
            let path = database_path(app.handle())?;
            let ctx = tamween_core::open(&path)?;
            app.manage(App { ctx: Arc::new(Mutex::new(ctx)) });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Tamween window");
}
