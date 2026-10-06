import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/db/db'
import { migrations } from '../src/main/db/schema'

describe('migrations', () => {
  it('upgrades a version-1 database and keeps its cards and references', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tamween-')), 'v1.sqlite')
    const v1 = new DatabaseSync(path)
    v1.exec(migrations[0] as string)
    v1.exec("INSERT INTO products (id, name, unit) VALUES (1, 'سكر', 'كجم')")
    v1.exec("INSERT INTO cards (id, card_number, holder_name, members) VALUES (7, '1001', 'أحمد', 3)")
    v1.exec("INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity) VALUES (7, '2026-10', 1, 'entitlement', 3)")
    v1.exec('PRAGMA user_version = 1')
    v1.close()

    const db = new Db(path)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(migrations.length)
    expect(db.get<{ holder_name: string }>('SELECT holder_name FROM cards WHERE id = 7')!.holder_name).toBe('أحمد')
    db.run("INSERT INTO cards (card_number, holder_name, secret_ref, members) VALUES (NULL, 'منى', '1111', 2)")
    db.run("INSERT INTO cards (card_number, holder_name, secret_ref, members) VALUES (NULL, 'سعاد', '1111', 2)")
    expect(() => db.run("INSERT INTO cards (holder_name, members) VALUES ('بدون', 1)")).toThrow()
    expect(() => db.run("INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity) VALUES (999, '2026-10', 1, 'entitlement', 1)")).toThrow()
    db.close()
  })
})
