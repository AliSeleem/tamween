import type { InventoryBalance, InventoryMovement, InventoryTxType } from '@shared/types'
import { todayIso } from '@shared/util'
import type { Ctx } from './context'
import { AppError, assertPositiveInt, audit, requireAdmin, requireUser } from './context'

export function addInventory(
  ctx: Ctx,
  e: { productId: number; type: InventoryTxType; quantity: number; date: string; documentRef?: string | null; refType?: string; refId?: number; note?: string | null }
): number {
  return ctx.db.run(
    `INSERT INTO inventory_transactions (product_id, tx_type, quantity, tx_date, document_ref, ref_type, ref_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.productId, e.type, e.quantity, e.date, e.documentRef ?? null, e.refType ?? null, e.refId ?? null, e.note ?? null, ctx.user?.id ?? null]
  ).lastId
}

function reverseRow(ctx: Ctx, rowId: number, note: string): void {
  const r = ctx.db.get<{ product_id: number; tx_type: InventoryTxType; quantity: number; document_ref: string | null; reversed_by: number | null }>(
    'SELECT product_id, tx_type, quantity, document_ref, reversed_by FROM inventory_transactions WHERE id = ?',
    [rowId]
  )
  if (!r) throw new AppError('الحركة غير موجودة')
  if (r.reversed_by) throw new AppError('الحركة معكوسة من قبل')
  const revId = addInventory(ctx, {
    productId: r.product_id, type: r.tx_type, quantity: -r.quantity, date: todayIso(), documentRef: r.document_ref,
    refType: 'reversal', refId: rowId, note
  })
  ctx.db.run('UPDATE inventory_transactions SET reversed_by = ? WHERE id = ?', [revId, rowId])
}

export function reverseInventoryRefs(ctx: Ctx, refType: string, refId: number, note: string): void {
  const rows = ctx.db.all<{ id: number }>('SELECT id FROM inventory_transactions WHERE ref_type = ? AND ref_id = ? AND reversed_by IS NULL', [refType, refId])
  for (const r of rows) reverseRow(ctx, r.id, note)
}

export function inventoryBalances(ctx: Ctx, asOf?: string): InventoryBalance[] {
  return ctx.db.all<InventoryBalance>(
    `SELECT p.id AS productId, p.name AS productName, p.unit,
       COALESCE(SUM(CASE WHEN t.tx_type = 'opening' THEN t.quantity END), 0) AS opening,
       COALESCE(SUM(CASE WHEN t.tx_type = 'receipt' THEN t.quantity END), 0) AS receipts,
       COALESCE(SUM(CASE WHEN t.tx_type = 'return' THEN t.quantity END), 0) AS returns,
       -COALESCE(SUM(CASE WHEN t.tx_type = 'distribution' THEN t.quantity END), 0) AS distributed,
       -COALESCE(SUM(CASE WHEN t.tx_type = 'damage' THEN t.quantity END), 0) AS damaged,
       COALESCE(SUM(CASE WHEN t.tx_type = 'stocktake' THEN t.quantity END), 0) AS stocktake,
       COALESCE(SUM(t.quantity), 0) AS balance
     FROM products p LEFT JOIN inventory_transactions t ON t.product_id = p.id ${asOf ? 'AND t.tx_date <= ?' : ''}
     WHERE p.active = 1 OR t.id IS NOT NULL
     GROUP BY p.id ORDER BY p.sort_order, p.id`,
    asOf ? [asOf] : []
  )
}

export function stockOf(ctx: Ctx, productId: number): number {
  return ctx.db.get<{ q: number | null }>('SELECT SUM(quantity) AS q FROM inventory_transactions WHERE product_id = ?', [productId])!.q ?? 0
}

export function listMovements(ctx: Ctx, f: { productId?: number; type?: InventoryTxType; from?: string; to?: string; limit?: number }): InventoryMovement[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.productId) { where.push('t.product_id = ?'); params.push(f.productId) }
  if (f.type) { where.push('t.tx_type = ?'); params.push(f.type) }
  if (f.from) { where.push('t.tx_date >= ?'); params.push(f.from) }
  if (f.to) { where.push('t.tx_date <= ?'); params.push(f.to) }
  params.push(f.limit ?? 500)
  return ctx.db
    .all<Omit<InventoryMovement, 'reversed' | 'isReversal'> & { reversedBy: number | null; refType: string | null }>(
      `SELECT t.id, t.product_id AS productId, p.name AS productName, t.tx_type AS txType, t.quantity, t.tx_date AS txDate,
         t.document_ref AS documentRef, t.note, t.reversed_by AS reversedBy, t.ref_type AS refType,
         u.display_name AS userName, t.created_at AS createdAt
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.tx_date DESC, t.id DESC LIMIT ?`,
      params
    )
    .map(({ reversedBy, refType, ...m }) => ({ ...m, reversed: reversedBy != null, isReversal: refType === 'reversal' }))
}

const MANUAL_TYPES: InventoryTxType[] = ['opening', 'receipt', 'return', 'damage']

/**
 * Manual stock movement. Quantities are entered positive; damage is stored negative.
 * Repacking an opened bag without loss is not a movement at all and should not be recorded here.
 */
export function recordMovement(
  ctx: Ctx,
  input: { productId: number; type: InventoryTxType; quantity: number; date?: string; documentRef?: string; note?: string }
): number {
  const user = requireUser(ctx)
  if (!MANUAL_TYPES.includes(input.type)) throw new AppError('نوع الحركة غير مسموح من هذه الشاشة')
  if (input.type === 'opening' && user.role !== 'admin') throw new AppError('رصيد أول المدة يحتاج صلاحية المدير')
  assertPositiveInt(input.quantity, 'الكمية')
  if (input.type === 'receipt' && !input.documentRef?.trim()) throw new AppError('رقم مستند الوارد مطلوب')
  if (input.type === 'damage' && !input.note?.trim()) throw new AppError('اكتب سبب التالف')
  return ctx.db.tx(() => {
    if (!ctx.db.get('SELECT 1 FROM products WHERE id = ?', [input.productId])) throw new AppError('صنف غير معروف')
    const qty = input.type === 'damage' ? -input.quantity : input.quantity
    const id = addInventory(ctx, {
      productId: input.productId, type: input.type, quantity: qty, date: input.date || todayIso(),
      documentRef: input.documentRef?.trim() || null, refType: 'manual', note: input.note?.trim() || null
    })
    audit(ctx, 'create', 'inventory_tx', id, input)
    return id
  })
}

/** Records a physical count; the difference from the book balance is stored as a stocktake movement. */
export function recordStocktake(ctx: Ctx, input: { productId: number; counted: number; date?: string; note?: string }): { difference: number } {
  requireAdmin(ctx)
  if (!Number.isInteger(input.counted) || input.counted < 0) throw new AppError('الكمية الفعلية غير صحيحة')
  return ctx.db.tx(() => {
    const book = stockOf(ctx, input.productId)
    const difference = input.counted - book
    if (difference !== 0) {
      const id = addInventory(ctx, {
        productId: input.productId, type: 'stocktake', quantity: difference, date: input.date || todayIso(),
        refType: 'manual', note: input.note?.trim() || `جرد: الدفتري ${book} والفعلي ${input.counted}`
      })
      audit(ctx, 'stocktake', 'inventory_tx', id, { ...input, book, difference })
    } else {
      audit(ctx, 'stocktake', 'product', input.productId, { ...input, book, difference })
    }
    return { difference }
  })
}

export function reverseMovement(ctx: Ctx, id: number, reason: string): void {
  requireAdmin(ctx)
  if (!reason?.trim()) throw new AppError('سبب العكس مطلوب')
  ctx.db.tx(() => {
    const r = ctx.db.get<{ ref_type: string | null }>('SELECT ref_type FROM inventory_transactions WHERE id = ?', [id])
    if (!r) throw new AppError('الحركة غير موجودة')
    if (r.ref_type !== 'manual') throw new AppError('هذه الحركة ناتجة عن عملية أخرى؛ ألغِ العملية الأصلية بدلًا منها')
    reverseRow(ctx, id, `عكس: ${reason.trim()}`)
    audit(ctx, 'reverse', 'inventory_tx', id, { reason })
  })
}
