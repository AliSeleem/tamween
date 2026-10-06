import { useEffect, useState } from 'react'
import type { ImportMapping, ImportPreviewRow, ImportSheet } from '@shared/types'
import { call } from '../api'
import { Page } from '../components/Page'
import { Field, useAction, useToast } from '../components/ui'
import { useSession } from '../session'

const FIELDS: [keyof ImportMapping, string, boolean][] = [
  ['cardNumber', 'رقم البطاقة', true],
  ['holderName', 'اسم صاحب البطاقة', true],
  ['members', 'عدد الأفراد', true],
  ['secretRef', 'الرقم السري / البيان التعريفي', false],
  ['bakery', 'المخبز', false]
]

const STATUS: Record<ImportPreviewRow['status'], [string, string]> = {
  new: ['جديدة', 'ok'],
  update: ['تحديث', 'info'],
  unchanged: ['بدون تغيير', 'neutral'],
  error: ['خطأ', 'danger']
}

export function ImportPage() {
  const { refresh } = useSession()
  const [sheet, setSheet] = useState<ImportSheet | null>(null)
  const [mapping, setMapping] = useState<Partial<ImportMapping>>({})
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null)
  const [updateExisting, setUpdateExisting] = useState(false)
  const [show, setShow] = useState<ImportPreviewRow['status'] | 'all'>('all')
  const run = useAction()
  const toast = useToast()
  const complete = mapping.cardNumber != null && mapping.holderName != null && mapping.members != null
  const full = (): ImportMapping => ({ secretRef: null, bakery: null, ...mapping }) as ImportMapping

  useEffect(() => {
    if (!sheet || !complete) return setPreview(null)
    void run(() => call('import.preview', { sheet, mapping: full() })).then((p) => setPreview(p ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, mapping])

  const counts = preview?.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {} as Record<string, number>) ?? {}
  const willApply = (counts.new ?? 0) + (updateExisting ? counts.update ?? 0 : 0)

  return (
    <Page title="استيراد البطاقات من Excel" showMonth={false}>
      <div className="panel panel-body row">
        <div className="grow">
          <b>1. اختر الملف</b>
          <div className="muted small">ملف xlsx أو csv، الصف الأول يحتوي على أسماء الأعمدة.</div>
        </div>
        {sheet && <span className="badge neutral">{sheet.fileName} · {sheet.rows.length} صف</span>}
        <button
          className="primary"
          onClick={async () => {
            const r = await run(() => call('import.pickFile'))
            if (r) {
              setSheet(r.sheet)
              setMapping(r.mapping)
            }
          }}
        >
          اختيار ملف…
        </button>
      </div>

      {sheet && (
        <div className="panel">
          <div className="panel-head"><h2>2. ربط الأعمدة</h2></div>
          <div className="panel-body grid cols-3">
            {FIELDS.map(([key, label, required]) => (
              <Field key={key} label={`${label}${required ? ' *' : ''}`}>
                <select
                  value={mapping[key] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [key]: e.target.value === '' ? (required ? undefined : null) : Number(e.target.value) })}
                >
                  <option value="">{required ? '— اختر —' : '— غير موجود —'}</option>
                  {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `عمود ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </div>
      )}

      {preview && (
        <div className="panel">
          <div className="panel-head">
            <h2>3. المراجعة</h2>
            <div className="chips">
              {(['all', 'new', 'update', 'unchanged', 'error'] as const).map((k) => (
                <button key={k} className={`chip ${show === k ? 'active' : ''}`} onClick={() => setShow(k)}>
                  {k === 'all' ? 'الكل' : STATUS[k][0]}
                  <span className="count num">{k === 'all' ? preview.length : counts[k] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead><tr><th className="num">السطر</th><th>رقم البطاقة</th><th>الاسم</th><th className="num">الأفراد</th><th>الرقم السري</th><th>المخبز</th><th>الحالة</th></tr></thead>
              <tbody>
                {preview.filter((r) => show === 'all' || r.status === show).slice(0, 1000).map((r) => (
                  <tr key={r.line}>
                    <td className="num">{r.line}</td>
                    <td className="num">{r.cardNumber}</td>
                    <td>{r.holderName}</td>
                    <td className="num">{r.members ?? '—'}</td>
                    <td>{r.secretRef}</td>
                    <td>{r.bakery}</td>
                    <td>
                      <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                      {r.errors.length > 0 && <span className="small" style={{ color: 'var(--danger)', marginInlineStart: 6 }}>{r.errors.join('، ')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-body row">
            <label className="check grow">
              <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
              تحديث البطاقات الموجودة ({counts.update ?? 0}) — يُسجل كل تغيير في سجل البطاقة
            </label>
            {(counts.error ?? 0) > 0 && <span className="muted small">الصفوف التي بها أخطاء لن تُستورد.</span>}
            <button
              className="primary"
              disabled={!willApply}
              onClick={async () => {
                const r = await run(() => call('import.commit', { sheet: sheet!, mapping: full(), updateExisting }))
                if (r) {
                  await refresh()
                  setPreview(await call('import.preview', { sheet: sheet!, mapping: full() }))
                  toast(`تم الاستيراد: ${r.created} جديدة، ${r.updated} محدثة، ${r.skipped} متجاهلة`, 'success')
                }
              }}
            >
              اعتماد الاستيراد ({willApply})
            </button>
          </div>
        </div>
      )}
    </Page>
  )
}
