import type { Period, PeriodConfig } from '@shared/types'
import { addMonths, isMonth } from '@shared/util'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin } from './context'
import { addLedger } from './ledger'
import { productIdByLimitKey } from './products'
import { DEFAULT_CORE_RULES } from './seed'

export function listPeriods(ctx: Ctx): Period[] {
  return ctx.db
    .all<{ month: string; status: 'open' | 'closed'; opened_at: string; closed_at: string | null; card_count: number }>(
      `SELECT p.month, p.status, p.opened_at, p.closed_at,
         (SELECT COUNT(*) FROM card_monthly_snapshots s WHERE s.month = p.month) AS card_count
       FROM periods p ORDER BY p.month DESC`
    )
    .map((r) => ({ month: r.month, status: r.status, openedAt: r.opened_at, closedAt: r.closed_at, cardCount: r.card_count }))
}

export function getPeriod(ctx: Ctx, month: string): Period | null {
  return listPeriods(ctx).find((p) => p.month === month) ?? null
}

export function requireOpenPeriod(ctx: Ctx, month: string): void {
  const p = ctx.db.get<{ status: string }>('SELECT status FROM periods WHERE month = ?', [month])
  if (!p) throw new AppError(`شهر ${month} غير مفتوح في النظام`)
  if (p.status !== 'open') throw new AppError(`شهر ${month} مغلق ولا يقبل عمليات جديدة`)
}

export function latestOpenMonth(ctx: Ctx): string | null {
  return ctx.db.get<{ month: string }>("SELECT month FROM periods WHERE status = 'open' ORDER BY month DESC LIMIT 1")?.month ?? null
}

export function getConfig(ctx: Ctx, month: string): PeriodConfig {
  return {
    month,
    rules: ctx.db.all<{ productId: number; members: number; quantity: number }>(
      'SELECT product_id AS productId, members, quantity FROM entitlement_rules WHERE month = ? ORDER BY product_id, members',
      [month]
    ),
    cardValues: ctx.db.all<{ members: number; valuePiasters: number }>(
      'SELECT members, value_piasters AS valuePiasters FROM card_value_rules WHERE month = ? ORDER BY members',
      [month]
    ),
    prices: ctx.db.all<{ productId: number; pricePiasters: number }>(
      'SELECT product_id AS productId, price_piasters AS pricePiasters FROM product_prices WHERE month = ? ORDER BY product_id',
      [month]
    )
  }
}

/** The row for the largest members count not above `members` (a 9-member card uses the 7-member row). */
function byMembers<T extends { members: number }>(rows: T[], members: number): T | undefined {
  let best: T | undefined
  for (const r of rows) if (r.members <= members && (!best || r.members > best.members)) best = r
  return best
}

export function entitlementsFor(config: PeriodConfig, members: number): Map<number, number> {
  const out = new Map<number, number>()
  const productIds = new Set(config.rules.map((r) => r.productId))
  for (const pid of productIds) {
    const q = byMembers(config.rules.filter((r) => r.productId === pid), members)?.quantity ?? 0
    if (q > 0) out.set(pid, q)
  }
  return out
}

export function cardValueFor(config: PeriodConfig, members: number): number | null {
  return byMembers(config.cardValues, members)?.valuePiasters ?? null
}

