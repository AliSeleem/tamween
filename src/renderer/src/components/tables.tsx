import { useState } from 'react'
import type { Distribution, PosTransaction, RightsRow } from '@shared/types'
import { formatMoney, monthLabel } from '@shared/util'
import { call } from '../api'
import { useSession } from '../session'
import { Empty, Money, useAction, VoidDialog } from './ui'

export function RightsTable({ rows, showMonth }: { rows: RightsRow[]; showMonth?: boolean }) {
  if (!rows.length) return <Empty>لا توجد حقوق مسجلة لهذا الشهر.</Empty>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {showMonth && <th>الشهر</th>}
            <th>الصنف</th>
            <th className="num">المستحق</th>
            <th className="num">مرحل من سابق</th>
            <th className="num">حق من الضرب</th>
            <th className="num">مضروب على الـPOS</th>
            <th className="num">مستلم فعليًا</th>
            <th className="num">مرحل / منتهي</th>
            <th className="num">المتبقي</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.month}-${r.productId}`}>
              {showMonth && <td>{monthLabel(r.month)}</td>}
              <td>{r.productName} <span className="muted small">({r.unit})</span></td>
              <td className="num">{r.entitled}</td>
              <td className="num">{r.carriedIn || '—'}</td>
              <td className="num">{r.posRight || '—'}</td>
              <td className="num">{r.posQuantity || '—'}</td>
              <td className="num">{r.delivered}</td>
              <td className="num">{r.carriedOut || r.expired ? `${r.carriedOut} / ${r.expired}` : '—'}</td>
              <td className="num">
                <RemainingBadge value={r.remaining} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RemainingBadge({ value }: { value: number }) {
  if (value > 0) return <span className="badge warn">له {value}</span>
  if (value < 0) return <span className="badge info">مقدم {-value}</span>
  return <span className="badge ok">0</span>
}

export function PosTxTable({ rows, onChange, showCard }: { rows: PosTransaction[]; onChange: () => void; showCard?: boolean }) {
  const { isAdmin } = useSession()
  const [voiding, setVoiding] = useState<PosTransaction | null>(null)
  const run = useAction()
  if (!rows.length) return <Empty>لا توجد عمليات ضرب.</Empty>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            {showCard && <th>البطاقة</th>}
            <th>التاريخ</th>
            <th>الدفعة</th>
            <th>الأصناف</th>
            <th className="num">قيمة الضرب</th>
            <th className="num">قيمة البطاقة</th>
            <th className="num">الفرق</th>
            <th>المستخدم</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.status === 'voided' ? 'voided' : ''}>
              <td className="num">{t.id}</td>
              {showCard && <td><b className="num">{t.cardNumber}</b> {t.holderName}</td>}
              <td className="num">{t.executedAt}</td>
              <td className="num">{t.batchNumber}</td>
              <td>{t.items.map((i) => `${i.productName} ${i.quantity}`).join('، ')}</td>
              <td className="num"><Money value={t.totalPiasters} /></td>
              <td className="num"><Money value={t.entitledValuePiasters} /></td>
              <td className="num">
                {t.differencePiasters > 0 ? <span className="badge danger">+{formatMoney(t.differencePiasters)}</span> : t.differencePiasters < 0 ? <span className="badge neutral">{formatMoney(t.differencePiasters)}</span> : '0.00'}
              </td>
              <td className="small">{t.createdBy}</td>
              <td className="keep">
                {t.status === 'voided' ? (
                  <span className="badge neutral" title={t.voidReason ?? ''}>ملغاة</span>
                ) : (
                  isAdmin && <button className="danger small" onClick={() => setVoiding(t)}>إلغاء</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {voiding && (
        <VoidDialog
          title={`إلغاء عملية الضرب رقم ${voiding.id}`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            const ok = await run(() => call('pos.void', { id: voiding.id, reason }).then(() => true), 'تم إلغاء العملية')
            if (ok) {
              setVoiding(null)
              onChange()
            }
          }}
        />
      )}
    </div>
  )
}

export function DistributionTable({ rows, onChange, showCard }: { rows: Distribution[]; onChange: () => void; showCard?: boolean }) {
  const { isAdmin } = useSession()
  const [voiding, setVoiding] = useState<Distribution | null>(null)
  const run = useAction()
  if (!rows.length) return <Empty>لا توجد عمليات استلام.</Empty>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            {showCard && <th>البطاقة</th>}
            <th>التاريخ</th>
            <th>الأصناف</th>
            <th>ملاحظات</th>
            <th>المستخدم</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className={d.status === 'voided' ? 'voided' : ''}>
              <td className="num">{d.id}</td>
              {showCard && <td><b className="num">{d.cardNumber}</b> {d.holderName}</td>}
              <td className="num">{d.distributedAt}</td>
              <td>
                {d.items.map((i, k) => (
                  <span key={k}>
                    {k > 0 && '، '}
                    {i.productName} {i.quantity}
                    {i.appliesToMonth !== d.month && <span className="badge info" style={{ marginInlineStart: 4 }}>مقدم {monthLabel(i.appliesToMonth)}</span>}
                  </span>
                ))}
              </td>
              <td className="small">{d.notes}</td>
              <td className="small">{d.createdBy}</td>
              <td className="keep">
                {d.status === 'voided' ? (
                  <span className="badge neutral" title={d.voidReason ?? ''}>ملغاة</span>
                ) : (
                  isAdmin && <button className="danger small" onClick={() => setVoiding(d)}>إلغاء</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {voiding && (
        <VoidDialog
          title={`إلغاء الاستلام رقم ${voiding.id}`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            const ok = await run(() => call('distribution.void', { id: voiding.id, reason }).then(() => true), 'تم إلغاء الاستلام وإرجاع الكميات للمخزن')
            if (ok) {
              setVoiding(null)
              onChange()
            }
          }}
        />
      )}
    </div>
  )
}
