import type { Alert, AuditEntry, CardMonthContext, DashboardSummary, TrackingFilter, TrackingResult, TrackingRow } from '@shared/types'
import { addMonths, arabicKey, formatMoney, ltr, monthLabel, normalizeDigits } from '@shared/util'
import { getCard } from './cards'
import type { Ctx } from './context'
import { listDistributions } from './distribution'
import { inventoryBalances } from './inventory'
import { cardRights, monthStatuses, type CardMonthStatus } from './ledger'
import { getConfig, latestOpenMonth } from './periods'
import { batchSummary, listBatches, listPosTransactions, remainingCardValue } from './pos'
import { getSettings } from './settings'

const FILTERS: Record<TrackingFilter, (s: CardMonthStatus) => boolean> = {
  all: () => true,
  struck_not_received: (s) => s.posStatus !== 'none' && s.receiptStatus === 'none',
  received_not_struck: (s) => s.receiptStatus !== 'none' && s.posStatus === 'none',
  struck_and_received: (s) => s.posStatus !== 'none' && s.receiptStatus !== 'none',
  neither: (s) => s.posStatus === 'none' && s.receiptStatus === 'none',
  partial_receipt: (s) => s.receiptStatus === 'partial',
  has_balance: (s) => s.remainingUnits > 0
}

export function tracking(ctx: Ctx, args: { month: string; filter: TrackingFilter; query?: string; limit?: number; offset?: number }): TrackingResult {
  const statuses = monthStatuses(ctx, args.month)
  const cards = ctx.db.all<{ id: number; card_number: string | null; secret_ref: string | null; holder_name: string; members: number | null }>(
    `SELECT c.id, c.card_number, c.secret_ref, c.holder_name, s.members
     FROM cards c LEFT JOIN card_monthly_snapshots s ON s.card_id = c.id AND s.month = ?
     ORDER BY c.card_number IS NULL, c.card_number, c.holder_name`,
    [args.month]
  )
  const q = normalizeDigits(args.query ?? '').trim()
  const counts = Object.fromEntries(Object.keys(FILTERS).map((k) => [k, 0])) as Record<TrackingFilter, number>
  const matched: TrackingRow[] = []
  for (const c of cards) {
    const s = statuses.get(c.id)
    if (!s) continue
    for (const k of Object.keys(FILTERS) as TrackingFilter[]) if (FILTERS[k](s)) counts[k]++
    if (!FILTERS[args.filter](s)) continue
    if (q && !c.card_number?.startsWith(q) && c.secret_ref !== q && !arabicKey(c.holder_name).includes(arabicKey(q))) continue
    matched.push({
      cardId: c.id,
      cardNumber: c.card_number,
      secretRef: c.secret_ref,
      holderName: c.holder_name,
      members: c.members ?? 0,
      posStatus: s.posStatus,
      receiptStatus: s.receiptStatus,
      remainingUnits: s.remainingUnits,
      owedUnits: s.owedUnits,
      needsLink: s.needsLink
    })
  }
  const offset = args.offset ?? 0
  return { rows: matched.slice(offset, offset + (args.limit ?? 200)), total: matched.length, counts }
}

export function cardMonthContext(ctx: Ctx, cardId: number, month: string): CardMonthContext {
  const card = getCard(ctx, cardId)
  const period = ctx.db.get<{ status: string }>('SELECT status FROM periods WHERE month = ?', [month])
  const snap = ctx.db.get<{ members: number }>('SELECT members FROM card_monthly_snapshots WHERE month = ? AND card_id = ?', [month, cardId])
  const status = monthStatuses(ctx, month, cardId).get(cardId)
  return {
    card,
    month,
    periodOpen: period?.status === 'open',
    snapshotMembers: snap?.members ?? null,
    entitledValuePiasters: snap ? remainingCardValue(ctx, cardId, month) : null,
    rights: cardRights(ctx, cardId, month),
    nextMonthRights: cardRights(ctx, cardId, addMonths(month, 1)),
    posStatus: status?.posStatus ?? 'none',
    receiptStatus: status?.receiptStatus ?? 'none',
    posTransactions: listPosTransactions(ctx, { cardId, month }),
    distributions: listDistributions(ctx, { cardId, month }),
    prices: getConfig(ctx, month).prices
  }
}