function writeConfig(ctx: Ctx, config: PeriodConfig): void {
  const m = config.month
  ctx.db.run('DELETE FROM entitlement_rules WHERE month = ?', [m])
  ctx.db.run('DELETE FROM card_value_rules WHERE month = ?', [m])
  ctx.db.run('DELETE FROM product_prices WHERE month = ?', [m])
  for (const r of config.rules) {
    if (!Number.isInteger(r.members) || r.members < 1 || !Number.isInteger(r.quantity) || r.quantity < 0) {
      throw new AppError('قيم قواعد الاستحقاق غير صحيحة')
    }
    ctx.db.run('INSERT INTO entitlement_rules (month, product_id, members, quantity) VALUES (?, ?, ?, ?)', [m, r.productId, r.members, r.quantity])
  }
  for (const v of config.cardValues) {
    if (!Number.isInteger(v.members) || v.members < 1 || !Number.isInteger(v.valuePiasters) || v.valuePiasters < 0) {
      throw new AppError('قيم البطاقة غير صحيحة')
    }
    ctx.db.run('INSERT INTO card_value_rules (month, members, value_piasters) VALUES (?, ?, ?)', [m, v.members, v.valuePiasters])
  }
  for (const p of config.prices) {
    if (!Number.isInteger(p.pricePiasters) || p.pricePiasters < 0) throw new AppError('سعر الصنف غير صحيح')
    ctx.db.run('INSERT INTO product_prices (month, product_id, price_piasters) VALUES (?, ?, ?)', [m, p.productId, p.pricePiasters])
  }
}

function defaultConfig(ctx: Ctx, month: string): PeriodConfig {
  const prev = ctx.db.get<{ month: string }>(
    'SELECT month FROM entitlement_rules WHERE month < ? UNION SELECT month FROM product_prices WHERE month < ? ORDER BY month DESC LIMIT 1',
    [month, month]
  )
  if (prev) return { ...getConfig(ctx, prev.month), month }
  const sugar = productIdByLimitKey(ctx, 'sugar')
  const oil = productIdByLimitKey(ctx, 'oil')
  const rules: PeriodConfig['rules'] = []
  for (const [members, [s, o]] of Object.entries(DEFAULT_CORE_RULES)) {
    if (sugar) rules.push({ productId: sugar, members: Number(members), quantity: s })
    if (oil) rules.push({ productId: oil, members: Number(members), quantity: o })
  }
  return { month, rules, cardValues: [], prices: [] }
}

/** Freezes the card's members for the month and writes its entitlement rows. No-op if already included. */
export function includeCardInMonth(ctx: Ctx, cardId: number, month: string, config = getConfig(ctx, month)): boolean {
  if (ctx.db.get('SELECT 1 FROM card_monthly_snapshots WHERE month = ? AND card_id = ?', [month, cardId])) return false
  const card = ctx.db.get<{ members: number }>('SELECT members FROM cards WHERE id = ?', [cardId])
  if (!card) throw new AppError('البطاقة غير موجودة')
  ctx.db.run('INSERT INTO card_monthly_snapshots (month, card_id, members, value_piasters) VALUES (?, ?, ?, ?)', [
    month, cardId, card.members, cardValueFor(config, card.members)
  ])
  for (const [productId, qty] of entitlementsFor(config, card.members)) {
    addLedger(ctx, { cardId, month, productId, type: 'entitlement', quantity: qty, refType: 'period', note: 'استحقاق الشهر' })
  }
  return true
}

export function openPeriod(ctx: Ctx, month: string): Period {
  requireAdmin(ctx)
  if (!isMonth(month)) throw new AppError('صيغة الشهر غير صحيحة')
  return ctx.db.tx(() => {
    if (ctx.db.get('SELECT 1 FROM periods WHERE month = ?', [month])) throw new AppError('هذا الشهر مفتوح من قبل')
    const config = defaultConfig(ctx, month)
    writeConfig(ctx, config)
    ctx.db.run("INSERT INTO periods (month, status, opened_by) VALUES (?, 'open', ?)", [month, ctx.user!.id])
    const cards = ctx.db.all<{ id: number }>("SELECT id FROM cards WHERE status = 'active'")
    for (const c of cards) includeCardInMonth(ctx, c.id, month, config)
    audit(ctx, 'open', 'period', month, { cards: cards.length })
    return getPeriod(ctx, month)!
  })
}

/**
 * Replaces the month's rules, card values and prices. For an open month, existing entitlements are brought
 * in line by writing difference rows, so the history of what changed stays in the ledger.
 */
