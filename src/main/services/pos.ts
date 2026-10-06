import type { BatchSummary, PosBatch, PosTransaction, PosTransactionItem } from '@shared/types'
import { formatMoney, isMonth } from '@shared/util'
import type { Ctx } from './context'
import { AppError, assertPositiveInt, audit, requireAdmin, requireUser } from './context'
import { addLedger, reverseLedgerRefs } from './ledger'
import { requireOpenPeriod } from './periods'
import { getSettings } from './settings'

interface BatchRow {
  id: number
  batch_number: string
  month: string
  institution: string | null
  money_limit_piasters: number
  sugar_limit: number
  oil_limit: number
  status: 'open' | 'closed'
  notes: string | null
  created_at: string
}

const toBatch = (r: BatchRow): PosBatch => ({
  id: r.id,
  batchNumber: r.batch_number,
  month: r.month,
  institution: r.institution,
  moneyLimitPiasters: r.money_limit_piasters,
  sugarLimit: r.sugar_limit,
  oilLimit: r.oil_limit,
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at
})

export function listBatches(ctx: Ctx, month?: string): PosBatch[] {
  const rows = month
    ? ctx.db.all<BatchRow>('SELECT * FROM pos_batches WHERE month = ? ORDER BY id DESC', [month])
    : ctx.db.all<BatchRow>('SELECT * FROM pos_batches ORDER BY id DESC')
  return rows.map(toBatch)
}

export function getBatch(ctx: Ctx, id: number): PosBatch {
  const r = ctx.db.get<BatchRow>('SELECT * FROM pos_batches WHERE id = ?', [id])
  if (!r) throw new AppError('الدفعة غير موجودة')
  return toBatch(r)
}

