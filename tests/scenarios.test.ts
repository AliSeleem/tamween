import { describe, expect, it } from 'vitest'
import { addCard, openMonth, rights, setup } from './helpers'

describe('monthly entitlement', () => {
  it('uses the PRD table and the members count frozen at the start of the month', () => {
    const env = setup()
    const card = addCard(env, '1001', 4)
    openMonth(env, '2026-09')
    expect(rights(env, card.id, '2026-09', env.sugar)!.entitled).toBe(4)
    expect(rights(env, card.id, '2026-09', env.oil)!.entitled).toBe(4)

    // Members change during September does not change September.
    env.call('cards.update', { id: card.id, card: { ...card, members: 5 }, reason: 'مولود جديد' })
    expect(rights(env, card.id, '2026-09', env.sugar)!.entitled).toBe(4)
    expect(env.call('cards.monthContext', { cardId: card.id, month: '2026-09' }).snapshotMembers).toBe(4)

    // October uses 5 members: 5 sugar + 4 oil.
    env.call('periods.close', { month: '2026-09' })
    openMonth(env, '2026-10')
    expect(rights(env, card.id, '2026-10', env.sugar)!.entitled).toBe(5)
    expect(rights(env, card.id, '2026-10', env.oil)!.entitled).toBe(4)
    expect(env.call('cards.statement', { id: card.id }).history[0]).toMatchObject({ field: 'members', oldValue: '4', newValue: '5' })
  })

  it('caps at the highest defined row for large families', () => {
    const env = setup()
    const card = addCard(env, '1002', 9)
    openMonth(env, '2026-09')
    expect(rights(env, card.id, '2026-09', env.sugar)!.entitled).toBe(6)
    expect(rights(env, card.id, '2026-09', env.oil)!.entitled).toBe(4)
  })

  it('rule edits on an open month adjust entitlements through ledger rows', () => {
    const env = setup()
    const card = addCard(env, '1003', 2)
    openMonth(env, '2026-09')
    const cfg = env.call('periods.config', { month: '2026-09' })
    env.call('periods.saveConfig', {
      ...cfg,
      rules: cfg.rules.map((r) => (r.productId === env.sugar && r.members === 2 ? { ...r, quantity: 3 } : r))
    })
    expect(rights(env, card.id, '2026-09', env.sugar)!.entitled).toBe(3)
    const entries = env.call('cards.statement', { id: card.id }).ledger.filter((l) => l.entryType === 'entitlement' && l.productName === 'سكر')
    expect(entries.map((e) => e.quantity).sort()).toEqual([1, 2])
  })
})

