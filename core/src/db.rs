use std::cell::Cell;

use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Params};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::schema::{Migration, MIGRATIONS};
use crate::util::arabic_key;

/// Synchronous wrapper over SQLite with nested transactions via savepoints.
/// Rows are read into serde types by column name, so SQL aliases decide the field names.
pub struct Db {
    conn: Connection,
    depth: Cell<u32>,
}

pub struct RunResult {
    pub changes: usize,
    pub last_id: i64,
}

impl Db {
    pub fn open(path: &str) -> Result<Db> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        // Lets name searches ignore أ/ا, ى/ي, ة/ه spelling differences.
        conn.create_scalar_function("arkey", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
            Ok(ctx.get::<Option<String>>(0)?.map(|s| arabic_key(&s)))
        })?;
        if path != ":memory:" {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
        }
        let db = Db { conn, depth: Cell::new(0) };
        db.migrate()?;
        Ok(db)
    }

    pub fn raw(&self) -> &Connection {
        &self.conn
    }

    fn migrate(&self) -> Result<()> {
        let current: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let current = current.max(0) as usize;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(current) {
            let Migration { sql, rebuilds_tables } = *m;
            // Rebuilding a referenced table needs foreign keys off, which SQLite only allows outside a transaction.
            if rebuilds_tables {
                self.conn.execute_batch("PRAGMA foreign_keys = OFF")?;
            }
            let r = self.tx(|| {
                self.conn.execute_batch(sql)?;
                if rebuilds_tables {
                    let broken = self.conn.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some();
                    if broken {
                        return Err(Error::Internal(format!("migration {} broke foreign keys", i + 1)));
                    }
                }
                self.conn.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
                Ok(())
            });
            if rebuilds_tables {
                self.conn.execute_batch("PRAGMA foreign_keys = ON")?;
            }
            r?;
        }
        Ok(())
    }

    pub fn all<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        let mut rows = stmt.query(params)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut obj = Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                let v = match row.get_ref(i)? {
                    ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(f) => Value::from(f),
                    ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
                };
                obj.insert(name.clone(), v);
            }
            out.push(serde_json::from_value(Value::Object(obj))?);
        }
        Ok(out)
    }

    pub fn get<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Result<Option<T>> {
        Ok(self.all(sql, params)?.into_iter().next())
    }

    /// First column of the first row; `None` when there is no row.
    pub fn value<T: rusqlite::types::FromSql>(&self, sql: &str, params: impl Params) -> Result<Option<T>> {
        Ok(self.conn.prepare_cached(sql)?.query_row(params, |r| r.get(0)).optional()?)
    }

    /// An integer aggregate such as COUNT or SUM; NULL and no row read as 0.
    pub fn int(&self, sql: &str, params: impl Params) -> Result<i64> {
        Ok(self.value::<Option<i64>>(sql, params)?.flatten().unwrap_or(0))
    }

    pub fn exists(&self, sql: &str, params: impl Params) -> Result<bool> {
        Ok(self.conn.prepare_cached(sql)?.exists(params)?)
    }

    pub fn run(&self, sql: &str, params: impl Params) -> Result<RunResult> {
        let changes = self.conn.prepare_cached(sql)?.execute(params)?;
        Ok(RunResult { changes, last_id: self.conn.last_insert_rowid() })
    }

    pub fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let depth = self.depth.get();
        let sp = format!("sp{depth}");
        self.conn.execute_batch(if depth == 0 { "BEGIN IMMEDIATE".to_string() } else { format!("SAVEPOINT {sp}") }.as_str())?;
        self.depth.set(depth + 1);
        let result = f();
        self.depth.set(depth);
        match result {
            Ok(v) => {
                self.conn.execute_batch(&if depth == 0 { "COMMIT".to_string() } else { format!("RELEASE {sp}") })?;
                Ok(v)
            }
            Err(e) => {
                let undo = if depth == 0 { "ROLLBACK".to_string() } else { format!("ROLLBACK TO {sp}; RELEASE {sp}") };
                self.conn.execute_batch(&undo)?;
                Err(e)
            }
        }
    }

    /// Local date as 'YYYY-MM-DD', from SQLite so it matches the timestamps it writes.
    pub fn today(&self) -> Result<String> {
        Ok(self.value("SELECT date('now', 'localtime')", [])?.unwrap_or_default())
    }

    pub fn current_month(&self) -> Result<String> {
        Ok(self.value("SELECT strftime('%Y-%m', 'now', 'localtime')", [])?.unwrap_or_default())
    }
}

/// Reads SQLite 0/1 integers as booleans.
pub fn int_bool<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    let v: Value = serde::Deserialize::deserialize(d)?;
    Ok(match v {
        Value::Bool(b) => b,
        Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        _ => false,
    })
}