export function createBatch(
  ctx: Ctx,
  input: { month: string; batchNumber?: string; institution?: string; moneyLimitPiasters?: number; sugarLimit?: number; oilLimit?: number; notes?: string }
): PosBatch {
  requireUser(ctx)
  if (!isMonth(input.month)) throw new AppError('صيغة الشهر غير صحيحة')
  const s = getSettings(ctx)
  return ctx.db.tx(() => {
    requireOpenPeriod(ctx, input.month)
    let number = input.batchNumber?.trim()
    if (!number) {
      const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pos_batches WHERE month = ?', [input.month])!.n
      number = `${input.month}/${n + 1}`
      while (ctx.db.get('SELECT 1 FROM pos_batches WHERE batch_number = ?', [number])) number += '*'
    } else if (ctx.db.get('SELECT 1 FROM pos_batches WHERE batch_number = ?', [number])) {
      throw new AppError('رقم الدفعة مستخدم من قبل')
    }
    const money = input.moneyLimitPiasters ?? s.defaultMoneyLimitPiasters
    const sugar = input.sugarLimit ?? s.defaultSugarLimit
    const oil = input.oilLimit ?? s.defaultOilLimit
    for (const v of [money, sugar, oil]) if (!Number.isInteger(v) || v < 0) throw new AppError('حدود الدفعة غير صحيحة')
    const id = ctx.db.run(
      `INSERT INTO pos_batches (batch_number, month, institution, money_limit_piasters, sugar_limit, oil_limit, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [number, input.month, input.institution?.trim() || null, money, sugar, oil, input.notes?.trim() || null, ctx.user!.id]
    ).lastId
    audit(ctx, 'create', 'pos_batch', id, { number, month: input.month, money, sugar, oil })
    return getBatch(ctx, id)
  })
}

export function setBatchStatus(ctx: Ctx, id: number, status: 'open' | 'closed'): PosBatch {
  requireAdmin(ctx)
  return ctx.db.tx(() => {
    const b = getBatch(ctx, id)
    if (status === 'open') requireOpenPeriod(ctx, b.month)
    ctx.db.run('UPDATE pos_batches SET status = ? WHERE id = ?', [status, id])
    audit(ctx, status === 'closed' ? 'close' : 'reopen', 'pos_batch', id)
    return getBatch(ctx, id)
  })
}

interface BatchUsage {
  count: number
  money: number
  sugar: number
  oil: number
  overage: number
  shortfall: number
}

function batchUsage(ctx: Ctx, batchId: number): BatchUsage {
  const t = ctx.db.get<{ count: number; money: number | null; overage: number | null; shortfall: number | null }>(
    `SELECT COUNT(*) AS count, SUM(total_piasters) AS money,
       SUM(CASE WHEN difference_piasters > 0 THEN difference_piasters ELSE 0 END) AS overage,
       SUM(CASE WHEN difference_piasters < 0 THEN -difference_piasters ELSE 0 END) AS shortfall
     FROM pos_transactions WHERE batch_id = ? AND status = 'active'`,
    [batchId]
  )!
  const q = ctx.db.all<{ limit_key: string; qty: number }>(
    `SELECT p.limit_key, SUM(i.quantity) AS qty
     FROM pos_transactions t JOIN pos_transaction_items i ON i.transaction_id = t.id JOIN products p ON p.id = i.product_id
     WHERE t.batch_id = ? AND t.status = 'active' AND p.limit_key IS NOT NULL GROUP BY p.limit_key`,
    [batchId]
  )
  return {
    count: t.count,
    money: t.money ?? 0,
    sugar: q.find((r) => r.limit_key === 'sugar')?.qty ?? 0,
    oil: q.find((r) => r.limit_key === 'oil')?.qty ?? 0,
    overage: t.overage ?? 0,
    shortfall: t.shortfall ?? 0
  }
}

export function batchSummary(ctx: Ctx, id: number): BatchSummary {
  const batch = getBatch(ctx, id)
  const u = batchUsage(ctx, id)
  return {
    batch,
    transactionCount: u.count,
    moneyUsedPiasters: u.money,
    sugarUsed: u.sugar,
    oilUsed: u.oil,
    overagePiasters: u.overage,
    shortfallPiasters: u.shortfall,
    transactions: listPosTransactions(ctx, { batchId: id })
  }
}

export function listPosTransactions(ctx: Ctx, f: { cardId?: number; batchId?: number; month?: string }): PosTransaction[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.cardId) { where.push('t.card_id = ?'); params.push(f.cardId) }
  if (f.batchId) { where.push('t.batch_id = ?'); params.push(f.batchId) }
  if (f.month) { where.push('t.month = ?'); params.push(f.month) }
  const rows = ctx.db.all<Omit<PosTransaction, 'items'>>(
    `SELECT t.id, t.batch_id AS batchId, b.batch_number AS batchNumber, t.card_id AS cardId, c.card_number AS cardNumber,
       c.holder_name AS holderName, t.month, t.executed_at AS executedAt, t.total_piasters AS totalPiasters,
       t.entitled_value_piasters AS entitledValuePiasters, t.difference_piasters AS differencePiasters, t.status,
       t.void_reason AS voidReason, t.notes, u.display_name AS createdBy
     FROM pos_transactions t JOIN pos_batches b ON b.id = t.batch_id JOIN cards c ON c.id = t.card_id
     LEFT JOIN users u ON u.id = t.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC`,
    params
  )
  if (!rows.length) return []
  const items = ctx.db.all<PosTransactionItem & { transactionId: number }>(
    `SELECT i.transaction_id AS transactionId, i.product_id AS productId, p.name AS productName, i.quantity,
       i.unit_price_piasters AS unitPricePiasters, i.line_total_piasters AS lineTotalPiasters
     FROM pos_transaction_items i JOIN products p ON p.id = i.product_id
     WHERE i.transaction_id IN (${rows.map(() => '?').join(',')}) ORDER BY p.sort_order, p.id`,
    rows.map((r) => r.id)
  )
  return rows.map((r) => ({ ...r, items: items.filter((i) => i.transactionId === r.id).map(({ transactionId: _, ...i }) => i) }))
}

/** Value of the card still available in the month, before this strike. */
export function remainingCardValue(ctx: Ctx, cardId: number, month: string): number | null {
  const snap = ctx.db.get<{ value_piasters: number | null }>('SELECT value_piasters FROM card_monthly_snapshots WHERE month = ? AND card_id = ?', [month, cardId])
  if (!snap || snap.value_piasters == null) return null
  const used = ctx.db.get<{ s: number | null }>("SELECT SUM(total_piasters) AS s FROM pos_transactions WHERE card_id = ? AND month = ? AND status = 'active'", [cardId, month])!.s ?? 0
  return snap.value_piasters - used
}

/**
 * Records what was struck on the POS for a card. This is not a receipt: it changes neither stock nor
 * delivered quantities. Products outside the month's entitlement rules (pasta, cheese, ...) become a right
 * for the citizen, since the card's value was spent on them. A total above the card's value is a settlement
 * difference owed to the institution, not a right for the citizen or revenue for the shop.
 */
export function recordPosTransaction(
  ctx: Ctx,
  input: { batchId: number; cardId: number; executedAt: string; items: PosTransactionItem[]; notes?: string; allowAdditional?: boolean }
): PosTransaction {
  requireUser(ctx)
  return ctx.db.tx(() => {
    const batch = getBatch(ctx, input.batchId)
    if (batch.status !== 'open') throw new AppError('الدفعة مغلقة')
    requireOpenPeriod(ctx, batch.month)
    const month = batch.month
    if (!ctx.db.get('SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?', [month, input.cardId])) {
      throw new AppError('البطاقة غير مدرجة في هذا الشهر (لم تكن نشطة عند فتح الشهر)')
    }
    const prior = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pos_transactions WHERE card_id = ? AND month = ? AND status = 'active'", [input.cardId, month])!.n
    if (prior > 0 && !input.allowAdditional) throw new AppError('هذه البطاقة مضروبة من قبل في هذا الشهر. اختر "ضرب إضافي" إذا كان ذلك مقصودًا')

    const merged = new Map<number, { quantity: number; price: number }>()
    for (const it of input.items) {
      assertPositiveInt(it.quantity, 'الكمية')
      if (!Number.isInteger(it.unitPricePiasters) || it.unitPricePiasters < 0) throw new AppError('سعر الوحدة غير صحيح')
      if (!ctx.db.get('SELECT 1 FROM products WHERE id = ?', [it.productId])) throw new AppError('صنف غير معروف')
      const m = merged.get(it.productId)
      if (m && m.price !== it.unitPricePiasters) throw new AppError('نفس الصنف مكرر بسعرين مختلفين')
      merged.set(it.productId, { quantity: (m?.quantity ?? 0) + it.quantity, price: it.unitPricePiasters })
    }
    if (!merged.size) throw new AppError('أدخل صنفًا واحدًا على الأقل')

    const total = [...merged.values()].reduce((s, v) => s + v.quantity * v.price, 0)
    const remainingValue = remainingCardValue(ctx, input.cardId, month)
    const difference = remainingValue == null ? 0 : total - remainingValue

    // Batch limits
    const u = batchUsage(ctx, batch.id)
    const limitQty = (key: string): number =>
      [...merged.entries()].reduce((s, [pid, v]) => {
        const k = ctx.db.get<{ limit_key: string | null }>('SELECT limit_key FROM products WHERE id = ?', [pid])!.limit_key
        return k === key ? s + v.quantity : s
      }, 0)
    if (u.money + total > batch.moneyLimitPiasters) {
      throw new AppError(`تتجاوز العملية الحد المالي للدفعة (المتبقي ${formatMoney(batch.moneyLimitPiasters - u.money)} جنيه)`)
    }
    if (u.sugar + limitQty('sugar') > batch.sugarLimit) throw new AppError(`تتجاوز العملية حد السكر للدفعة (المتبقي ${batch.sugarLimit - u.sugar})`)
    if (u.oil + limitQty('oil') > batch.oilLimit) throw new AppError(`تتجاوز العملية حد الزيت للدفعة (المتبقي ${batch.oilLimit - u.oil})`)

    const id = ctx.db.run(
      `INSERT INTO pos_transactions (batch_id, card_id, month, executed_at, total_piasters, entitled_value_piasters, difference_piasters, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batch.id, input.cardId, month, input.executedAt, total, remainingValue, difference, input.notes?.trim() || null, ctx.user!.id]
    ).lastId
    const ruleProducts = new Set(
      ctx.db.all<{ product_id: number }>('SELECT DISTINCT product_id FROM entitlement_rules WHERE month = ? AND quantity > 0', [month]).map((r) => r.product_id)
    )
    for (const [pid, v] of merged) {
      ctx.db.run(
        'INSERT INTO pos_transaction_items (transaction_id, product_id, quantity, unit_price_piasters, line_total_piasters) VALUES (?, ?, ?, ?, ?)',
        [id, pid, v.quantity, v.price, v.quantity * v.price]
      )
      if (!ruleProducts.has(pid)) {
        addLedger(ctx, { cardId: input.cardId, month, productId: pid, type: 'pos_right', quantity: v.quantity, refType: 'pos', refId: id, note: 'مضروب على الـPOS' })
      }
    }
    audit(ctx, 'create', 'pos_transaction', id, { cardId: input.cardId, batch: batch.batchNumber, total, difference })
    return listPosTransactions(ctx, { cardId: input.cardId }).find((t) => t.id === id)!
  })
}

export function voidPosTransaction(ctx: Ctx, id: number, reason: string): void {
  requireAdmin(ctx)
  if (!reason?.trim()) throw new AppError('سبب الإلغاء مطلوب')
  ctx.db.tx(() => {
    const t = ctx.db.get<{ status: string; month: string; batch_id: number }>('SELECT status, month, batch_id FROM pos_transactions WHERE id = ?', [id])
    if (!t) throw new AppError('العملية غير موجودة')
    if (t.status !== 'active') throw new AppError('العملية ملغاة من قبل')
    requireOpenPeriod(ctx, t.month)
    ctx.db.run(
      "UPDATE pos_transactions SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = datetime('now', 'localtime') WHERE id = ?",
      [reason.trim(), ctx.user!.id, id]
    )
    reverseLedgerRefs(ctx, 'pos', id, `إلغاء ضرب: ${reason.trim()}`)
    audit(ctx, 'void', 'pos_transaction', id, { reason })
  })
}
