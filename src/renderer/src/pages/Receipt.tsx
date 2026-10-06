import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { CardMonthContext } from '@shared/types'
import { addMonths, monthLabel, todayIso, cardLabel } from '@shared/util'
import { call } from '../api'
import { Page } from '../components/Page'
import { DistributionTable, RemainingBadge, RightsTable } from '../components/tables'
import { CardPicker, Empty, Field, Money, PosBadge, ReceiptBadge, useAction } from '../components/ui'
import { useSession } from '../session'

export function ReceiptPage() {
  const { month, products } = useSession()
  const [params, setParams] = useSearchParams()
  const cardId = Number(params.get('card')) || null
  const [ctx, setCtx] = useState<CardMonthContext | null>(null)
  const [qty, setQty] = useState<Record<number, string>>({})
  const [advance, setAdvance] = useState<Record<number, string>>({})
  const [showAdvance, setShowAdvance] = useState(false)
  const [date, setDate] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const run = useAction()

  const load = async (): Promise<void> => {
    if (!cardId || !month) return setCtx(null)
    const c = await run(() => call('cards.monthContext', { cardId, month }))
    setCtx(c ?? null)
    setQty({})
    setAdvance({})
    setNotes('')
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, month])

  if (!month) return <Page title="الاستلام الفعلي"><Empty>لا يوجد شهر مفتوح. افتح شهرًا من الإعدادات.</Empty></Page>

  const active = products.filter((p) => p.active)
  const rightOf = (pid: number): number => ctx?.rights.find((r) => r.productId === pid)?.remaining ?? 0
  const nextMonth = addMonths(month, 1)
  const items = [
    ...Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([pid, v]) => ({ productId: Number(pid), quantity: Number(v), appliesToMonth: month })),
    ...Object.entries(advance).filter(([, v]) => Number(v) > 0).map(([pid, v]) => ({ productId: Number(pid), quantity: Number(v), appliesToMonth: nextMonth }))
  ]

  return (
    <Page title="الاستلام الفعلي">
      <div className="panel panel-body">
        <CardPicker autoFocus onPick={(c) => setParams({ card: String(c.id) })} placeholder="رقم البطاقة أو اسم صاحبها ثم Enter…" />
      </div>

      {ctx && (
        <>
          <div className="panel panel-body row">
            <div className="grow">
              <h2>
                <Link to={`/cards/${ctx.card.id}`} className="num">{cardLabel(ctx.card)}</Link> · {ctx.card.holderName}
              </h2>
              <div className="muted small">
                {ctx.snapshotMembers != null ? `${ctx.snapshotMembers} أفراد في ${monthLabel(month)}` : 'غير مدرجة في هذا الشهر'}
                {ctx.card.members !== ctx.snapshotMembers && ctx.snapshotMembers != null && ` (الحالي ${ctx.card.members})`}
                {ctx.entitledValuePiasters != null && <> · قيمة البطاقة المتبقية <Money value={ctx.entitledValuePiasters} /> ج</>}
              </div>
            </div>
            <PosBadge status={ctx.posStatus} />
            <ReceiptBadge status={ctx.receiptStatus} />
          </div>

          {ctx.receiptStatus !== 'none' && ctx.posStatus === 'none' && (
            <div className="alert warning">استلمت ولم تُضرب بعد. عند ضرب البطاقة سيرتبط الضرب بهذا الاستلام تلقائيًا.</div>
          )}

          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <div className="panel">
              <div className="panel-head"><h2>تسجيل الاستلام</h2>
                <button
                  className="small"
                  onClick={() => setQty(Object.fromEntries(ctx.rights.filter((r) => r.remaining > 0).map((r) => [r.productId, String(r.remaining)])))}
                >
                  استلام كل المتبقي
                </button>
              </div>
              <div className="panel-body">
                {!ctx.periodOpen ? (
                  <div className="alert warning">الشهر مغلق.</div>
                ) : ctx.snapshotMembers == null ? (
                  <div className="alert warning">البطاقة غير مدرجة في هذا الشهر. يمكن للمدير إدراجها من صفحة البطاقة.</div>
                ) : (
                  <>
                    <table>
                      <thead><tr><th>الصنف</th><th className="num">المتبقي له</th><th>الكمية المستلمة</th></tr></thead>
                      <tbody>
                        {active.map((p) => (
                          <tr key={p.id}>
                            <td>{p.name} <span className="muted small">({p.unit})</span></td>
                            <td className="num"><RemainingBadge value={rightOf(p.id)} /></td>
                            <td>
                              <input className="qty" type="number" min={0} value={qty[p.id] ?? ''} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value })} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 12 }}>
                      <label className="check">
                        <input type="checkbox" checked={showAdvance} onChange={(e) => setShowAdvance(e.target.checked)} />
                        صرف مقدم على حساب {monthLabel(nextMonth)}
                      </label>
                    </div>
                    {showAdvance && (
                      <table style={{ marginTop: 8 }}>
                        <tbody>
                          {active.map((p) => (
                            <tr key={p.id}>
                              <td>{p.name} (مقدم)</td>
                              <td>
                                <input className="qty" type="number" min={0} value={advance[p.id] ?? ''} onChange={(e) => setAdvance({ ...advance, [p.id]: e.target.value })} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="grid cols-2" style={{ marginTop: 12 }}>
                      <Field label="تاريخ الاستلام"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
                      <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
                    </div>
                    <div className="row end" style={{ marginTop: 12 }}>
                      <button
                        className="primary"
                        disabled={!items.length}
                        onClick={async () => {
                          const ok = await run(
                            () => call('distribution.record', { cardId: ctx.card.id, month, distributedAt: date, items, notes }).then(() => true),
                            'تم تسجيل الاستلام'
                          )
                          if (ok) await load()
                        }}
                      >
                        تسجيل الاستلام
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="panel">
              <div className="panel-head"><h2>حقوق {monthLabel(month)}</h2></div>
              <RightsTable rows={ctx.rights} />
              {ctx.nextMonthRights.length > 0 && (
                <>
                  <div className="panel-head"><h3>{monthLabel(nextMonth)}</h3></div>
                  <RightsTable rows={ctx.nextMonthRights} />
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>عمليات الاستلام هذا الشهر</h2></div>
            <DistributionTable rows={ctx.distributions} onChange={load} />
          </div>
        </>
      )}
    </Page>
  )
}
