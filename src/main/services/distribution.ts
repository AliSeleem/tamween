import type { Distribution, DistributionItem } from '@shared/types'
import { addMonths, isMonth, todayIso } from '@shared/util'
import type { Ctx } from './context'
import { AppError, assertPositiveInt, audit, requireAdmin, requireUser } from './context'
import { addInventory, reverseInventoryRefs } from './inventory'
import { addLedger, reverseLedgerRefs } from './ledger'
import { requireOpenPeriod } from './periods'

export function listDistributions(ctx: Ctx, f: { cardId?: number; month?: string }): Distribution[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.cardId) { where.push('d.card_id = ?'); params.push(f.cardId) }
  if (f.month) { where.push('d.month = ?'); params.push(f.month) }
  const rows = ctx.db.all<Omit<Distribution, 'items'>>(
    `SELECT d.id, d.card_id AS cardId, c.card_number AS cardNumber, c.secret_ref AS secretRef, c.holder_name AS holderName, d.month,
       d.distributed_at AS distributedAt, d.status, d.void_reason AS voidReason, d.notes, u.display_name AS createdBy
     FROM distributions d JOIN cards c ON c.id = d.card_id LEFT JOIN users u ON u.id = d.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC`,
    params
  )
  if (!rows.length) return []
  const items = ctx.db.all<DistributionItem & { distributionId: number }>(
    `SELECT i.distribution_id AS distributionId, i.product_id AS productId, p.name AS productName, i.quantity,
       i.applies_to_month AS appliesToMonth
     FROM distribution_items i JOIN products p ON p.id = i.product_id
     WHERE i.distribution_id IN (${rows.map(() => '?').join(',')}) ORDER BY p.sort_order, p.id`,
    rows.map((r) => r.id)
  )
  return rows.map((r) => ({ ...r, items: items.filter((i) => i.distributionId === r.id).map(({ distributionId: _, ...i }) => i) }))
}

/**
 * Records goods physically handed to the citizen. Independent of the POS: it may come before or after the
 * strike, and the two meet in the ledger of the same card and month. Each item is taken from the right of
 * `appliesToMonth`; the month after the operation's month makes it an advance against next month.
 */
export function recordDistribution(
  ctx: Ctx,
  input: { cardId: number; month: string; distributedAt?: string; items: DistributionItem[]; notes?: string }
): Distribution {
  requireUser(ctx)
  return ctx.db.tx(() => {
    requireOpenPeriod(ctx, input.month)
    if (!ctx.db.get('SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?', [input.month, input.cardId])) {
      throw new AppError('البطاقة غير مدرجة في هذا الشهر')
    }
    const items = input.items.filter((i) => i.quantity !== 0)
    if (!items.length) throw new AppError('أدخل كمية صنف واحد على الأقل')
    const advanceMonth = addMonths(input.month, 1)
    const requested = new Map<string, number>()
    for (const it of items) {
      assertPositiveInt(it.quantity, 'الكمية')
      if (!isMonth(it.appliesToMonth)) throw new AppError('شهر الاستحقاق غير صحيح')
      const key = `${it.appliesToMonth}|${it.productId}`
      requested.set(key, (requested.get(key) ?? 0) + it.quantity)
    }
    for (const [key, qty] of requested) {
      const [m, pidStr] = key.split('|')
      const pid = Number(pidStr)
      const product = ctx.db.get<{ name: string }>('SELECT name FROM products WHERE id = ?', [pid])
      if (!product) throw new AppError('صنف غير معروف')
      if (m === advanceMonth) continue // advance: deducted from next month's right when it opens
      const period = ctx.db.get<{ status: string }>('SELECT status FROM periods WHERE month = ?', [m])
      if (!period || period.status !== 'open') throw new AppError(`لا يمكن الصرف على حساب شهر ${m}`)
      const isRuleProduct = !!ctx.db.get('SELECT 1 FROM entitlement_rules WHERE month = ? AND product_id = ? AND quantity > 0', [m, pid])
      if (!isRuleProduct) continue // items outside the rules may be handed out before their POS strike
      const remaining = ctx.db.get<{ r: number | null }>(
        'SELECT SUM(quantity) AS r FROM citizen_ledger WHERE card_id = ? AND month = ? AND product_id = ?',
        [input.cardId, m, pid]
      )!.r ?? 0
      if (qty > remaining) {
        throw new AppError(`الكمية المطلوبة من ${product.name} (${qty}) أكبر من المتبقي للمواطن (${remaining}). سجّل الزيادة كمقدم على الشهر التالي إذا كان متفقًا عليه`)
      }
    }

    const date = input.distributedAt || todayIso()
    const id = ctx.db.run('INSERT INTO distributions (card_id, month, distributed_at, notes, created_by) VALUES (?, ?, ?, ?, ?)', [
      input.cardId, input.month, date, input.notes?.trim() || null, ctx.user!.id
    ]).lastId
    for (const it of items) {
      ctx.db.run('INSERT INTO distribution_items (distribution_id, product_id, quantity, applies_to_month) VALUES (?, ?, ?, ?)', [
        id, it.productId, it.quantity, it.appliesToMonth
      ])
      const advance = it.appliesToMonth === advanceMonth
      addLedger(ctx, {
        cardId: input.cardId, month: it.appliesToMonth, productId: it.productId, type: 'delivery', quantity: -it.quantity,
        refType: 'distribution', refId: id, note: advance ? `مقدم من ${input.month}` : 'استلام فعلي'
      })
      addInventory(ctx, { productId: it.productId, type: 'distribution', quantity: -it.quantity, date, refType: 'distribution', refId: id, note: `صرف للبطاقة` })
    }
    audit(ctx, 'create', 'distribution', id, { cardId: input.cardId, month: input.month, items })
    return listDistributions(ctx, { cardId: input.cardId }).find((d) => d.id === id)!
  })
}

export function voidDistribution(ctx: Ctx, id: number, reason: string): void {
  requireAdmin(ctx)
  if (!reason?.trim()) throw new AppError('سبب الإلغاء مطلوب')
  ctx.db.tx(() => {
    const d = ctx.db.get<{ status: string; month: string }>('SELECT status, month FROM distributions WHERE id = ?', [id])
    if (!d) throw new AppError('العملية غير موجودة')
    if (d.status !== 'active') throw new AppError('العملية ملغاة من قبل')
    requireOpenPeriod(ctx, d.month)
    const closed = ctx.db.get<{ month: string }>(
      `SELECT p.month FROM distribution_items i JOIN periods p ON p.month = i.applies_to_month
       WHERE i.distribution_id = ? AND p.status = 'closed' LIMIT 1`,
      [id]
    )
    if (closed) throw new AppError(`لا يمكن الإلغاء: الصرف محسوب على شهر ${closed.month} المغلق`)
    ctx.db.run(
      "UPDATE distributions SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = datetime('now', 'localtime') WHERE id = ?",
      [reason.trim(), ctx.user!.id, id]
    )
    reverseLedgerRefs(ctx, 'distribution', id, `إلغاء استلام: ${reason.trim()}`)
    reverseInventoryRefs(ctx, 'distribution', id, `إلغاء استلام: ${reason.trim()}`)
    audit(ctx, 'void', 'distribution', id, { reason })
  })
}
