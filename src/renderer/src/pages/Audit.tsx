import { useState } from 'react'
import { useApi } from '../api'
import { Page } from '../components/Page'
import { Empty, ErrorBox } from '../components/ui'

const ENTITY_LABEL: Record<string, string> = {
  card: 'بطاقة',
  cards: 'بطاقات',
  pos_transaction: 'ضرب',
  pos_batch: 'دفعة',
  distribution: 'استلام',
  inventory_tx: 'حركة مخزن',
  product: 'صنف',
  period: 'شهر',
  settings: 'إعدادات',
  user: 'مستخدم',
  database: 'قاعدة البيانات'
}

const ACTION_LABEL: Record<string, string> = {
  create: 'إنشاء',
  update: 'تعديل',
  void: 'إلغاء',
  reverse: 'عكس',
  open: 'فتح',
  close: 'إغلاق',
  reopen: 'إعادة فتح',
  update_config: 'تعديل القواعد',
  import: 'استيراد',
  login: 'دخول',
  logout: 'خروج',
  change_password: 'تغيير كلمة المرور',
  stocktake: 'جرد',
  backup: 'نسخ احتياطي',
  include_in_month: 'إدراج في شهر'
}

export function AuditPage() {
  const [entity, setEntity] = useState('')
  const [offset, setOffset] = useState(0)
  const { data, error } = useApi('audit.list', { entity: entity || undefined, limit: 200, offset }, [entity, offset])
  return (
    <Page title="سجل العمليات" showMonth={false}>
      <ErrorBox error={error} />
      <div className="panel">
        <div className="panel-head">
          <select value={entity} onChange={(e) => { setEntity(e.target.value); setOffset(0) }}>
            <option value="">كل العمليات</option>
            {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="grow" />
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>الأحدث</button>
          <button disabled={!data || data.length < 200} onClick={() => setOffset(offset + 200)}>الأقدم</button>
        </div>
        {data && data.length === 0 ? (
          <Empty>لا توجد عمليات.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>النوع</th><th className="num">المرجع</th><th>التفاصيل</th></tr></thead>
              <tbody>
                {data?.map((a) => (
                  <tr key={a.id}>
                    <td className="num small">{a.at}</td>
                    <td>{a.userName ?? '—'}</td>
                    <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                    <td>{ENTITY_LABEL[a.entity] ?? a.entity}</td>
                    <td className="num">{a.entityId}</td>
                    <td><pre className="details">{a.details}</pre></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  )
}
