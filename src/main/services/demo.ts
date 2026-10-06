import { addMonths, currentMonth, todayIso } from '@shared/util'
import { createCard } from './cards'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin } from './context'
import { recordDistribution } from './distribution'
import { recordMovement } from './inventory'
import { getConfig, openPeriod, savePeriodConfig } from './periods'
import { createBatch, recordPosTransaction } from './pos'
import { listProducts } from './products'

const NAMES = [
  'محمد أحمد علي', 'فاطمة محمود حسن', 'أحمد سيد إبراهيم', 'سعاد عبد الله', 'محمود عبد الرحمن', 'نادية فتحي',
  'خالد مصطفى', 'هدى السيد', 'عبد الله رمضان', 'منى عادل', 'حسن شعبان', 'زينب كمال'
]
const MEMBERS = [2, 2, 4, 5, 3, 1, 6, 4, 3, 2, 7, 4]

/**
 * Fills an empty database with a sample month so the screens can be tried out: cards, prices, opening stock,
 * a POS batch with strikes (some above the card value), and receipts covering every tracking case.
 */
export function loadDemoData(ctx: Ctx): { month: string; cards: number } {
  requireAdmin(ctx)
  if (ctx.db.get('SELECT 1 FROM cards LIMIT 1') || ctx.db.get('SELECT 1 FROM periods LIMIT 1')) {
    throw new AppError('البيانات التجريبية تُحمّل على قاعدة بيانات فارغة فقط')
  }
  const month = currentMonth()
  const day = (d: number): string => `${month}-${String(d).padStart(2, '0')}`
  return ctx.db.tx(() => {
    const cards = NAMES.map((name, i) =>
      createCard(ctx, { cardNumber: String(1200345600 + i), holderName: name, secretRef: String(4000 + i), bakery: i % 2 ? 'مخبز الأمل' : 'مخبز النور', members: MEMBERS[i], status: 'active', groupName: null }, 'demo')
    )
    openPeriod(ctx, month)
    const pid = Object.fromEntries(listProducts(ctx).map((p) => [p.name, p.id]))
    const price: Record<string, number> = { سكر: 1250, زيت: 3000, مكرونة: 800, جبنة: 1500, بسكويت: 250, طحينة: 2000 }
    savePeriodConfig(ctx, {
      ...getConfig(ctx, month),
      cardValues: [1, 2, 3, 4, 5, 6, 7].map((m) => ({ members: m, valuePiasters: 4925 * m })),
      prices: Object.entries(price).filter(([n]) => pid[n]).map(([n, p]) => ({ productId: pid[n], pricePiasters: p }))
    })
    const today = todayIso()
    for (const [n, q] of [['سكر', 300], ['زيت', 250], ['مكرونة', 100], ['جبنة', 60], ['بسكويت', 200], ['طحينة', 40]] as const) {
      if (pid[n]) recordMovement(ctx, { productId: pid[n], type: 'opening', quantity: q, date: day(1), note: 'بيانات تجريبية' })
    }
    recordMovement(ctx, { productId: pid['سكر'], type: 'receipt', quantity: 500, date: today, documentRef: 'ف-تجريبي/1' })
    recordMovement(ctx, { productId: pid['زيت'], type: 'damage', quantity: 2, date: today, note: 'زجاجتان مكسورتان' })

    const batch = createBatch(ctx, { month, institution: 'الشركة المصرية لتجارة الجملة', notes: 'دفعة تجريبية' })
    const strike = (i: number, extra: [string, number][]): void => {
      const m = MEMBERS[i]
      recordPosTransaction(ctx, {
        batchId: batch.id, cardId: cards[i].id, executedAt: today,
        items: [
          { productId: pid['سكر'], quantity: Math.min(m, 6), unitPricePiasters: price['سكر'] },
          { productId: pid['زيت'], quantity: Math.min(m, 4), unitPricePiasters: price['زيت'] },
          ...extra.map(([n, q]) => ({ productId: pid[n], quantity: q, unitPricePiasters: price[n] }))
        ]
      })
    }
    const receive = (i: number, items: [string, number][], appliesTo = month): void => {
      recordDistribution(ctx, { cardId: cards[i].id, month, distributedAt: today, items: items.map(([n, q]) => ({ productId: pid[n], quantity: q, appliesToMonth: appliesTo })) })
    }
    // Struck and fully received
    strike(0, [['مكرونة', 2], ['بسكويت', 1]])
    receive(0, [['سكر', 2], ['زيت', 2], ['مكرونة', 2], ['بسكويت', 1]])
    // Struck, not received
    strike(1, [['جبنة', 1]])
    strike(7, [['مكرونة', 3]])
    // Struck, partially received
    strike(2, [['مكرونة', 3]])
    receive(2, [['سكر', 2], ['زيت', 4]])
    strike(3, [])
    receive(3, [['سكر', 5], ['زيت', 4]])
    // Received before the strike (needs linking)
    receive(4, [['سكر', 3], ['زيت', 3]])
    receive(9, [['سكر', 1]])
    // Advance against next month
    receive(5, [['سكر', 1], ['زيت', 1]])
    receive(5, [['زيت', 1]], addMonths(month, 1))
    // Cards 6, 8, 10, 11: neither struck nor received
    audit(ctx, 'load_demo', 'database', null, { month, cards: cards.length })
    return { month, cards: cards.length }
  })
}
