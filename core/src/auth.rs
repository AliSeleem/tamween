use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::context::{Ctx, Role, SessionUser};
use crate::db::int_bool;
use crate::error::{Error, Result};

#[derive(Deserialize)]
struct UserRow {
    id: i64,
    username: String,
    display_name: String,
    role: String,
    #[serde(deserialize_with = "int_bool")]
    active: bool,
    #[serde(deserialize_with = "int_bool")]
    must_change_password: bool,
    password_hash: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub active: bool,
    pub must_change_password: bool,
}

impl From<UserRow> for User {
    fn from(r: UserRow) -> User {
        User {
            id: r.id,
            username: r.username,
            display_name: r.display_name,
            role: r.role,
            active: r.active,
            must_change_password: r.must_change_password,
        }
    }
}

fn role_of(s: &str) -> Role {
    if s == "admin" {
        Role::Admin
    } else {
        Role::Clerk
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// Node's scryptSync defaults (N=16384, r=8, p=1), so hashes made by the Electron version still verify.
fn scrypt_hash(password: &str, salt: &[u8], len: usize) -> Result<Vec<u8>> {
    let params = scrypt::Params::new(14, 8, 1).map_err(|e| Error::Internal(e.to_string()))?;
    let mut out = vec![0u8; len];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut out).map_err(|e| Error::Internal(e.to_string()))?;
    Ok(out)
}

pub fn hash_password(password: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| Error::Internal(e.to_string()))?;
    let hash = scrypt_hash(password, &salt, 32)?;
    Ok(format!("scrypt${}${}", hex(&salt), hex(&hash)))
}

fn verify_password(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some("scrypt"), Some(salt), Some(hash)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let (Some(salt), Some(expected)) = (unhex(salt), unhex(hash)) else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let Ok(actual) = scrypt_hash(password, &salt, expected.len()) else {
        return false;
    };
    // constant-time comparison
    expected.iter().zip(&actual).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

pub fn login(ctx: &Ctx, username: &str, password: &str) -> Result<User> {
    let row: Option<UserRow> = ctx.db.get("SELECT * FROM users WHERE username = ?", [username.trim()])?;
    let Some(row) = row.filter(|r| r.active && verify_password(password, &r.password_hash)) else {
        bail!("اسم المستخدم أو كلمة المرور غير صحيحة");
    };
    ctx.set_user(Some(SessionUser { id: row.id, role: role_of(&row.role) }));
    ctx.audit0("login", "user", Some(row.id.to_string()))?;
    Ok(row.into())
}

pub fn logout(ctx: &Ctx) -> Result<()> {
    if let Some(u) = ctx.user() {
        ctx.audit0("logout", "user", Some(u.id.to_string()))?;
    }
    ctx.set_user(None);
    Ok(())
}

pub fn get_user(ctx: &Ctx, id: i64) -> Result<Option<User>> {
    Ok(ctx.db.get::<UserRow>("SELECT * FROM users WHERE id = ?", [id])?.map(User::from))
}

pub fn me(ctx: &Ctx) -> Result<Option<User>> {
    match ctx.user() {
        Some(u) => get_user(ctx, u.id),
        None => Ok(None),
    }
}

pub fn change_password(ctx: &Ctx, old_password: &str, new_password: &str) -> Result<()> {
    let u = ctx.require_user()?;
    let row: UserRow = ctx.db.get("SELECT * FROM users WHERE id = ?", [u.id])?.ok_or_else(|| Error::App("المستخدم غير موجود".into()))?;
    if !verify_password(old_password, &row.password_hash) {
        bail!("كلمة المرور الحالية غير صحيحة");
    }
    if new_password.chars().count() < 4 {
        bail!("كلمة المرور الجديدة قصيرة جدًا");
    }
    ctx.db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", params![hash_password(new_password)?, u.id])?;
    ctx.audit0("change_password", "user", Some(u.id.to_string()))
}

pub fn list_users(ctx: &Ctx) -> Result<Vec<User>> {
    ctx.require_admin()?;
    Ok(ctx.db.all::<UserRow>("SELECT * FROM users ORDER BY id", [])?.into_iter().map(User::from).collect())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserInput {
    pub id: Option<i64>,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub active: bool,
    pub password: Option<String>,
}

pub fn save_user(ctx: &Ctx, input: UserInput) -> Result<User> {
    let me = ctx.require_admin()?;
    let username = input.username.trim();
    let display_name = input.display_name.trim();
    if username.is_empty() || display_name.is_empty() {
        bail!("اسم المستخدم والاسم الظاهر مطلوبان");
    }
    if input.role != "admin" && input.role != "clerk" {
        bail!("الصلاحية غير صحيحة");
    }
    let password = input.password.as_deref().filter(|p| !p.is_empty());
    ctx.db.tx(|| {
        let dup: Option<i64> = ctx.db.value("SELECT id FROM users WHERE username = ?", [username])?;
        if dup.is_some() && dup != input.id {
            bail!("اسم المستخدم مستخدم بالفعل");
        }
        let id = match input.id.filter(|&id| id != 0) {
            Some(id) => {
                if id == me.id && (!input.active || input.role != "admin") {
                    bail!("لا يمكنك إيقاف حسابك أو إزالة صلاحية المدير عنه");
                }
                ctx.db.run(
                    "UPDATE users SET username = ?, display_name = ?, role = ?, active = ? WHERE id = ?",
                    params![username, display_name, input.role, input.active, id],
                )?;
                if let Some(p) = password {
                    ctx.db.run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", params![hash_password(p)?, id])?;
                }
                let details = json!({
                    "id": id, "username": input.username, "displayName": input.display_name, "role": input.role,
                    "active": input.active, "password": password.map(|_| "***"),
                });
                ctx.audit("update", "user", Some(id.to_string()), Some(&details))?;
                id
            }
            None => {
                let Some(p) = password else { bail!("كلمة المرور مطلوبة للمستخدم الجديد") };
                let id = ctx
                    .db
                    .run(
                        "INSERT INTO users (username, display_name, role, active, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)",
                        params![username, display_name, input.role, input.active, hash_password(p)?],
                    )?
                    .last_id;
                ctx.audit("create", "user", Some(id.to_string()), Some(&json!({ "username": input.username, "role": input.role })))?;
                id
            }
        };
        get_user(ctx, id)?.ok_or_else(|| Error::App("المستخدم غير موجود".into()))
    })
}
