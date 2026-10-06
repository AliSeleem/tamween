import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatMoney, monthLabel } from '@shared/util'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { DistributionTable, PosTxTable, RightsTable } from '../components/tables'
import { Empty, ErrorBox, useAction } from '../components/ui'
import { useSession } from '../session'
import { CARD_STATUS_LABEL, CardForm } from './Cards'

const ENTRY_LABEL: Record<string, string> = {
  entitlement: 'استحقاق',
  pos_right: 'حق من الضرب',
  delivery: 'استلام',
  carry_in: 'مرحل وارد',
  carry_out: 'مرحل صادر',
  expire: 'انتهاء'
}

const FIELD_LABEL: Record<string, string> = {
  cardNumber: 'رقم البطاقة',
  holderName: 'الاسم',
  secretRef: 'الرقم السري',
  bakery: 'المخبز',
  members: 'عدد الأفراد',
  status: 'الحالة',
  groupName: 'المجموعة'
}

type Tab = 'rights' | 'pos' | 'receipts' | 'ledger' | 'history'

export function CardDetailPage() {
  const id = Number(useParams().id)
  const { isAdmin, month, periods } = useSession()
  const { data, error, reload } = useApi('cards.statement', { id }, [id])
  const [tab, setTab] = useState<Tab>('rights')
  const [editing, setEditing] = useState(false)
  const run = useAction()
  const notInMonth = data && month && periods.find((p) => p.month === month)?.status === 'open' && !data.snapshots.some((s) => s.month === month)

  return (
    <Page
      title={data ? <>بطاقة <bdi>{data.card.cardNumber}</bdi></> : 'بطاقة'}
      showMonth={false}
      actions={
        <>
          <Link to={`/receipt?card=${id}`}><button>تسجيل استلام</button></Link>
          <button onClick={() => window.tamween.print()}>طباعة الكشف</button>
          <button className="primary" onClick={() => setEditing(true)}>تعديل</button>
        </>
      }
    >
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="panel panel-body">
            <dl className="kv" style={{ gridTemplateColumns: 'auto 1fr auto 1fr auto 1fr' }}>
              <dt>صاحب البطاقة</dt><dd>{data.card.holderName}</dd>
              <dt>عدد الأفراد الحالي</dt><dd className="num">{data.card.members}</dd>
              <dt>الحالة</dt><dd>{CARD_STATUS_LABEL[data.card.status]}</dd>
              <dt>المخبز</dt><dd>{data.card.bakery ?? '—'}</dd>
              <dt>الرقم السري / البيان</dt><dd>{data.card.secretRef ?? '—'}</dd>
              <dt>المجموعة</dt><dd>{data.card.groupName ?? '—'}</dd>
            </dl>
            {data.snapshots.length > 0 && (
              <div className="row small muted" style={{ marginTop: 12 }}>
                لقطات الأفراد الشهرية:
                {data.snapshots.map((s) => (
                  <span key={s.month} className="badge neutral">
                    {monthLabel(s.month)}: {s.members} أفراد{s.valuePiasters != null && ` · ${formatMoney(s.valuePiasters)} ج`}
                  </span>
                ))}
              </div>
            )}
          </div>
          {notInMonth && (
            <div className="alert warning">
              <span className="grow">البطاقة غير مدرجة في شهر {monthLabel(month!)} (لم تكن نشطة عند فتحه).</span>
              {isAdmin && (
                <button
                  className="small"
                  onClick={() => run(() => call('cards.includeInMonth', { cardId: id, month: month! }).then(reload), 'تمت إضافة البطاقة للشهر')}
                >
                  إدراجها في الشهر
                </button>
              )}
            </div>
          )}
          <div className="panel">
            <div className="tabs">
              {([
                ['rights', 'دفتر الحقوق'],
                ['pos', `الضرب (${data.posTransactions.length})`],
                ['receipts', `الاستلام (${data.distributions.length})`],
                ['ledger', 'الحركات التفصيلية'],
                ['history', 'سجل التعديلات']
              ] as [Tab, string][]).map(([k, label]) => (
                <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>
            {tab === 'rights' && <RightsTable rows={data.rights} showMonth />}
            {tab === 'pos' && <PosTxTable rows={data.posTransactions} onChange={reload} />}
            {tab === 'receipts' && <DistributionTable rows={data.distributions} onChange={reload} />}
            {tab === 'ledger' && (
              data.ledger.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>الوقت</th><th>الشهر</th><th>الصنف</th><th>النوع</th><th className="num">الكمية</th><th>البيان</th><th>المستخدم</th></tr></thead>
                    <tbody>
                      {data.ledger.map((l) => (
                        <tr key={l.id}>
                          <td className="num small">{l.createdAt}</td>
                          <td>{monthLabel(l.month)}</td>
                          <td>{l.productName}</td>
                          <td>{ENTRY_LABEL[l.entryType] ?? l.entryType}</td>
                          <td className="num">{l.quantity > 0 ? `+${l.quantity}` : l.quantity}</td>
                          <td className="small">{l.note}</td>
                          <td className="small">{l.userName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>لا توجد حركات.</Empty>
            )}
            {tab === 'history' && (
              data.history.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>الوقت</th><th>الحقل</th><th>القيمة السابقة</th><th>القيمة الجديدة</th><th>السبب</th><th>المستخدم</th></tr></thead>
                    <tbody>
                      {data.history.map((h) => (
                        <tr key={h.id}>
                          <td className="num small">{h.changedAt}</td>
                          <td>{FIELD_LABEL[h.field] ?? h.field}</td>
                          <td>{h.oldValue ?? '—'}</td>
                          <td>{h.newValue ?? '—'}</td>
                          <td className="small">{h.reason}</td>
                          <td className="small">{h.userName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>لم تُعدل بيانات البطاقة.</Empty>
            )}
          </div>
        </>
      )}
      {editing && data && (
        <CardForm card={data.card} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload() }} />
      )}
    </Page>
  )
}
