import type { LimitKey, Product } from '@shared/types'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin } from './context'

interface ProductRow {
  id: number
  name: string
  unit: string
  limit_key: LimitKey | null
  carryover_allowed: number
  active: number
  sort_order: number
}

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  name: r.name,
  unit: r.unit,
  limitKey: r.limit_key,
  carryoverAllowed: !!r.carryover_allowed,
  active: !!r.active,
  sortOrder: r.sort_order
})

export function listProducts(ctx: Ctx, includeInactive = true): Product[] {
  const where = includeInactive ? '' : 'WHERE active = 1'
  return ctx.db.all<ProductRow>(`SELECT * FROM products ${where} ORDER BY sort_order, id`).map(toProduct)
}

export function getProduct(ctx: Ctx, id: number): Product {
  const r = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [id])
  if (!r) throw new AppError('الصنف غير موجود')
  return toProduct(r)
}

export function productIdByLimitKey(ctx: Ctx, key: LimitKey): number | null {
  return ctx.db.get<{ id: number }>('SELECT id FROM products WHERE limit_key = ?', [key])?.id ?? null
}

export function saveProduct(ctx: Ctx, input: Omit<Product, 'id'> & { id?: number }): Product {
  requireAdmin(ctx)
  const name = input.name.trim()
  const unit = input.unit.trim()
  if (!name || !unit) throw new AppError('اسم الصنف والوحدة مطلوبان')
  return ctx.db.tx(() => {
    const dup = ctx.db.get<{ id: number }>('SELECT id FROM products WHERE name = ?', [name])
    if (dup && dup.id !== input.id) throw new AppError('يوجد صنف بنفس الاسم')
    if (input.limitKey) {
      const other = ctx.db.get<{ id: number }>('SELECT id FROM products WHERE limit_key = ?', [input.limitKey])
      if (other && other.id !== input.id) throw new AppError('هناك صنف آخر مربوط بنفس الحد')
    }
    const params = [name, unit, input.limitKey, input.carryoverAllowed ? 1 : 0, input.active ? 1 : 0, input.sortOrder]
    let id = input.id
    if (id) {
      ctx.db.run('UPDATE products SET name = ?, unit = ?, limit_key = ?, carryover_allowed = ?, active = ?, sort_order = ? WHERE id = ?', [...params, id])
      audit(ctx, 'update', 'product', id, input)
    } else {
      id = ctx.db.run('INSERT INTO products (name, unit, limit_key, carryover_allowed, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)', params).lastId
      audit(ctx, 'create', 'product', id, input)
    }
    return getProduct(ctx, id)
  })
}
