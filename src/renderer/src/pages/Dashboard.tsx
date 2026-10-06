import { Link } from 'react-router-dom'
import { formatMoney, monthLabel } from '@shared/util'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { ErrorBox, useAction } from '../components/ui'
import { useSession } from '../session'

export function DashboardPage() {
  const { month, isAdmin, refresh, setMonth } = useSession()
  const { data, error, reload } = useApi('dashboard.get', { month }, [month])
  const run = useAction()
  return (
    <Page title="لوحة المتابعة">
      <ErrorBox error={error} />
      {data && isAdmin && data.cardCount === 0 && !month && (
        <div className="alert info">
          <span className="grow">قاعدة البيانات فارغة. ابدأ بفتح شهر واستيراد البطاقات، أو جرّب البرنامج ببيانات تجريبية.</span>
          <button
            className="primary"
            onClick={async () => {
              const r = await run(() => call('demo.load'), 'تم تحميل البيانات التجريبية')
              if (r) {
                await refresh()
                setMonth(r.month)
                reload()
              }
            }}
          >
            تحميل بيانات تجريبية
          </button>
        </div>
      )}
      {data && (
        <>
          <div className="grid cols-4">
            <Stat label="البطاقات المسجلة" value={data.cardCount} sub={`${data.activeCardCount} نشطة`} />
            <Stat label={`الأفراد المستحقون${data.month ? ` (${monthLabel(data.month)})` : ''}`} value={data.membersTotal} />
            <Stat label="بطاقات ضُربت" value={data.struckCount} sub={`${data.fullCycleCount} مكتملة الدورة`} />
            <Stat label="بطاقات استلمت" value={data.receivedCount} />
            <Stat label="إجمالي الضرب" value={formatMoney(data.posTotalPiasters)} sub="جنيه" />
            <Stat label="فروق التسوية (مطلوب سدادها)" value={formatMoney(data.overagePiasters)} sub="جنيه" />
          </div>

          {data.alerts.length > 0 && (
            <div className="panel">
              <div className="panel-head"><h2>التنبيهات</h2></div>
              <div className="panel-body alerts">
                {data.alerts.map((a, i) => (
                  <div key={i} className={`alert ${a.level}`}>
                    <span className="grow">{a.message}</span>
                    {a.link && <Link to={a.link}>عرض</Link>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.core.length > 0 && (
            <div className="panel">
              <div className="panel-head"><h2>الأصناف في {data.month ? monthLabel(data.month) : ''}</h2></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الصنف</th>
                      <th className="num">المستحق للمواطنين</th>
                      <th className="num">المضروب على الـPOS</th>
                      <th className="num">المسلَّم فعليًا</th>
                      <th className="num">المتبقي للمواطنين</th>
                      <th className="num">رصيد المخزن</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.core.map((c) => (
                      <tr key={c.productId}>
                        <td>{c.productName} <span className="muted small">({c.unit})</span></td>
                        <td className="num">{c.entitled}</td>
                        <td className="num">{c.struck}</td>
                        <td className="num">{c.delivered}</td>
                        <td className="num">{c.entitled - c.delivered}</td>
                        <td className="num">{c.stock}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Page>
  )
}

function Stat(props: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="panel stat">
      <div className="label">{props.label}</div>
      <div className="value num">{typeof props.value === 'number' ? props.value.toLocaleString('en-US') : props.value}</div>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  )
}
