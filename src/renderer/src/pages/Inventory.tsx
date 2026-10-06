import { useState } from 'react'
import type { InventoryMovement, InventoryTxType } from '@shared/types'
import { todayIso } from '@shared/util'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { Empty, ErrorBox, Field, Modal, useAction, VoidDialog } from '../components/ui'
import { useSession } from '../session'

const TYPE_LABEL: Record<InventoryTxType, string> = {
  opening: 'رصيد أول المدة',
  receipt: 'وارد من المؤسسة',
  distribution: 'صرف للمواطنين',
  return: 'مرتجع',
  damage: 'تالف',
  stocktake: 'تسوية جرد'
}

export function InventoryPage() {
  const { isAdmin, products } = useSession()
  const [productId, setProductId] = useState<number | ''>('')
  const balances = useApi('inventory.balances', {}, [])
  const moves = useApi('inventory.movements', { productId: productId || undefined, limit: 300 }, [productId])
  const [form, setForm] = useState<InventoryTxType | 'stocktake' | null>(null)
  const [reversing, setReversing] = useState<InventoryMovement | null>(null)
  const run = useAction()
  const reload = (): void => {
    balances.reload()
    moves.reload()
  }
  return (
    <Page
      title="المخزون"
      showMonth={false}
      actions={
        <>
          <button onClick={() => setForm('receipt')}>+ وارد</button>
          <button onClick={() => setForm('return')}>+ مرتجع</button>
          <button onClick={() => setForm('damage')}>+ تالف</button>
          {isAdmin && <button onClick={() => setForm('stocktake')}>جرد</button>}
          {isAdmin && <button onClick={() => setForm('opening')}>رصيد أول المدة</button>}
        </>
      }
    >
      <ErrorBox error={balances.error ?? moves.error} />
      <div className="panel">
        <div className="panel-head"><h2>الأرصدة الحالية</h2><span className="muted small">الرصيد = أول المدة + الوارد + المرتجع − الصرف − التالف ± الجرد</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>الصنف</th><th className="num">أول المدة</th><th className="num">الوارد</th><th className="num">المرتجع</th><th className="num">الصرف</th><th className="num">التالف</th><th className="num">تسويات الجرد</th><th className="num">الرصيد</th></tr>
            </thead>
            <tbody>
              {balances.data?.map((b) => (
                <tr key={b.productId} className="clickable" onClick={() => setProductId(b.productId)}>
                  <td>{b.productName} <span className="muted small">({b.unit})</span></td>
                  <td className="num">{b.opening}</td>
                  <td className="num">{b.receipts}</td>
                  <td className="num">{b.returns}</td>
                  <td className="num">{b.distributed}</td>
                  <td className="num">{b.damaged}</td>
                  <td className="num">{b.stocktake}</td>
                  <td className="num"><b style={{ color: b.balance < 0 ? 'var(--danger)' : undefined }}>{b.balance}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>الحركات</h2>
          <select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">كل الأصناف</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {moves.data && moves.data.length === 0 ? (
          <Empty>لا توجد حركات.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>التاريخ</th><th>الصنف</th><th>النوع</th><th className="num">الكمية</th><th>المستند</th><th>البيان</th><th>المستخدم</th><th /></tr></thead>
              <tbody>
                {moves.data?.map((m) => (
                  <tr key={m.id} className={m.reversed ? 'voided' : ''}>
                    <td className="num">{m.txDate}</td>
                    <td>{m.productName}</td>
                    <td>{TYPE_LABEL[m.txType]}{m.isReversal && ' (عكس)'}</td>
                    <td className="num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                    <td>{m.documentRef ?? ''}</td>
                    <td className="small">{m.note}</td>
                    <td className="small">{m.userName}</td>
                    <td className="keep">
                      {isAdmin && !m.reversed && !m.isReversal && m.txType !== 'distribution' && (
                        <button className="danger small" onClick={() => setReversing(m)}>عكس</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {form && <MovementModal type={form} onClose={() => setForm(null)} onDone={() => { setForm(null); reload() }} />}
      {reversing && (
        <VoidDialog
          title={`عكس حركة ${TYPE_LABEL[reversing.txType]} (${reversing.productName} ${reversing.quantity})`}
          onClose={() => setReversing(null)}
          onConfirm={async (reason) => {
            const ok = await run(() => call('inventory.reverse', { id: reversing.id, reason }).then(() => true), 'تم عكس الحركة')
            if (ok) {
              setReversing(null)
              reload()
            }
          }}
        />
      )}
    </Page>
  )
}

function MovementModal(props: { type: InventoryTxType; onClose: () => void; onDone: () => void }) {
  const { products } = useSession()
  const [productId, setProductId] = useState(products[0]?.id ?? 0)
  const [quantity, setQuantity] = useState('')
  const [date, setDate] = useState(todayIso())
  const [documentRef, setDocumentRef] = useState('')
  const [note, setNote] = useState('')
  const run = useAction()
  const stocktake = props.type === 'stocktake'
  return (
    <Modal
      title={stocktake ? 'جرد صنف' : TYPE_LABEL[props.type]}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>إلغاء</button>
          <button
            className="primary"
            onClick={async () => {
              const r = stocktake
                ? await run(async () => {
                    const { difference } = await call('inventory.stocktake', { productId, counted: Number(quantity), date, note })
                    return difference
                  })
                : await run(() => call('inventory.record', { productId, type: props.type, quantity: Number(quantity), date, documentRef, note }))
              if (r !== undefined) props.onDone()
            }}
          >
            حفظ
          </button>
        </>
      }
    >
      <div className="grid cols-2">
        <Field label="الصنف">
          <select value={productId} onChange={(e) => setProductId(Number(e.target.value))}>
            {products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
          </select>
        </Field>
        <Field label={stocktake ? 'الكمية الفعلية بالعد' : 'الكمية'}><input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus /></Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {props.type === 'receipt' && <Field label="رقم الفاتورة / المستند"><input value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} /></Field>}
      </div>
      <Field label={props.type === 'damage' ? 'سبب التلف' : 'ملاحظات'}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {props.type === 'damage' && <div className="alert info">إعادة تعبئة عبوة مفتوحة بدون فقد في الكمية لا تُسجل كتالف.</div>}
      {stocktake && <div className="alert info">سيُسجل الفرق بين الرصيد الدفتري والعد الفعلي كحركة تسوية جرد.</div>}
    </Modal>
  )
}
