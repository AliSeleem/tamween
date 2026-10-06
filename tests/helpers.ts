import { createHandlers } from '../src/main/api'
import { Db } from '../src/main/db/db'
import type { Ctx } from '../src/main/services/context'
import { seedIfEmpty } from '../src/main/services/seed'
import type { ApiArgs, ApiMethod, ApiResult } from '../src/shared/api'

export function setup() {
  const db = new Db(':memory:')
  seedIfEmpty(db)
  const ctx: Ctx = { db, user: null }
  const handlers = createHandlers(ctx, { pickImportFile: async () => null, pickBackupPath: async () => null })
  const call = <K extends ApiMethod>(method: K, args: ApiArgs<K>): ApiResult<K> => {
    const r = (handlers[method] as (a: ApiArgs<K>) => ApiResult<K> | Promise<ApiResult<K>>)(args)
    if (r instanceof Promise) throw new Error('use callAsync for async methods')
    return r
  }
  call('auth.login', { username: 'admin', password: 'admin' })
  const products = call('products.list', undefined)
  const pid = (name: string): number => products.find((p) => p.name === name)!.id
  return { db, ctx, call, sugar: pid('سكر'), oil: pid('زيت'), pasta: pid('مكرونة'), cheese: pid('جبنة') }
}

export type Env = ReturnType<typeof setup>

export function addCard(env: Env, cardNumber: string, members: number) {
  return env.call('cards.create', { cardNumber, holderName: `مواطن ${cardNumber}`, secretRef: null, bakery: null, members, status: 'active', groupName: null })
}

/** Opens a month with sugar 9.00 / oil 30.00 / pasta 10.00 and card value 49.25 per member. */
export function openMonth(env: Env, month: string) {
  env.call('periods.open', { month })
  const cfg = env.call('periods.config', { month })
  env.call('periods.saveConfig', {
    ...cfg,
    cardValues: [1, 2, 3, 4, 5, 6, 7].map((m) => ({ members: m, valuePiasters: 4925 * m })),
    prices: [
      { productId: env.sugar, pricePiasters: 900 },
      { productId: env.oil, pricePiasters: 3000 },
      { productId: env.pasta, pricePiasters: 1000 },
      { productId: env.cheese, pricePiasters: 1250 }
    ]
  })
}

export function rights(env: Env, cardId: number, month: string, productId: number) {
  return env.call('cards.monthContext', { cardId, month }).rights.find((r) => r.productId === productId)
}
