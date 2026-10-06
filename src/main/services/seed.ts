import type { Db } from '../db/db'
import { hashPassword } from './auth'

/** Entitlement table confirmed in the PRD (members -> [sugar kg, oil bottles]). Editable per month. */
export const DEFAULT_CORE_RULES: Record<number, [number, number]> = {
  1: [1, 1],
  2: [2, 2],
  3: [3, 3],
  4: [4, 4],
  5: [5, 4],
  6: [6, 4],
  7: [6, 4]
}

/** First-run data: an admin account and the product list named in the PRD. */
export function seedIfEmpty(db: Db): void {
  db.tx(() => {
    if (!db.get('SELECT 1 FROM users LIMIT 1')) {
      db.run(
        "INSERT INTO users (username, display_name, role, password_hash, must_change_password) VALUES ('admin', 'المدير', 'admin', ?, 1)",
        [hashPassword('admin')]
      )
    }
    if (!db.get('SELECT 1 FROM products LIMIT 1')) {
      const products: [string, string, string | null][] = [
        ['سكر', 'كجم', 'sugar'],
        ['زيت', 'زجاجة', 'oil'],
        ['مكرونة', 'كيس', null],
        ['جبنة', 'عبوة', null],
        ['بسكويت', 'عبوة', null],
        ['طحينة', 'عبوة', null]
      ]
      products.forEach(([name, unit, key], i) =>
        db.run('INSERT INTO products (name, unit, limit_key, sort_order) VALUES (?, ?, ?, ?)', [name, unit, key, i + 1])
      )
    }
  })
}
