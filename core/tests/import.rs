//! Excel and CSV import, ported from the Electron version's vitest suite.
//! Covers the real shop register layout: titles above the header, no card numbers, repeated secret numbers.

mod common;

use common::setup;
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use tamween_core::importer::{commit_import, guess_mapping, preview_import, read_sheet, read_workbook, ImportMapping, ImportResult};

/// Writes a sheet of cell values; an empty string leaves the cell blank.
fn write_sheet(wb: &mut Workbook, name: &str, rows: &[Vec<&str>]) {
    let ws = wb.add_worksheet();
    ws.set_name(name).expect("sheet name");
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            if cell.is_empty() {
                continue;
            }
            let (r, c) = (r as u32, c as u16);
            match cell.parse::<f64>() {
                Ok(n) => ws.write_number(r, c, n).expect("write number"),
                Err(_) => ws.write_string(r, c, *cell).expect("write string"),
            };
        }
    }
}

fn statuses(preview: &[tamween_core::importer::ImportPreviewRow]) -> Vec<&str> {
    preview.iter().map(|r| r.status.as_str()).collect()
}

#[test]
fn reads_xlsx_guesses_arabic_headers_validates_and_imports() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("cards.xlsx");
    let mut wb = Workbook::new();
    write_sheet(
        &mut wb,
        "بطاقات",
        &[
            vec!["م", "رقم البطاقة", "اسم صاحب البطاقة", "الرقم السري", "المخبز", "عدد الأفراد"],
            vec!["1", "١٠٠١", "أحمد", "1234", "مخبز النور", "4"], // Arabic-Indic digits are normalized
            vec!["2", "1002", "منى", "", "مخبز النور", "2"],
            vec!["3", "1002", "مكرر", "", "", "3"],
            vec!["4", "1003", "", "", "", "x"],
            vec!["5", "9000", "اسم جديد", "", "", "5"],
        ],
    );
    wb.save(&path).expect("save workbook");
    let path = path.to_string_lossy().into_owned();

    let env = setup();
    env.add_card("9000", 5);
    let sheet = read_sheet(&path).expect("read sheet");
    let mapping = guess_mapping(&sheet.headers);
    assert_eq!(
        mapping,
        ImportMapping { card_number: Some(1), holder_name: Some(2), secret_ref: Some(3), bakery: Some(4), members: Some(5) }
    );

    let preview = preview_import(&env.ctx, &sheet, &mapping).expect("preview");
    assert_eq!(statuses(&preview), ["new", "new", "error", "error", "update"]);
    assert_eq!(preview[0].card_number.as_deref(), Some("1001"));
    assert!(preview[2].errors[0].contains("مكرر"), "{:?}", preview[2].errors);

    assert_eq!(commit_import(&env.ctx, &sheet, &mapping, false).expect("commit"), ImportResult { created: 2, updated: 0, skipped: 3 });
    assert_eq!(commit_import(&env.ctx, &sheet, &mapping, true).expect("commit"), ImportResult { created: 0, updated: 1, skipped: 4 });
    let updated: Value = env.ok("cards.findByNumber", json!({ "cardNumber": "9000" }));
    assert_eq!(updated["holderName"], "اسم جديد");
    let statement: Value = env.ok("cards.statement", json!({ "id": updated["id"] }));
    assert!(statement["history"][0]["reason"].as_str().expect("reason").contains("cards.xlsx"));
}

#[test]
fn reads_csv_with_quoted_fields() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("cards.csv");
    std::fs::write(&path, "\u{feff}رقم البطاقة,الاسم,عدد الأفراد\n2001,\"علي, محمد\",3\n").expect("write csv");
    let sheet = read_sheet(&path.to_string_lossy()).expect("read sheet");
    assert_eq!(sheet.rows, vec![vec!["2001".to_string(), "علي, محمد".to_string(), "3".to_string()]]);
}

#[test]
fn shop_register_layout_finds_the_header_identifies_by_secret_and_name_and_picks_sheets() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("register.xlsx");
    let mut wb = Workbook::new();
    write_sheet(
        &mut wb,
        "Sheet1",
        &[vec!["مكتب تموين"], vec!["الاسم ", "رقم سرى ", "ع افراد", "مخبز"], vec!["قديم", "1", "1", "ب"]],
    );
    write_sheet(
        &mut wb,
        "Sheet3",
        &[
            vec!["مكتب تموين بنى حرام"],
            vec!["التاجرة /فلانة"],
            vec!["ربط البطاقات التموينية "],
            vec!["الاسم ", "رقم سرى ", "ع افراد", "مخبز", "1", "2", "3"],
            vec!["فتحى رشدى عبدالناصر", "1111", "1", "ن"],
            vec!["محمد محمد خلف ", "1111", "2", "ن "], // same secret number, different person
            vec!["خالد  خميس محجوب", "8518", "3", "ب"],
            vec!["خالد خميس محجوب ", "8518", "3", "ب"], // same person twice
            vec![],
            vec!["بدون رقم", "", "2", "م"],
        ],
    );
    wb.save(&path).expect("save workbook");

    let sheets = read_workbook(&path.to_string_lossy()).expect("read workbook");
    let shapes: Vec<(String, usize, usize)> = sheets.iter().map(|s| (s.sheet_name.clone(), s.header_row, s.rows.len())).collect();
    assert_eq!(shapes, vec![("Sheet1".to_string(), 2, 1), ("Sheet3".to_string(), 4, 6)]);
    let sheet = &sheets[1];
    let mapping = guess_mapping(&sheet.headers);
    assert_eq!(
        mapping,
        ImportMapping { card_number: None, holder_name: Some(0), secret_ref: Some(1), members: Some(2), bakery: Some(3) }
    );

    let env = setup();
    let preview = preview_import(&env.ctx, sheet, &mapping).expect("preview");
    let lines: Vec<(usize, &str)> = preview.iter().map(|r| (r.line, r.status.as_str())).collect();
    assert_eq!(lines, vec![(5, "new"), (6, "new"), (7, "new"), (8, "error"), (10, "error")]);
    assert_eq!(preview[1].bakery.as_deref(), Some("ن"));
    assert_eq!(preview[2].holder_name, "خالد خميس محجوب");
    assert_eq!(commit_import(&env.ctx, sheet, &mapping, false).expect("commit").created, 3);

    // Re-importing finds the same cards (spelling variants folded) instead of duplicating them.
    let again = preview_import(&env.ctx, sheet, &mapping).expect("preview again");
    let kept: Vec<&str> = again.iter().map(|r| r.status.as_str()).filter(|s| *s != "error").collect();
    assert_eq!(kept, ["unchanged", "unchanged", "unchanged"]);
    let found: Value = env.ok("cards.search", json!({ "query": "1111" }));
    assert_eq!(found["total"], json!(2));
}

#[test]
fn search_finds_names_whatever_the_spelling_of_alef_and_yeh() {
    let env = setup();
    let _: Value = env.ok(
        "cards.create",
        json!({ "cardNumber": null, "holderName": "فتحى رشدى أحمد", "secretRef": "1111", "bakery": null,
                "members": 1, "status": "active", "groupName": null }),
    );
    let by_name: Value = env.ok("cards.search", json!({ "query": "فتحي رشدي احمد" }));
    assert_eq!(by_name["total"], json!(1));
    let by_secret: Value = env.ok("cards.search", json!({ "query": "1111" }));
    assert_eq!(by_secret["total"], json!(1));
}
