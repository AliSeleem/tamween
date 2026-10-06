import type { Card, CardHistoryEntry, CardInput, CardStatement, CardStatus, LedgerEntry } from '@shared/types'
import { normalizeDigits } from '@shared/util'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin, requireUser } from './context'
import { listDistributions } from './distribution'
import { cardRights } from './ledger'
import { includeCardInMonth, latestOpenMonth } from './periods'
import { listPosTransactions } from './pos'

interface CardRow {
  id: number
  card_number: string
  holder_name: string
  secret_ref: string | null
  bakery: string | null
  members: number
  status: CardStatus
  group_name: string | null
  created_at: string
  updated_at: string
}

export const toCard = (r: CardRow): Card => ({
  id: r.id,
  cardNumber: r.card_number,
  holderName: r.holder_name,
  secretRef: r.secret_ref,
  bakery: r.bakery,
  members: r.members,
  status: r.status,
  groupName: r.group_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function getCard(ctx: Ctx, id: number): Card {
  const r = ctx.db.get<CardRow>('SELECT * FROM cards WHERE id = ?', [id])
  if (!r) throw new AppError('البطاقة غير موجودة')
  return toCard(r)
}

export function findCardByNumber(ctx: Ctx, cardNumber: string): Card | null {
  const r = ctx.db.get<CardRow>('SELECT * FROM cards WHERE card_number = ?', [normalizeDigits(cardNumber).trim()])
  return r ? toCard(r) : null
}

/** Search by card number (prefix) or holder name (contains). Exact card-number matches come first. */
export function searchCards(ctx: Ctx, args: { query?: string; status?: CardStatus | 'all'; limit?: number; offset?: number }): { rows: Card[]; total: number } {
  const q = normalizeDigits(args.query ?? '').trim()
  const where: string[] = []
  const params: Record<string, string | number> = {}
  if (q) {
    where.push("(card_number LIKE :prefix OR holder_name LIKE :contains OR secret_ref = :exact)")
    params.prefix = `${q}%`
    params.contains = `%${q}%`
    params.exact = q
  }
  if (args.status && args.status !== 'all') {
    where.push('status = :status')
    params.status = args.status
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cards ${w}`, params)!.n
  const order = q ? 'CASE WHEN card_number = :exactNum THEN 0 ELSE 1 END, card_number' : 'card_number'
  if (q) params.exactNum = q
  const rows = ctx.db.all<CardRow>(`SELECT * FROM cards ${w} ORDER BY ${order} LIMIT :limit OFFSET :offset`, {
    ...params,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0
  })
  return { rows: rows.map(toCard), total }
}

function validate(input: CardInput): CardInput {
  const cardNumber = normalizeDigits(String(input.cardNumber ?? '')).trim()
  const holderName = String(input.holderName ?? '').trim()
  if (!cardNumber) throw new AppError('رقم البطاقة مطلوب')
  if (!holderName) throw new AppError('اسم صاحب البطاقة مطلوب')
  if (!Number.isInteger(input.members) || input.members < 1 || input.members > 30) throw new AppError('عدد الأفراد غير صحيح')
  if (!['active', 'suspended', 'cancelled'].includes(input.status)) throw new AppError('حالة البطاقة غير صحيحة')
  const clean = (s: string | null | undefined): string | null => (s && String(s).trim() ? normalizeDigits(String(s)).trim() : null)
  return {
    cardNumber,
    holderName,
    secretRef: clean(input.secretRef),
    bakery: clean(input.bakery),
    members: input.members,
    status: input.status,
    groupName: clean(input.groupName)
  }
}

export function createCard(ctx: Ctx, input: CardInput, source = 'manual'): Card {
  requireUser(ctx)
  const c = validate(input)
  return ctx.db.tx(() => {
    if (findCardByNumber(ctx, c.cardNumber)) throw new AppError(`رقم البطاقة ${c.cardNumber} مسجل من قبل`)
    const id = ctx.db.run(
      'INSERT INTO cards (card_number, holder_name, secret_ref, bakery, members, status, group_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.cardNumber, c.holderName, c.secretRef, c.bakery, c.members, c.status, c.groupName]
    ).lastId
    // A card added while a month is running joins that month with its current members.
    const open = latestOpenMonth(ctx)
    if (open && c.status === 'active') includeCardInMonth(ctx, id, open)
    audit(ctx, 'create', 'card', id, { ...c, source })
    return getCard(ctx, id)
  })
}

const FIELD_COLUMNS: Record<keyof CardInput, string> = {
  cardNumber: 'card_number',
  holderName: 'holder_name',
  secretRef: 'secret_ref',
  bakery: 'bakery',
  members: 'members',
  status: 'status',
  groupName: 'group_name'
}

/**
 * Updates a card and records each changed field in card_history. A members change does not touch
 * months already opened: their snapshot keeps the count from the start of the month.
 */
export function updateCard(ctx: Ctx, id: number, input: CardInput, reason?: string): Card {
  const user = requireUser(ctx)
  const c = validate(input)
  return ctx.db.tx(() => {
    const before = getCard(ctx, id)
    if (c.cardNumber !== before.cardNumber) {
      if (user.role !== 'admin') throw new AppError('تغيير رقم البطاقة يحتاج صلاحية المدير')
      if (findCardByNumber(ctx, c.cardNumber)) throw new AppError(`رقم البطاقة ${c.cardNumber} مسجل من قبل`)
    }
    const changes: { field: string; old: unknown; new: unknown }[] = []
    for (const key of Object.keys(FIELD_COLUMNS) as (keyof CardInput)[]) {
      if (before[key] !== c[key]) changes.push({ field: key, old: before[key], new: c[key] })
    }
    if (!changes.length) return before
    const sets = changes.map((ch) => `${FIELD_COLUMNS[ch.field as keyof CardInput]} = ?`).join(', ')
    ctx.db.run(`UPDATE cards SET ${sets}, updated_at = datetime('now', 'localtime') WHERE id = ?`, [
      ...changes.map((ch) => ch.new as string | number | null),
      id
    ])
    for (const ch of changes) {
      ctx.db.run('INSERT INTO card_history (card_id, field, old_value, new_value, reason, user_id) VALUES (?, ?, ?, ?, ?, ?)', [
        id, ch.field, ch.old == null ? null : String(ch.old), ch.new == null ? null : String(ch.new), reason ?? null, user.id
      ])
    }
    audit(ctx, 'update', 'card', id, { changes, reason })
    return getCard(ctx, id)
  })
}

export function cardHistory(ctx: Ctx, id: number): CardHistoryEntry[] {
  return ctx.db.all<CardHistoryEntry>(
    `SELECT h.id, h.field, h.old_value AS oldValue, h.new_value AS newValue, h.reason, u.display_name AS userName, h.changed_at AS changedAt
     FROM card_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.card_id = ? ORDER BY h.id DESC`,
    [id]
  )
}

export function cardStatement(ctx: Ctx, id: number): CardStatement {
  const card = getCard(ctx, id)
  return {
    card,
    snapshots: ctx.db.all(
      'SELECT month, members, value_piasters AS valuePiasters FROM card_monthly_snapshots WHERE card_id = ? ORDER BY month DESC',
      [id]
    ),
    rights: cardRights(ctx, id),
    ledger: ctx.db.all<LedgerEntry>(
      `SELECT l.id, l.month, p.name AS productName, l.entry_type AS entryType, l.quantity, l.note,
         u.display_name AS userName, l.created_at AS createdAt
       FROM citizen_ledger l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.user_id
       WHERE l.card_id = ? ORDER BY l.id DESC`,
      [id]
    ),
    posTransactions: listPosTransactions(ctx, { cardId: id }),
    distributions: listDistributions(ctx, { cardId: id }),
    history: cardHistory(ctx, id)
  }
}

export function includeCard(ctx: Ctx, cardId: number, month: string): void {
  requireAdmin(ctx)
  ctx.db.tx(() => {
    const p = ctx.db.get<{ status: string }>('SELECT status FROM periods WHERE month = ?', [month])
    if (!p || p.status !== 'open') throw new AppError('الشهر غير مفتوح')
    if (!includeCardInMonth(ctx, cardId, month)) throw new AppError('البطاقة مدرجة في هذا الشهر بالفعل')
    audit(ctx, 'include_in_month', 'card', cardId, { month })
  })
}