/** Alerts from PRD §17: batch limits, unmatched cards, outstanding balances, stock issues. */
export function alerts(ctx: Ctx, month: string | null): Alert[] {
  const out: Alert[] = []
  const threshold = getSettings(ctx).alertThresholdPercent / 100
  if (!month) {
    out.push({ level: 'info', message: 'لا يوجد شهر مفتوح. افتح شهرًا من الإعدادات لبدء التشغيل.', link: '/settings' })
    return out
  }
  for (const b of listBatches(ctx, month).filter((b) => b.status === 'open')) {
    const s = batchSummary(ctx, b.id)
    const checks: [string, number, number, string][] = [
      ['الحد المالي', s.moneyUsedPiasters, b.moneyLimitPiasters, 'جنيه'],
      ['السكر', s.sugarUsed, b.sugarLimit, ''],
      ['الزيت', s.oilUsed, b.oilLimit, '']
    ]
    for (const [name, used, limit] of checks) {
      if (limit > 0 && used >= limit) out.push({ level: 'danger', message: `الدفعة ${ltr(b.batchNumber)}: تم الوصول إلى ${name}`, link: `/pos/${b.id}` })
      else if (limit > 0 && used >= limit * threshold) {
        out.push({ level: 'warning', message: `الدفعة ${ltr(b.batchNumber)}: اقتربت من ${name} (${Math.round((used / limit) * 100)}٪)`, link: `/pos/${b.id}` })
      }
    }
    if (s.overagePiasters > 0) out.push({ level: 'info', message: `الدفعة ${ltr(b.batchNumber)}: فروق زيادة متراكمة ${formatMoney(s.overagePiasters)} جنيه`, link: `/pos/${b.id}` })
  }
  const statuses = [...monthStatuses(ctx, month).values()]
  const receivedNotStruck = statuses.filter(FILTERS.received_not_struck).length
  const struckNotReceived = statuses.filter(FILTERS.struck_not_received).length
  const withBalance = statuses.filter(FILTERS.has_balance).length
  const owing = statuses.filter((s) => s.owedUnits > 0 && !s.needsLink).length
  if (receivedNotStruck) out.push({ level: 'warning', message: `${receivedNotStruck} بطاقة استلمت ولم تُضرب`, link: '/tracking?filter=received_not_struck' })
  if (struckNotReceived) out.push({ level: 'warning', message: `${struckNotReceived} بطاقة ضُربت ولم تستلم`, link: '/tracking?filter=struck_not_received' })
  if (withBalance) out.push({ level: 'info', message: `${withBalance} بطاقة لها رصيد متبقٍ في ${monthLabel(month)}`, link: '/tracking?filter=has_balance' })
  if (owing) out.push({ level: 'info', message: `${owing} بطاقة استلمت أكثر من رصيدها (مقدم أو صرف قبل الضرب)`, link: '/tracking' })
  for (const b of inventoryBalances(ctx)) {
    if (b.balance < 0) out.push({ level: 'danger', message: `رصيد ${b.productName} بالسالب (${b.balance}). راجع الوارد والصرف`, link: '/inventory' })
  }
  return out
}

/** Answers the PRD §25 questions for one month. */
export function dashboard(ctx: Ctx, monthArg?: string | null): DashboardSummary {
  const month = monthArg || latestOpenMonth(ctx)
  const cardCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cards')!.n
  const activeCardCount = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards WHERE status = 'active'")!.n
  const base: DashboardSummary = {
    month, cardCount, activeCardCount, membersTotal: 0, struckCount: 0, receivedCount: 0, fullCycleCount: 0,
    posTotalPiasters: 0, overagePiasters: 0, core: [], alerts: alerts(ctx, month)
  }
  if (!month) return base
  base.membersTotal = ctx.db.get<{ n: number | null }>('SELECT SUM(members) AS n FROM card_monthly_snapshots WHERE month = ?', [month])!.n ?? 0
  const statuses = [...monthStatuses(ctx, month).values()]
  base.struckCount = statuses.filter((s) => s.posStatus !== 'none').length
  base.receivedCount = statuses.filter((s) => s.receiptStatus !== 'none').length
  base.fullCycleCount = statuses.filter((s) => s.posStatus === 'struck' && s.receiptStatus === 'full').length
  const pos = ctx.db.get<{ total: number | null; overage: number | null }>(
    `SELECT SUM(total_piasters) AS total, SUM(CASE WHEN difference_piasters > 0 THEN difference_piasters ELSE 0 END) AS overage
     FROM pos_transactions WHERE month = ? AND status = 'active'`,
    [month]
  )!
  base.posTotalPiasters = pos.total ?? 0
  base.overagePiasters = pos.overage ?? 0
  const stock = new Map(inventoryBalances(ctx).map((b) => [b.productId, b.balance]))
  base.core = ctx.db.all<{ productId: number; productName: string; unit: string; entitled: number; delivered: number; struck: number }>(
    `SELECT p.id AS productId, p.name AS productName, p.unit,
       COALESCE((SELECT SUM(quantity) FROM citizen_ledger WHERE month = :m AND product_id = p.id AND entry_type IN ('entitlement', 'carry_in', 'pos_right')), 0) AS entitled,
       COALESCE((SELECT -SUM(quantity) FROM citizen_ledger WHERE month = :m AND product_id = p.id AND entry_type = 'delivery'), 0) AS delivered,
       COALESCE((SELECT SUM(i.quantity) FROM pos_transaction_items i JOIN pos_transactions t ON t.id = i.transaction_id
                 WHERE t.month = :m AND t.status = 'active' AND i.product_id = p.id), 0) AS struck
     FROM products p WHERE p.active = 1 ORDER BY p.sort_order, p.id`,
    { m: month }
  ).map((r) => ({ ...r, stock: stock.get(r.productId) ?? 0 }))
  return base
}

export function listAudit(ctx: Ctx, f: { entity?: string; limit?: number; offset?: number }): AuditEntry[] {
  return ctx.db.all<AuditEntry>(
    `SELECT a.id, a.at, u.display_name AS userName, a.action, a.entity, a.entity_id AS entityId, a.details
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ${f.entity ? 'WHERE a.entity = ?' : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...(f.entity ? [f.entity] : []), f.limit ?? 200, f.offset ?? 0]
  )
}