describe('PRD §22 scenarios', () => {
  function prepared() {
    const env = setup()
    const card = addCard(env, '2001', 2)
    openMonth(env, '2026-10')
    const batch = env.call('pos.createBatch', { month: '2026-10' })
    env.call('inventory.record', { productId: env.sugar, type: 'opening', quantity: 100 })
    env.call('inventory.record', { productId: env.oil, type: 'opening', quantity: 100 })
    env.call('inventory.record', { productId: env.pasta, type: 'opening', quantity: 100 })
    return { env, card, batch }
  }

  it('1: strike then receive completes the cycle and moves stock', () => {
    const { env, card, batch } = prepared()
    env.call('pos.record', {
      batchId: batch.id, cardId: card.id, executedAt: '2026-10-05',
      items: [{ productId: env.sugar, quantity: 2, unitPricePiasters: 900 }, { productId: env.oil, quantity: 2, unitPricePiasters: 3000 }, { productId: env.pasta, quantity: 2, unitPricePiasters: 1000 }]
    })
    let ctx = env.call('cards.monthContext', { cardId: card.id, month: '2026-10' })
    expect(ctx.posStatus).toBe('struck')
    expect(ctx.receiptStatus).toBe('none')
    expect(rights(env, card.id, '2026-10', env.pasta)!.remaining).toBe(2) // pasta right comes from the strike

    env.call('distribution.record', {
      cardId: card.id, month: '2026-10',
      items: [{ productId: env.sugar, quantity: 2, appliesToMonth: '2026-10' }, { productId: env.oil, quantity: 2, appliesToMonth: '2026-10' }, { productId: env.pasta, quantity: 2, appliesToMonth: '2026-10' }]
    })
    ctx = env.call('cards.monthContext', { cardId: card.id, month: '2026-10' })
    expect(ctx.receiptStatus).toBe('full')
    expect(ctx.rights.every((r) => r.remaining === 0)).toBe(true)
    const stock = env.call('inventory.balances', {})
    expect(stock.find((s) => s.productId === env.sugar)!.balance).toBe(98)
    expect(stock.find((s) => s.productId === env.pasta)!.balance).toBe(98)
  })

  it('2: receive before strike shows "received not struck", then links when struck', () => {
    const { env, card, batch } = prepared()
    env.call('distribution.record', {
      cardId: card.id, month: '2026-10', distributedAt: '2026-10-11',
      items: [{ productId: env.sugar, quantity: 2, appliesToMonth: '2026-10' }, { productId: env.oil, quantity: 2, appliesToMonth: '2026-10' }]
    })
    let t = env.call('tracking.list', { month: '2026-10', filter: 'received_not_struck' })
    expect(t.rows.map((r) => r.cardId)).toEqual([card.id])
    expect(t.rows[0].needsLink).toBe(true)
    expect(t.rows[0].posStatus).toBe('none')

    env.call('pos.record', {
      batchId: batch.id, cardId: card.id, executedAt: '2026-10-15',
      items: [{ productId: env.sugar, quantity: 2, unitPricePiasters: 900 }, { productId: env.oil, quantity: 2, unitPricePiasters: 3000 }]
    })
    t = env.call('tracking.list', { month: '2026-10', filter: 'struck_and_received' })
    expect(t.rows[0]).toMatchObject({ cardId: card.id, posStatus: 'struck', receiptStatus: 'full', needsLink: false })
  })

  it('3: strike without receipt keeps the right visible', () => {
    const { env, card, batch } = prepared()
    env.call('pos.record', {
      batchId: batch.id, cardId: card.id, executedAt: '2026-10-05',
      items: [{ productId: env.sugar, quantity: 2, unitPricePiasters: 900 }, { productId: env.oil, quantity: 2, unitPricePiasters: 3000 }]
    })
    const t = env.call('tracking.list', { month: '2026-10', filter: 'struck_not_received' })
    expect(t.rows[0]).toMatchObject({ cardId: card.id, remainingUnits: 4 })
    expect(t.counts.has_balance).toBe(1)
  })

  it('4: partial receipt leaves the rest as balance and blocks over-delivery', () => {
    const { env, card } = prepared()
    env.call('distribution.record', { cardId: card.id, month: '2026-10', items: [{ productId: env.sugar, quantity: 1, appliesToMonth: '2026-10' }] })
    const ctx = env.call('cards.monthContext', { cardId: card.id, month: '2026-10' })
    expect(ctx.receiptStatus).toBe('partial')
    expect(rights(env, card.id, '2026-10', env.sugar)!.remaining).toBe(1)
    expect(() =>
      env.call('distribution.record', { cardId: card.id, month: '2026-10', items: [{ productId: env.sugar, quantity: 2, appliesToMonth: '2026-10' }] })
    ).toThrow(/أكبر من المتبقي/)
  })

  it('5: strike above card value is a settlement difference, summed per batch', () => {
    const { env, card, batch } = prepared()
    // Card value for 2 members is 98.50. Strike 100.50: 2 sugar (18) + 2 oil (60) + 2 pasta (20) + 2.50 extra via price.
    const tx = env.call('pos.record', {
      batchId: batch.id, cardId: card.id, executedAt: '2026-10-05',
      items: [{ productId: env.sugar, quantity: 2, unitPricePiasters: 900 }, { productId: env.oil, quantity: 2, unitPricePiasters: 3000 }, { productId: env.cheese, quantity: 2, unitPricePiasters: 1125 }]
    })
    expect(tx.entitledValuePiasters).toBe(9850)
    expect(tx.totalPiasters).toBe(10050)
    expect(tx.differencePiasters).toBe(200)

    for (let i = 0; i < 9; i++) {
      const c = env.call('cards.create', { cardNumber: `3${i}`, holderName: 'x', secretRef: null, bakery: null, members: 2, status: 'active', groupName: null })
      env.call('pos.record', {
        batchId: batch.id, cardId: c.id, executedAt: '2026-10-05',
        items: [{ productId: env.sugar, quantity: 2, unitPricePiasters: 900 }, { productId: env.oil, quantity: 2, unitPricePiasters: 3000 }, { productId: env.cheese, quantity: 2, unitPricePiasters: 1125 }]
      })
    }
    const s = env.call('pos.batchSummary', { id: batch.id })
    expect(s.overagePiasters).toBe(2000) // ten cards x 2.00 = 20.00
    expect(s.sugarUsed).toBe(20)
    expect(s.oilUsed).toBe(20)
    expect(s.moneyUsedPiasters).toBe(100500)
  })
})

