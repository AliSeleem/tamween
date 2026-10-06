import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { CardMonthContext } from '@shared/types'
import { formatMoney, monthLabel, parseMoney, todayIso, cardLabel } from '@shared/util'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { PosTxTable } from '../components/tables'
import { CardPicker, Empty, ErrorBox, Field, Meter, Modal, Money, PosBadge, ReceiptBadge, useAction } from '../components/ui'
import { useSession } from '../session'

export function PosBatchesPage() {
  const { month, periods } = useSession()
  const { data, error, reload } = useApi('pos.batches', { month: month ?? undefined }, [month], !!month)
  const [creating, setCreating] = useState(false)
  const nav = useNavigate()
  const open = periods.find((p) => p.month === month)?.status === 'open'
  return (
    <Page title="الضرب ودفعات التسوية" actions={open && <button className="primary" onClick={() => setCreating(true)}>+ دفعة جديدة</button>}>
      <ErrorBox error={error} />
      {!month ? (
        <Empty>لا يوجد شهر مفتوح.</Empty>
      ) : (
        <div className="panel">
          {data && data.length === 0 ? (
            <Empty>لا توجد دفعات في {monthLabel(month)}. أنشئ دفعة لبدء تسجيل الضرب.</Empty>
          ) : (
            <table>
              <thead><tr><th>رقم الدفعة</th><th>المؤسسة</th><th className="num">الحد المالي</th><th className="num">حد السكر</th><th className="num">حد الزيت</th><th>الحالة</th><th>تاريخ الإنشاء</th></tr></thead>
              <tbody>
                {data?.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => nav(`/pos/${b.id}`)}>
                    <td className="num"><b>{b.batchNumber}</b></td>
                    <td>{b.institution ?? '—'}</td>
                    <td className="num"><Money value={b.moneyLimitPiasters} /></td>
                    <td className="num">{b.sugarLimit}</td>
                    <td className="num">{b.oilLimit}</td>
                    <td>{b.status === 'open' ? <span className="badge ok">مفتوحة</span> : <span className="badge neutral">مغلقة</span>}</td>
                    <td className="num small muted">{b.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {creating && month && (
        <NewBatchModal
          month={month}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            reload()
            nav(`/pos/${id}`)
          }}
        />
      )}
    </Page>
  )
}

function NewBatchModal(props: { month: string; onClose: () => void; onCreated: (id: number) => void }) {
  const { data: settings } = useApi('settings.get', undefined)
  const [form, setForm] = useState({ batchNumber: '', institution: '', money: '', sugar: '', oil: '', notes: '' })
  const run = useAction()
  useEffect(() => {
    if (settings) {
      setForm((f) => ({
        ...f,
        money: formatMoney(settings.defaultMoneyLimitPiasters).replace(/,/g, ''),
        sugar: String(settings.defaultSugarLimit),
        oil: String(settings.defaultOilLimit)
      }))
    }
  }, [settings])
  return (
    <Modal
      title={`دفعة ضرب جديدة · ${monthLabel(props.month)}`}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>إلغاء</button>
          <button
            className="primary"
            onClick={async () => {
              const money = parseMoney(form.money)
              const b = await run(() =>
                call('pos.createBatch', {
                  month: props.month,
                  batchNumber: form.batchNumber || undefined,
                  institution: form.institution,
                  moneyLimitPiasters: money ?? undefined,
                  sugarLimit: Number(form.sugar),
                  oilLimit: Number(form.oil),
                  notes: form.notes
                })
              )
              if (b) props.onCreated(b.id)
            }}
          >
            إنشاء
          </button>
        </>
      }
    >
      <div className="grid cols-2">
        <Field label="رقم الدفعة (اتركه فارغًا للترقيم التلقائي)"><input value={form.batchNumber} onChange={(e) => setForm({ ...form, batchNumber: e.target.value })} /></Field>
        <Field label="المؤسسة"><input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} /></Field>
        <Field label="الحد المالي (جنيه)"><input className="money" value={form.money} onChange={(e) => setForm({ ...form, money: e.target.value })} /></Field>
        <Field label="حد السكر (كجم)"><input type="number" value={form.sugar} onChange={(e) => setForm({ ...form, sugar: e.target.value })} /></Field>
        <Field label="حد الزيت (زجاجة)"><input type="number" value={form.oil} onChange={(e) => setForm({ ...form, oil: e.target.value })} /></Field>
        <Field label="ملاحظات"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

export function PosBatchPage() {
  const id = Number(useParams().id)
  const { isAdmin } = useSession()
  const { data, error, reload } = useApi('pos.batchSummary', { id }, [id])
  const { data: settings } = useApi('settings.get', undefined)
  const run = useAction()
  const threshold = settings?.alertThresholdPercent ?? 90
  if (!data) return <Page title="دفعة" showMonth={false}><ErrorBox error={error} /></Page>
  const b = data.batch
  return (
    <Page
      title={<>دفعة <bdi>{b.batchNumber}</bdi> · {monthLabel(b.month)}</>}
      showMonth={false}
      actions={
        <>
          <Link to="/pos"><button>كل الدفعات</button></Link>
          <button onClick={() => window.tamween.print()}>طباعة</button>
          {isAdmin && (
            <button onClick={() => run(() => call('pos.setBatchStatus', { id, status: b.status === 'open' ? 'closed' : 'open' }).then(reload), 'تم تحديث حالة الدفعة')}>
              {b.status === 'open' ? 'إغلاق الدفعة' : 'إعادة فتح الدفعة'}
            </button>
          )}
        </>
      }
    >
      <div className="grid cols-4">
        <Meter label="الحد المالي" used={data.moneyUsedPiasters} limit={b.moneyLimitPiasters} unit="جنيه" format={formatMoney} threshold={threshold} />
        <Meter label="السكر" used={data.sugarUsed} limit={b.sugarLimit} unit="كجم" threshold={threshold} />
        <Meter label="الزيت" used={data.oilUsed} limit={b.oilLimit} unit="زجاجة" threshold={threshold} />
        <div className="panel stat">
          <div className="label">فروق الزيادة (مطلوب سدادها للمؤسسة)</div>
          <div className="value num">{formatMoney(data.overagePiasters)} <span className="small muted">جنيه</span></div>
          <div className="sub">{data.transactionCount} عملية · نقص غير مستخدم {formatMoney(data.shortfallPiasters)} ج</div>
        </div>
      </div>
      {b.status === 'open' ? <StrikeForm batchId={id} month={b.month} onDone={reload} /> : <div className="alert info">الدفعة مغلقة ولا تقبل عمليات جديدة.</div>}
      <div className="panel">
        <div className="panel-head"><h2>البطاقات في الدفعة</h2></div>
        <PosTxTable rows={data.transactions} onChange={reload} showCard />
      </div>
    </Page>
  )
}

interface Line {
  productId: number
  quantity: string
  price: string
}

function StrikeForm(props: { batchId: number; month: string; onDone: () => void }) {
  const { products } = useSession()
  const [ctx, setCtx] = useState<CardMonthContext | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [date, setDate] = useState(todayIso())
  const [additional, setAdditional] = useState(false)
  const [notes, setNotes] = useState('')
  const run = useAction()
  const active = products.filter((p) => p.active)

  const pickCard = async (cardId: number): Promise<void> => {
    const c = await run(() => call('cards.monthContext', { cardId, month: props.month }))
    if (!c) return
    setCtx(c)
    setAdditional(false)
    setNotes('')
    const priceOf = (pid: number): string => formatMoney(c.prices.find((p) => p.productId === pid)?.pricePiasters ?? 0).replace(/,/g, '')
    // Start from the rule products still owed this month (sugar and oil); the clerk completes the value.
    setLines(
      c.rights.filter((r) => r.entitled > 0).map((r) => ({
        productId: r.productId,
        quantity: String(Math.max(0, r.entitled + r.carriedIn - r.posQuantity)),
        price: priceOf(r.productId)
      }))
    )
  }

  const priceFor = (pid: number): string => formatMoney(ctx?.prices.find((p) => p.productId === pid)?.pricePiasters ?? 0).replace(/,/g, '')
  const parsed = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPricePiasters: parseMoney(l.price) }))
  const valid = parsed.filter((l) => l.quantity > 0)
  const total = valid.reduce((s, l) => s + l.quantity * (l.unitPricePiasters ?? 0), 0)
  const value = ctx?.entitledValuePiasters ?? null
  const diff = value == null ? null : total - value
  const invalid = valid.some((l) => l.unitPricePiasters == null || !Number.isInteger(l.quantity))

  return (
    <div className="panel">
      <div className="panel-head"><h2>تسجيل ضرب بطاقة</h2></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <CardPicker onPick={(c) => pickCard(c.id)} placeholder="رقم البطاقة أو الاسم…" />
        {ctx && (
          <>
            <div className="row">
              <h2 className="grow"><span className="num">{cardLabel(ctx.card)}</span> · {ctx.card.holderName}</h2>
              <span className="muted">{ctx.snapshotMembers ?? '—'} أفراد</span>
              <PosBadge status={ctx.posStatus} />
              <ReceiptBadge status={ctx.receiptStatus} />
            </div>
            {ctx.snapshotMembers == null && <div className="alert danger">البطاقة غير مدرجة في هذا الشهر.</div>}
            {ctx.receiptStatus !== 'none' && ctx.posStatus === 'none' && <div className="alert info">هذه البطاقة استلمت قبل الضرب؛ تسجيل الضرب الآن يكمل دورتها.</div>}
            {ctx.posStatus !== 'none' && (
              <div className="alert warning">
                <span className="grow">البطاقة مضروبة من قبل في هذا الشهر.</span>
                <label className="check"><input type="checkbox" checked={additional} onChange={(e) => setAdditional(e.target.checked)} /> ضرب إضافي مقصود</label>
              </div>
            )}
            <table>
              <thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th className="num">الإجمالي</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = parsed[i]
                  return (
                    <tr key={i}>
                      <td>
                        <select value={l.productId} onChange={(e) => {
                          const pid = Number(e.target.value)
                          setLines(lines.map((x, k) => (k === i ? { ...x, productId: pid, price: priceFor(pid) } : x)))
                        }}>
                          {active.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                        </select>
                      </td>
                      <td><input className="qty" type="number" min={0} value={l.quantity} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} /></td>
                      <td><input className="money" value={l.price} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} /></td>
                      <td className="num">{p.unitPricePiasters == null ? '—' : formatMoney(p.quantity * p.unitPricePiasters)}</td>
                      <td><button className="link" onClick={() => setLines(lines.filter((_, k) => k !== i))}>حذف</button></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>
                    <button className="small" onClick={() => {
                      const used = new Set(lines.map((l) => l.productId))
                      const next = active.find((p) => !used.has(p.id)) ?? active[0]
                      setLines([...lines, { productId: next.id, quantity: '1', price: priceFor(next.id) }])
                    }}>+ صنف لاستكمال القيمة</button>
                  </td>
                  <td className="num">{formatMoney(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <div className="grid cols-4">
              <div className="panel stat"><div className="label">قيمة البطاقة المتاحة</div><div className="value num">{formatMoney(value)}</div></div>
              <div className="panel stat"><div className="label">قيمة الضرب</div><div className="value num">{formatMoney(total)}</div></div>
              <div className="panel stat">
                <div className="label">الفرق</div>
                <div className="value num" style={{ color: diff != null && diff > 0 ? 'var(--danger)' : undefined }}>{diff == null ? '—' : formatMoney(diff)}</div>
                <div className="sub">{diff == null ? 'قيمة البطاقة غير معرفة في الإعدادات' : diff > 0 ? 'زيادة تُسجل كفرق تسوية' : diff < 0 ? 'نقص غير مستخدم' : 'مطابق'}</div>
              </div>
              <div className="grid">
                <Field label="تاريخ الضرب"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              </div>
            </div>
            <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="row end">
              <button onClick={() => setCtx(null)}>إلغاء</button>
              <button
                className="primary"
                disabled={!valid.length || invalid || ctx.snapshotMembers == null || (ctx.posStatus !== 'none' && !additional)}
                onClick={async () => {
                  const ok = await run(
                    () =>
                      call('pos.record', {
                        batchId: props.batchId,
                        cardId: ctx.card.id,
                        executedAt: date,
                        items: valid.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPricePiasters: l.unitPricePiasters! })),
                        notes,
                        allowAdditional: additional
                      }).then(() => true),
                    'تم تسجيل الضرب'
                  )
                  if (ok) {
                    setCtx(null)
                    props.onDone()
                  }
                }}
              >
                تسجيل الضرب
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
