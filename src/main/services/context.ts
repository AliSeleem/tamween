import type { Role } from '@shared/types'
import type { Db } from '../db/db'

export interface Ctx {
  db: Db
  user: { id: number; role: Role } | null
}

/** An error whose message is shown to the user as-is (Arabic). */
export class AppError extends Error {}

export function requireUser(ctx: Ctx): { id: number; role: Role } {
  if (!ctx.user) throw new AppError('يجب تسجيل الدخول أولاً')
  return ctx.user
}

export function requireAdmin(ctx: Ctx): { id: number; role: Role } {
  const u = requireUser(ctx)
  if (u.role !== 'admin') throw new AppError('هذه العملية تحتاج صلاحية المدير')
  return u
}

export function audit(ctx: Ctx, action: string, entity: string, entityId: number | string | null, details?: unknown): void {
  ctx.db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)', [
    ctx.user?.id ?? null,
    action,
    entity,
    entityId == null ? null : String(entityId),
    details === undefined ? null : JSON.stringify(details)
  ])
}

export function nowIso(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function assertPositiveInt(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new AppError(`${what} يجب أن يكون رقمًا صحيحًا أكبر من صفر`)
  return n
}