describe('batch limits and duplicate strikes', () => {
  it('rejects strikes that would exceed the sugar limit or repeat a card', () => {
    const env = setup()
    const a = addCard(env, '4001', 4)
    const b = addCard(env, '4002', 4)
    openMonth(env, '2026-10')
    const batch = env.call('pos.createBatch', { month: '2026-10', sugarLimit: 6 })
    const items = [{ productId: env.sugar, quantity: 4, unitPricePiasters: 900 }]
    env.call('pos.record', { batchId: batch.id, cardId: a.id, executedAt: '2026-10-01', items })
    expect(() => env.call('pos.record', { batchId: batch.id, cardId: b.id, executedAt: '2026-10-01', items })).toThrow(/حد السكر/)
    expect(() => env.call('pos.record', { batchId: batch.id, cardId: a.id, executedAt: '2026-10-01', items: [{ productId: env.oil, quantity: 1, unitPricePiasters: 3000 }] })).toThrow(/مضروبة من قبل/)
  })

  it('voiding a strike reverses its rights and frees the batch', () => {
    const env = setup()
    const a = addCard(env, '4101', 2)
    openMonth(env, '2026-10')
    const batch = env.call('pos.createBatch', { month: '2026-10' })
    const tx = env.call('pos.record', { batchId: batch.id, cardId: a.id, executedAt: '2026-10-01', items: [{ productId: env.pasta, quantity: 3, unitPricePiasters: 1000 }] })
    expect(rights(env, a.id, '2026-10', env.pasta)!.remaining).toBe(3)
    env.call('pos.void', { id: tx.id, reason: 'خطأ إدخال' })
    expect(rights(env, a.id, '2026-10', env.pasta)!.remaining).toBe(0)
    expect(env.call('pos.batchSummary', { id: batch.id }).moneyUsedPiasters).toBe(0)
    expect(env.call('cards.monthContext', { cardId: a.id, month: '2026-10' }).posStatus).toBe('none')
  })
})

