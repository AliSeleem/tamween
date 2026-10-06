import type { PosStatus, ReceiptStatus, RightsRow } from '@shared/types'
import type { Ctx } from './context'

export type LedgerType = 'entitlement' | 'pos_right' | 'delivery' | 'carry_in' | 'carry_out' | 'expire'

export function addLedger(
  ctx: Ctx,
  e: { cardId: number; month: string; productId: number; type: LedgerType; quantity: number; refType?: string; refId?: number; note?: string }
): void {
  if (e.quantity === 0) return
  ctx.db.run(
    `INSERT INTO citizen_ledger (card_id, month, product_id, entry_type, quantity, ref_type, ref_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.cardId, e.month, e.productId, e.type, e.quantity, e.refType ?? null, e.refId ?? null, e.note ?? null, ctx.user?.id ?? null]
  )
}

/** Writes the opposite of every ledger row that a voided operation created. */
export function reverseLedgerRefs(ctx: Ctx, refType: string, refId: number, note: string): void {
  const rows = ctx.db.all<{ card_id: number; month: string; product_id: number; entry_type: LedgerType; quantity: number }>(
    'SELECT card_id, month, product_id, entry_type, quantity FROM citizen_ledger WHERE ref_type = ? AND ref_id = ?',
    [refType, refId]
  )
  for (const r of rows) {
    addLedger(ctx, { cardId: r.card_id, month: r.month, productId: r.product_id, type: r.entry_type, quantity: -r.quantity, refType: 'void', refId, note })
  }
}

interface RightsAgg {
  month: string
  product_id: number
  name: string
  unit: string
  entitled: number
  pos_right: number
  carry_in: number
  delivered: number
  carry_out: number
  expired: number
  remaining: number
}

/** Rights summary per month and product for one card; optionally limited to one month. */
export function cardRights(ctx: Ctx, cardId: number, month?: string): RightsRow[] {
  const params: (string | number)[] = [cardId]
  let where = 'l.card_id = ?'
  if (month) {
    where += ' AND l.month = ?'
    params.push(month)
  }
  const rows = ctx.db.all<RightsAgg>(
    `SELECT l.month, l.product_id, p.name, p.unit,
       SUM(CASE WHEN entry_type = 'entitlement' THEN quantity ELSE 0 END) AS entitled,
       SUM(CASE WHEN entry_type = 'pos_right' THEN quantity ELSE 0 END) AS pos_right,
       SUM(CASE WHEN entry_type = 'carry_in' THEN quantity ELSE 0 END) AS carry_in,
       -SUM(CASE WHEN entry_type = 'delivery' THEN quantity ELSE 0 END) AS delivered,
       -SUM(CASE WHEN entry_type = 'carry_out' THEN quantity ELSE 0 END) AS carry_out,
       -SUM(CASE WHEN entry_type = 'expire' THEN quantity ELSE 0 END) AS expired,
       SUM(quantity) AS remaining
     FROM citizen_ledger l JOIN products p ON p.id = l.product_id
     WHERE ${where}
     GROUP BY l.month, l.product_id
     ORDER BY l.month DESC, p.sort_order, p.id`,
    params
  )
  const pos = ctx.db.all<{ month: string; product_id: number; qty: number }>(
    `SELECT t.month, i.product_id, SUM(i.quantity) AS qty
     FROM pos_transactions t JOIN pos_transaction_items i ON i.transaction_id = t.id
     WHERE t.card_id = ? AND t.status = 'active' ${month ? 'AND t.month = ?' : ''}
     GROUP BY t.month, i.product_id`,
    params
  )
  const posMap = new Map(pos.map((p) => [`${p.month}|${p.product_id}`, p.qty]))
  const out: RightsRow[] = rows.map((r) => ({
    month: r.month,
    productId: r.product_id,
    productName: r.name,
    unit: r.unit,
    entitled: r.entitled,
    posRight: r.pos_right,
    carriedIn: r.carry_in,
    delivered: r.delivered,
    carriedOut: r.carry_out,
    expired: r.expired,
    remaining: r.remaining,
    posQuantity: posMap.get(`${r.month}|${r.product_id}`) ?? 0
  }))
  // Products struck on the POS but with no ledger rows (rule products struck before any entitlement) still show up.
  for (const p of pos) {
    if (!out.some((o) => o.month === p.month && o.productId === p.product_id)) {
      const prod = ctx.db.get<{ name: string; unit: string }>('SELECT name, unit FROM products WHERE id = ?', [p.product_id])!
      out.push({
        month: p.month, productId: p.product_id, productName: prod.name, unit: prod.unit,
        entitled: 0, posRight: 0, carriedIn: 0, delivered: 0, carriedOut: 0, expired: 0, remaining: 0, posQuantity: p.qty
      })
    }
  }
  return out
}

export interface CardMonthStatus {
  cardId: number
  posStatus: PosStatus
  receiptStatus: ReceiptStatus
  remainingUnits: number
  owedUnits: number
  needsLink: boolean
  delivered: number
  posCount: number
}

/** POS and receipt status of every card in a month, computed from the ledger and POS transactions. */
export function monthStatuses(ctx: Ctx, month: string, cardId?: number): Map<number, CardMonthStatus> {
  const cardFilter = cardId ? 'AND card_id = :card' : ''
  const params: Record<string, string | number> = { m: month }
  if (cardId) params.card = cardId
  const rows = ctx.db.all<{
    card_id: number
    pos_rem: number | null
    neg_rem: number | null
    delivered: number | null
    entitled: number | null
    tx_count: number | null
    core_struck: number | null
  }>(
    `WITH l AS (
       SELECT card_id, product_id,
         SUM(quantity) AS remaining,
         -SUM(CASE WHEN entry_type = 'delivery' THEN quantity ELSE 0 END) AS delivered,
         SUM(CASE WHEN entry_type = 'entitlement' THEN quantity ELSE 0 END) AS entitled
       FROM citizen_ledger WHERE month = :m ${cardFilter}
       GROUP BY card_id, product_id
     ),
     lc AS (
       SELECT card_id, SUM(MAX(remaining, 0)) AS pos_rem, SUM(MAX(-remaining, 0)) AS neg_rem,
         SUM(delivered) AS delivered, SUM(entitled) AS entitled
       FROM l GROUP BY card_id
     ),
     rp AS (SELECT DISTINCT product_id FROM entitlement_rules WHERE month = :m AND quantity > 0),
     p AS (
       SELECT t.card_id, COUNT(DISTINCT t.id) AS tx_count,
         SUM(CASE WHEN rp.product_id IS NOT NULL THEN i.quantity ELSE 0 END) AS core_struck
       FROM pos_transactions t
       JOIN pos_transaction_items i ON i.transaction_id = t.id
       LEFT JOIN rp ON rp.product_id = i.product_id
       WHERE t.month = :m AND t.status = 'active' ${cardId ? 'AND t.card_id = :card' : ''}
       GROUP BY t.card_id
     ),
     ids AS (
       SELECT card_id FROM card_monthly_snapshots WHERE month = :m ${cardFilter}
       UNION SELECT card_id FROM lc UNION SELECT card_id FROM p
     )
     SELECT ids.card_id, lc.pos_rem, lc.neg_rem, lc.delivered, lc.entitled, p.tx_count, p.core_struck
     FROM ids LEFT JOIN lc ON lc.card_id = ids.card_id LEFT JOIN p ON p.card_id = ids.card_id`,
    params
  )
  const out = new Map<number, CardMonthStatus>()
  for (const r of rows) {
    const txCount = r.tx_count ?? 0
    const delivered = r.delivered ?? 0
    const remaining = r.pos_rem ?? 0
    const posStatus: PosStatus = txCount === 0 ? 'none' : (r.core_struck ?? 0) < (r.entitled ?? 0) ? 'partial' : 'struck'
    const receiptStatus: ReceiptStatus = delivered <= 0 ? 'none' : remaining === 0 ? 'full' : 'partial'
    out.set(r.card_id, {
      cardId: r.card_id,
      posStatus,
      receiptStatus,
      remainingUnits: remaining,
      owedUnits: r.neg_rem ?? 0,
      needsLink: delivered > 0 && txCount === 0,
      delivered,
      posCount: txCount
    })
  }
  return out
}
