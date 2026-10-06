use std::cell::Cell;

use rusqlite::params;
use serde::Serialize;

use crate::bail;
use crate::db::Db;
use crate::error::Result;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Admin,
    Clerk,
}

#[derive(Clone, Copy, Debug)]
pub struct SessionUser {
    pub id: i64,
    pub role: Role,
}

/// The database plus the signed-in user. One per running app.
pub struct Ctx {
    pub db: Db,
    user: Cell<Option<SessionUser>>,
}

impl Ctx {
    pub fn new(db: Db) -> Ctx {
        Ctx { db, user: Cell::new(None) }
    }

    pub fn user(&self) -> Option<SessionUser> {
        self.user.get()
    }

    pub fn set_user(&self, u: Option<SessionUser>) {
        self.user.set(u)
    }

    pub fn user_id(&self) -> Option<i64> {
        self.user.get().map(|u| u.id)
    }

    pub fn require_user(&self) -> Result<SessionUser> {
        match self.user.get() {
            Some(u) => Ok(u),
            None => bail!("يجب تسجيل الدخول أولاً"),
        }
    }

    pub fn require_admin(&self) -> Result<SessionUser> {
        let u = self.require_user()?;
        if u.role != Role::Admin {
            bail!("هذه العملية تحتاج صلاحية المدير");
        }
        Ok(u)
    }

    pub fn audit(&self, action: &str, entity: &str, entity_id: Option<String>, details: Option<&impl Serialize>) -> Result<()> {
        let details = details.map(serde_json::to_string).transpose()?;
        self.db.run(
            "INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)",
            params![self.user_id(), action, entity, entity_id, details],
        )?;
        Ok(())
    }

    /// Audit entry without details.
    pub fn audit0(&self, action: &str, entity: &str, entity_id: Option<String>) -> Result<()> {
        self.audit(action, entity, entity_id, None::<&()>)
    }
}

/// `Number.isInteger(n) && n > 0` from the UI's number fields.
pub fn positive_int(n: f64, what: &str) -> Result<i64> {
    if n.fract() != 0.0 || n <= 0.0 || !n.is_finite() {
        bail!("{what} يجب أن يكون رقمًا صحيحًا أكبر من صفر");
    }
    Ok(n as i64)
}

/// Whole number (any sign) or None.
pub fn as_int(n: f64) -> Option<i64> {
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

/// Optional trimmed text: blank becomes None.
pub fn trimmed(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(String::from)
}