export function savePeriodConfig(ctx: Ctx, config: PeriodConfig): PeriodConfig {
  requireAdmin(ctx)
  return ctx.db.tx(() => {
    requireOpenPeriod(ctx, config.month)
    const before = getConfig(ctx, config.month)
    writeConfig(ctx, config)
    const snaps = ctx.db.all<{ card_id: number; members: number }>('SELECT card_id, members FROM card_monthly_snapshots WHERE month = ?', [config.month])
    let adjusted = 0
    for (const s of snaps) {
      ctx.db.run('UPDATE card_monthly_snapshots SET value_piasters = ? WHERE month = ? AND card_id = ?', [
        cardValueFor(config, s.members), config.month, s.card_id
      ])
      const desired = entitlementsFor(config, s.members)
      const current = new Map(
        ctx.db
          .all<{ product_id: number; q: number }>(
            "SELECT product_id, SUM(quantity) AS q FROM citizen_ledger WHERE card_id = ? AND month = ? AND entry_type = 'entitlement' GROUP BY product_id",
            [s.card_id, config.month]
          )
          .map((r) => [r.product_id, r.q])
      )
      for (const pid of new Set([...desired.keys(), ...current.keys()])) {
        const delta = (desired.get(pid) ?? 0) - (current.get(pid) ?? 0)
        if (delta !== 0) {
          addLedger(ctx, { cardId: s.card_id, month: config.month, productId: pid, type: 'entitlement', quantity: delta, refType: 'rules', note: 'تعديل قواعد الاستحقاق' })
          adjusted++
        }
      }
    }
    audit(ctx, 'update_config', 'period', config.month, { before, after: config, adjustedEntries: adjusted })
    return getConfig(ctx, config.month)
  })
}

/**
 * Closes the month. Each card's remaining balance moves to next month as carry_out/carry_in rows, or expires
 * when the product does not allow carrying over. Negative balances (taken ahead) always carry.
 */
export function closePeriod(ctx: Ctx, month: string): Period {
  requireAdmin(ctx)
  return ctx.db.tx(() => {
    requireOpenPeriod(ctx, month)
    if (ctx.db.get("SELECT 1 FROM pos_batches WHERE month = ? AND status = 'open'", [month])) {
      throw new AppError('أغلق دفعات الضرب المفتوحة لهذا الشهر أولاً')
    }
    const next = addMonths(month, 1)
    const balances = ctx.db.all<{ card_id: number; product_id: number; remaining: number; carryover_allowed: number }>(
      `SELECT l.card_id, l.product_id, SUM(l.quantity) AS remaining, p.carryover_allowed
       FROM citizen_ledger l JOIN products p ON p.id = l.product_id
       WHERE l.month = ? GROUP BY l.card_id, l.product_id HAVING SUM(l.quantity) <> 0`,
      [month]
    )
    let carried = 0
    let expired = 0
    for (const b of balances) {
      if (b.remaining > 0 && !b.carryover_allowed) {
        addLedger(ctx, { cardId: b.card_id, month, productId: b.product_id, type: 'expire', quantity: -b.remaining, refType: 'period_close', note: 'انتهاء الرصيد بإغلاق الشهر' })
        expired++
      } else {
        addLedger(ctx, { cardId: b.card_id, month, productId: b.product_id, type: 'carry_out', quantity: -b.remaining, refType: 'period_close', note: `ترحيل إلى ${next}` })
        addLedger(ctx, { cardId: b.card_id, month: next, productId: b.product_id, type: 'carry_in', quantity: b.remaining, refType: 'period_close', note: `مرحل من ${month}` })
        carried++
      }
    }
    ctx.db.run("UPDATE periods SET status = 'closed', closed_at = datetime('now', 'localtime'), closed_by = ? WHERE month = ?", [ctx.user!.id, month])
    audit(ctx, 'close', 'period', month, { carried, expired })
    return getPeriod(ctx, month)!
  })
}
