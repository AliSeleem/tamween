use std::collections::HashMap;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bail;
use crate::cards::{create_card, find_card_by_number, find_card_by_secret_and_name, update_card, CardInput};
use crate::context::Ctx;
use crate::error::Result;
use crate::util::{arabic_key, normalize_digits, squash_spaces};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSheet {
    pub file_name: String,
    pub sheet_name: String,
    /// 1-based row of the header in the original sheet; data rows follow it
    pub header_row: usize,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// Column indexes in the sheet. `cardNumber` is optional: shop registers often have no card numbers.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportMapping {
    #[serde(default)]
    pub card_number: Option<usize>,
    #[serde(default)]
    pub holder_name: Option<usize>,
    #[serde(default)]
    pub secret_ref: Option<usize>,
    #[serde(default)]
    pub bakery: Option<usize>,
    #[serde(default)]
    pub members: Option<usize>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewRow {
    pub line: usize,
    pub card_number: Option<String>,
    pub holder_name: String,
    pub secret_ref: Option<String>,
    pub bakery: Option<String>,
    pub members: Option<i64>,
    /// new | update | unchanged | error
    pub status: String,
    pub errors: Vec<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct ImportResult {
    pub created: i64,
    pub updated: i64,
    pub skipped: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SheetChoice {
    pub sheet: ImportSheet,
    pub mapping: ImportMapping,
}

const HINTS: [(&str, &[&str]); 5] = [
    ("members", &["عدد الافراد", "ع افراد", "الافراد", "افراد", "members"]),
    ("secretRef", &["الرقم السري", "رقم سري", "السري", "سري", "الرقم القومي", "البيان", "pin"]),
    ("bakery", &["المخبز", "مخبز", "bakery"]),
    ("cardNumber", &["رقم البطاقه", "رقم البطاقة", "البطاقه", "card"]),
    ("holderName", &["اسم صاحب", "صاحب البطاقه", "الاسم", "اسم", "name"]),
];

/// Matches the Arabic column titles. Most specific field first so "رقم سري" is not taken as the card number.
pub fn guess_mapping(headers: &[String]) -> ImportMapping {
    let keys: Vec<String> = headers.iter().map(|h| arabic_key(h)).collect();
    let mut out = ImportMapping::default();
    let mut used: Vec<usize> = Vec::new();
    for (field, hints) in HINTS {
        for hint in hints {
            let hint = arabic_key(hint);
            let found = keys.iter().enumerate().find(|(i, h)| !used.contains(i) && h.contains(&hint));
            if let Some((idx, _)) = found {
                used.push(idx);
                match field {
                    "members" => out.members = Some(idx),
                    "secretRef" => out.secret_ref = Some(idx),
                    "bakery" => out.bakery = Some(idx),
                    "cardNumber" => out.card_number = Some(idx),
                    _ => out.holder_name = Some(idx),
                }
                break;
            }
        }
    }
    out
}

fn mapped_count(m: &ImportMapping) -> usize {
    [m.card_number, m.holder_name, m.secret_ref, m.bakery, m.members].iter().filter(|v| v.is_some()).count()
}

/// The header is the row among the first 20 that names the most known columns (titles often sit above it).
fn to_sheet(file_name: &str, sheet_name: &str, grid: Vec<Vec<String>>) -> Option<ImportSheet> {
    let mut best: Option<usize> = None;
    let mut best_score = 0;
    for (i, row) in grid.iter().take(20).enumerate() {
        let score = mapped_count(&guess_mapping(row));
        if score > best_score {
            best = Some(i);
            best_score = score;
        }
    }
    let best = best.filter(|_| best_score >= 2)?;
    let headers: Vec<String> = grid[best].iter().map(|h| h.trim().to_string()).collect();
    // Blank rows in the middle stay so preview line numbers match the sheet; trailing ones are dropped.
    let mut rows: Vec<Vec<String>> = grid.into_iter().skip(best + 1).collect();
    while rows.last().is_some_and(|r| r.iter().all(|c| c.trim().is_empty())) {
        rows.pop();
    }
    if rows.is_empty() {
        return None;
    }
    Some(ImportSheet { file_name: file_name.to_string(), sheet_name: sheet_name.to_string(), header_row: best + 1, headers, rows })
}

fn cell_text(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) => s.chars().take(10).collect(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quoted {
            if ch == '"' && chars.get(i + 1) == Some(&'"') {
                cell.push('"');
                i += 1;
            } else if ch == '"' {
                quoted = false;
            } else {
                cell.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' || ch == ';' || ch == '\t' {
            row.push(std::mem::take(&mut cell));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
        } else {
            cell.push(ch);
        }
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// Reads every worksheet of a spreadsheet (or a .csv) that has a recognizable header row.
pub fn read_workbook(path: &str) -> Result<Vec<ImportSheet>> {
    let p = Path::new(path);
    let file_name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut sheets = Vec::new();
    if ext == "csv" || ext == "txt" {
        let text = std::fs::read_to_string(p)?;
        if let Some(s) = to_sheet(&file_name, &file_name, parse_csv(text.trim_start_matches('\u{feff}'))) {
            sheets.push(s);
        }
    } else if ["xlsx", "xlsm", "xlsb", "xls", "ods"].contains(&ext.as_str()) {
        let mut wb = open_workbook_auto(p).map_err(|e| crate::error::Error::App(format!("لم أتمكن من قراءة الملف: {e}")))?;
        for name in wb.sheet_names().to_vec() {
            let Ok(range) = wb.worksheet_range(&name) else { continue };
            // Keep row positions so line numbers in the preview match the sheet.
            let grid: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(|c| cell_text(c).trim().to_string()).collect()).collect();
            if let Some(s) = to_sheet(&file_name, &name, grid) {
                sheets.push(s);
            }
        }
    } else {
        bail!("صيغة الملف غير مدعومة. احفظ الملف بصيغة xlsx أو csv");
    }
    if sheets.is_empty() {
        bail!("لم أجد صف عناوين (الاسم، الرقم السري، عدد الأفراد…) في أي ورقة من الملف");
    }
    Ok(sheets)
}

/// Kept for single-sheet callers: the sheet with the most rows.
pub fn read_sheet(path: &str) -> Result<ImportSheet> {
    let sheets = read_workbook(path)?;
    Ok(sheets.into_iter().max_by_key(|s| s.rows.len()).expect("read_workbook returns at least one sheet"))
}

pub fn pick_sheets(path: &str) -> Result<Vec<SheetChoice>> {
    Ok(read_workbook(path)?
        .into_iter()
        .map(|sheet| {
            let mapping = guess_mapping(&sheet.headers);
            SheetChoice { sheet, mapping }
        })
        .collect())
}

fn col(row: &[String], idx: Option<usize>) -> String {
    idx.and_then(|i| row.get(i)).map(|v| squash_spaces(&normalize_digits(v))).unwrap_or_default()
}

pub fn preview_import(ctx: &Ctx, sheet: &ImportSheet, mapping: &ImportMapping) -> Result<Vec<ImportPreviewRow>> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for (i, row) in sheet.rows.iter().enumerate() {
        let mut errors: Vec<String> = Vec::new();
        let card_number = Some(col(row, mapping.card_number)).filter(|s| !s.is_empty());
        let holder_name = col(row, mapping.holder_name);
        let secret_ref = Some(col(row, mapping.secret_ref)).filter(|s| !s.is_empty());
        let members_text = col(row, mapping.members);
        // Rows that are entirely blank in the mapped columns are separators, not data.
        if card_number.is_none() && holder_name.is_empty() && secret_ref.is_none() && members_text.is_empty() {
            continue;
        }
        let line = sheet.header_row + 1 + i;
        let members: Option<i64> = members_text.parse::<i64>().ok().filter(|_| members_text.chars().all(|c| c.is_ascii_digit()));
        if holder_name.is_empty() {
            errors.push("الاسم فارغ".into());
        }
        if mapping.card_number.is_some() && card_number.is_none() {
            errors.push("رقم البطاقة فارغ".into());
        }
        if mapping.card_number.is_none() && secret_ref.is_none() {
            errors.push("الرقم السري فارغ".into());
        }
        if !members.is_some_and(|m| (1..=30).contains(&m)) {
            errors.push("عدد الأفراد غير صحيح".into());
        }
        let key = match (&card_number, &secret_ref) {
            (Some(n), _) => Some(n.clone()),
            (None, Some(s)) if !holder_name.is_empty() => Some(format!("{s}|{}", arabic_key(&holder_name))),
            _ => None,
        };
        if let Some(key) = key {
            match seen.get(&key) {
                Some(first) => errors.push(format!("مكرر في الملف (السطر {first})")),
                None => {
                    seen.insert(key, line);
                }
            }
        }
        let bakery = Some(col(row, mapping.bakery)).filter(|s| !s.is_empty());
        let status = if !errors.is_empty() {
            "error"
        } else {
            let existing = match &card_number {
                Some(n) => find_card_by_number(ctx, n)?,
                None => find_card_by_secret_and_name(ctx, secret_ref.as_deref().unwrap_or(""), &holder_name)?,
            };
            match existing {
                None => "new",
                Some(e) => {
                    let same = e.holder_name == holder_name && Some(e.members) == members && e.secret_ref == secret_ref && e.bakery == bakery;
                    if same {
                        "unchanged"
                    } else {
                        "update"
                    }
                }
            }
        };
        out.push(ImportPreviewRow {
            line,
            card_number,
            holder_name,
            secret_ref,
            bakery,
            members,
            status: status.to_string(),
            errors,
        });
    }
    Ok(out)
}

/// Applies a previewed import in one transaction. Existing cards are updated only when `update_existing`
/// is set, through the normal update path so each change lands in the card history.
pub fn commit_import(ctx: &Ctx, sheet: &ImportSheet, mapping: &ImportMapping, update_existing: bool) -> Result<ImportResult> {
    ctx.require_admin()?;
    let preview = preview_import(ctx, sheet, mapping)?;
    let mut result = ImportResult::default();
    ctx.db.tx(|| {
        for r in &preview {
            if r.status == "error" || r.status == "unchanged" || (r.status == "update" && !update_existing) {
                result.skipped += 1;
                continue;
            }
            let input = CardInput {
                card_number: r.card_number.clone(),
                holder_name: r.holder_name.clone(),
                secret_ref: r.secret_ref.clone(),
                bakery: r.bakery.clone(),
                members: r.members.unwrap_or(0) as f64,
                status: "active".into(),
                group_name: None,
            };
            if r.status == "new" {
                create_card(ctx, &input, &format!("import:{}/{}", sheet.file_name, sheet.sheet_name))?;
                result.created += 1;
            } else {
                let existing = match &r.card_number {
                    Some(n) => find_card_by_number(ctx, n)?,
                    None => find_card_by_secret_and_name(ctx, r.secret_ref.as_deref().unwrap_or(""), &r.holder_name)?,
                };
                let Some(existing) = existing else { bail!("لم أجد البطاقة المطلوب تحديثها: {}", r.holder_name) };
                let input = CardInput { status: existing.status.clone(), group_name: existing.group_name.clone(), ..input };
                update_card(ctx, existing.id, &input, Some(&format!("استيراد من {}", sheet.file_name)))?;
                result.updated += 1;
            }
        }
        ctx.audit(
            "import",
            "cards",
            None,
            Some(&json!({ "file": sheet.file_name, "created": result.created, "updated": result.updated, "skipped": result.skipped })),
        )
    })?;
    Ok(result)
}
