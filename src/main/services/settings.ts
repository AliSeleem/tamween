import type { AppSettings } from '@shared/types'
import type { Ctx } from './context'
import { audit, requireAdmin } from './context'

export const DEFAULT_SETTINGS: AppSettings = {
  shopName: 'محل التموين',
  defaultMoneyLimitPiasters: 4_710_000,
  defaultSugarLimit: 954,
  defaultOilLimit: 876,
  alertThresholdPercent: 90
}

export function getSettings(ctx: Ctx): AppSettings {
  const rows = ctx.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value)
  return out as unknown as AppSettings
}

export function saveSettings(ctx: Ctx, patch: Partial<AppSettings>): AppSettings {
  requireAdmin(ctx)
  ctx.db.tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue
      ctx.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, JSON.stringify(v)])
    }
    audit(ctx, 'update', 'settings', null, patch)
  })
  return getSettings(ctx)
}
