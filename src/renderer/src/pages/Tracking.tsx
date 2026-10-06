import { useState } from 'react'
import { cardLabel } from '@shared/util'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { TrackingFilter } from '@shared/types'
import { useApi } from '../api'
import { Page } from '../components/Page'
import { Empty, ErrorBox, PosBadge, ReceiptBadge } from '../components/ui'
import { useSession } from '../session'
import { bridge } from '../bridge'

const FILTERS: [TrackingFilter, string][] = [
  ['all', 'الكل'],
  ['struck_not_received', 'ضُربت ولم تستلم'],
  ['received_not_struck', 'استلمت ولم تُضرب'],
  ['struck_and_received', 'ضُربت واستلمت'],
  ['neither', 'لم تُضرب ولم تستلم'],
  ['partial_receipt', 'استلام جزئي'],
  ['has_balance', 'لها رصيد متبقٍ']
]

export function TrackingPage() {
  const { month } = useSession()
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') as TrackingFilter) || 'all'
  const [query, setQuery] = useState('')
  const nav = useNavigate()
  const { data, error } = useApi('tracking.list', { month: month ?? '', filter, query, limit: 500 }, [month, filter, query], !!month)
  return (
    <Page title="متابعة البطاقات" actions={<button onClick={() => bridge.print()}>طباعة</button>}>
      <ErrorBox error={error} />
      {!month ? (
        <Empty>لا يوجد شهر مفتوح.</Empty>
      ) : (
        <div className="panel">
          <div className="panel-head" style={{ flexWrap: 'wrap' }}>
            <div className="chips grow">
              {FILTERS.map(([k, label]) => (
                <button key={k} className={`chip ${filter === k ? 'active' : ''}`} onClick={() => setParams({ filter: k })}>
                  {label}
                  {data && <span className="count num">{data.counts[k]}</span>}
                </button>
              ))}
            </div>
            <input className="search" placeholder="بحث…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {data && data.rows.length === 0 ? (
            <Empty>لا توجد بطاقات في هذا التصنيف.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>البطاقة</th><th>صاحب البطاقة</th><th className="num">الأفراد</th><th>حالة POS</th><th>الاستلام</th><th>المتبقي</th></tr></thead>
                <tbody>
                  {data?.rows.map((r) => (
                    <tr key={r.cardId} className="clickable" onClick={() => nav(`/cards/${r.cardId}`)}>
                      <td className="num"><b>{cardLabel(r)}</b></td>
                      <td>{r.holderName}</td>
                      <td className="num">{r.members}</td>
                      <td><PosBadge status={r.posStatus} /></td>
                      <td><ReceiptBadge status={r.receiptStatus} /></td>
                      <td>
                        {r.needsLink ? (
                          <span className="badge danger">يحتاج ربط</span>
                        ) : r.remainingUnits > 0 ? (
                          <span className="badge warn">له رصيد ({r.remainingUnits})</span>
                        ) : r.owedUnits > 0 ? (
                          <span className="badge info">مقدم ({r.owedUnits})</span>
                        ) : (
                          <span className="badge ok">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data && data.total > data.rows.length && <div className="panel-body muted small">يظهر أول {data.rows.length} من {data.total}. استخدم البحث للتضييق.</div>}
            </div>
          )}
        </div>
      )}
    </Page>
  )
}
