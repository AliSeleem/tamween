//! A version-1 database (written by the Electron release) must upgrade in place and keep its data.

mod common;

use rusqlite::Connection;
use tamween_core::schema::MIGRATIONS;
use tamween_core::Db;

#[test]
fn upgrades_a_version_1_database_and_keeps_its_cards_and_references() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("v1.sqlite");
    let v1 = Connection::open(&path).expect("open v1");
    v1.execute_batch(MIGRATIONS[0].sql).expect("v1 schema");
    v1.execute_batch(
        "INSERT INTO products (id, name, unit) VALUES (1, 'سكر', 'كجم');
         INSERT INTO cards (id, card_number, holder_name, members) VALUES (7, '1001', 'أحمد', 3);
         INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity) VALUES (7, '2026-10', 1, 'entitlement', 3);
         PRAGMA user_version = 1",
    )
    .expect("v1 data");
    drop(v1);

    let db = Db::open(&path.to_string_lossy()).expect("migrate");
    assert_eq!(db.value::<i64>("PRAGMA user_version", []).expect("version"), Some(MIGRATIONS.len() as i64));
    assert_eq!(db.value::<String>("SELECT holder_name FROM cards WHERE id = 7", []).expect("card"), Some("أحمد".to_string()));

    // Cards without a number are allowed, duplicated secret numbers too, but an identifier is required.
    for name in ["منى", "سعاد"] {
        db.run("INSERT INTO cards (card_number, holder_name, secret_ref, members) VALUES (NULL, ?, '1111', 2)", [name])
            .expect("card without a number");
    }
    assert!(db.run("INSERT INTO cards (holder_name, members) VALUES ('بدون', 1)", []).is_err());
    assert!(db
        .run("INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity) VALUES (999, '2026-10', 1, 'entitlement', 1)", [])
        .is_err());
}
