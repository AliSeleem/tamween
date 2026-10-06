import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Role, User } from '@shared/types'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin, requireUser } from './context'

interface UserRow {
  id: number
  username: string
  display_name: string
  role: Role
  active: number
  must_change_password: number
  password_hash: string
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt') return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(expected, actual)
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    active: !!r.active,
    mustChangePassword: !!r.must_change_password
  }
}

export function login(ctx: Ctx, username: string, password: string): User {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ?', [username.trim()])
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
    throw new AppError('اسم المستخدم أو كلمة المرور غير صحيحة')
  }
  ctx.user = { id: row.id, role: row.role }
  audit(ctx, 'login', 'user', row.id)
  return toUser(row)
}

export function getUser(ctx: Ctx, id: number): User | null {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id])
  return row ? toUser(row) : null
}

export function changePassword(ctx: Ctx, oldPassword: string, newPassword: string): void {
  const u = requireUser(ctx)
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [u.id])!
  if (!verifyPassword(oldPassword, row.password_hash)) throw new AppError('كلمة المرور الحالية غير صحيحة')
  if (newPassword.length < 4) throw new AppError('كلمة المرور الجديدة قصيرة جدًا')
  ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(newPassword), u.id])
  audit(ctx, 'change_password', 'user', u.id)
}

export function listUsers(ctx: Ctx): User[] {
  requireAdmin(ctx)
  return ctx.db.all<UserRow>('SELECT * FROM users ORDER BY id').map(toUser)
}

export function saveUser(
  ctx: Ctx,
  input: { id?: number; username: string; displayName: string; role: Role; active: boolean; password?: string }
): User {
  requireAdmin(ctx)
  if (!input.username.trim() || !input.displayName.trim()) throw new AppError('اسم المستخدم والاسم الظاهر مطلوبان')
  return ctx.db.tx(() => {
    const dup = ctx.db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', [input.username.trim()])
    if (dup && dup.id !== input.id) throw new AppError('اسم المستخدم مستخدم بالفعل')
    let id = input.id
    if (id) {
      if (id === ctx.user!.id && (!input.active || input.role !== 'admin')) {
        throw new AppError('لا يمكنك إيقاف حسابك أو إزالة صلاحية المدير عنه')
      }
      ctx.db.run('UPDATE users SET username = ?, display_name = ?, role = ?, active = ? WHERE id = ?', [
        input.username.trim(), input.displayName.trim(), input.role, input.active ? 1 : 0, id
      ])
      if (input.password) {
        ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(input.password), id])
      }
      audit(ctx, 'update', 'user', id, { ...input, password: input.password ? '***' : undefined })
    } else {
      if (!input.password) throw new AppError('كلمة المرور مطلوبة للمستخدم الجديد')
      id = ctx.db.run(
        'INSERT INTO users (username, display_name, role, active, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [input.username.trim(), input.displayName.trim(), input.role, input.active ? 1 : 0, hashPassword(input.password)]
      ).lastId
      audit(ctx, 'create', 'user', id, { username: input.username, role: input.role })
    }
    return getUser(ctx, id)!
  })
}