describe('carry-over and advance', () => {
  it('closing a month carries unreceived balance into the next month', () => {
    const env = setup()
    const card = addCard(env, '5001', 4)
    openMonth(env, '2026-09')
    env.call('distribution.record', { cardId: card.id, month: '2026-09', items: [{ productId: env.sugar, quantity: 3, appliesToMonth: '2026-09' }, { productId: env.oil, quantity: 4, appliesToMonth: '2026-09' }] })
    env.call('periods.close', { month: '2026-09' })
    const sep = rights(env, card.id, '2026-09', env.sugar)!
    expect(sep).toMatchObject({ remaining: 0, carriedOut: 1 })
    openMonth(env, '2026-10')
    expect(rights(env, card.id, '2026-10', env.sugar)).toMatchObject({ carriedIn: 1, entitled: 4, remaining: 5 })
  })

  it('products that do not allow carry-over expire at close', () => {
    const env = setup()
    const card = addCard(env, '5002', 1)
    const oil = env.call('products.list', undefined).find((p) => p.id === env.oil)!
    env.call('products.save', { ...oil, carryoverAllowed: false })
    openMonth(env, '2026-09')
    env.call('periods.close', { month: '2026-09' })
    expect(rights(env, card.id, '2026-09', env.oil)).toMatchObject({ expired: 1, remaining: 0 })
  })

  it('an advance is deducted from next month', () => {
    const env = setup()
    const card = addCard(env, '5003', 2)
    openMonth(env, '2026-09')
    env.call('distribution.record', { cardId: card.id, month: '2026-09', items: [{ productId: env.oil, quantity: 2, appliesToMonth: '2026-09' }] })
    env.call('distribution.record', { cardId: card.id, month: '2026-09', items: [{ productId: env.oil, quantity: 1, appliesToMonth: '2026-10' }] })
    expect(env.call('cards.monthContext', { cardId: card.id, month: '2026-09' }).nextMonthRights[0]).toMatchObject({ delivered: 1, remaining: -1 })
    openMonth(env, '2026-10')
    expect(rights(env, card.id, '2026-10', env.oil)).toMatchObject({ entitled: 2, delivered: 1, remaining: 1 })
  })
})

describe('inventory', () => {
  it('follows balance = opening + receipts + returns - distributed - damaged ± stocktake', () => {
    const env = setup()
    env.call('inventory.record', { productId: env.sugar, type: 'opening', quantity: 50 })
    env.call('inventory.record', { productId: env.sugar, type: 'receipt', quantity: 954, documentRef: 'INV-1' })
    env.call('inventory.record', { productId: env.sugar, type: 'return', quantity: 2 })
    const dmg = env.call('inventory.record', { productId: env.sugar, type: 'damage', quantity: 3, note: 'كيس مقطوع' })
    expect(env.call('inventory.stocktake', { productId: env.sugar, counted: 1000 })).toEqual({ difference: -3 })
    const b = env.call('inventory.balances', {}).find((x) => x.productId === env.sugar)!
    expect(b).toMatchObject({ opening: 50, receipts: 954, returns: 2, damaged: 3, stocktake: -3, balance: 1000 })
    env.call('inventory.reverse', { id: dmg, reason: 'تم إعادة التعبئة بدون فقد' })
    expect(env.call('inventory.balances', {}).find((x) => x.productId === env.sugar)!.balance).toBe(1003)
    expect(() => env.call('inventory.reverse', { id: dmg, reason: 'مرة أخرى' })).toThrow(/معكوسة/)
  })
})

describe('permissions and audit', () => {
  it('clerks cannot void or change rules, and every operation is audited', () => {
    const env = setup()
    env.call('users.save', { username: 'clerk', displayName: 'موظف', role: 'clerk', active: true, password: 'pass1' })
    env.call('auth.logout', undefined)
    env.call('auth.login', { username: 'clerk', password: 'pass1' })
    expect(() => env.call('periods.open', { month: '2026-10' })).toThrow(/صلاحية المدير/)
    expect(() => env.call('pos.void', { id: 1, reason: 'x' })).toThrow(/صلاحية المدير/)
    addCard(env, '6001', 3)
    env.call('auth.logout', undefined)
    env.call('auth.login', { username: 'admin', password: 'admin' })
    const log = env.call('audit.list', {})
    expect(log.some((l) => l.entity === 'card' && l.action === 'create' && l.userName === 'موظف')).toBe(true)
  })
})
