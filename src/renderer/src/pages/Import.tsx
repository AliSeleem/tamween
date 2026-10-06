import { useEffect, useState } from 'react'
import type { ImportMapping, ImportPreviewRow, ImportSheet } from '@shared/types'
import { call } from '../api'
import { Page } from '../components/Page'
import { Field, useAction, useToast } from '../components/ui'
import { useSession } from '../session'

const FIELDS: [keyof ImportMapping, string, boolean][] = [
  ['holderName', 'اسم صاحب البطاقة', true],
  ['members', 'عدد الأفراد', true],
  ['secretRef', 'الرقم السري / البيان التعريفي', false],
  ['cardNumber', 'رقم البطاقة', false],
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
  const [sheets, setSheets] = useState<{ sheet: ImportSheet; mapping: Partial<ImportMapping> }[]>([])
  const [sheet, setSheet] = useState<ImportSheet | null>(null)
  const [mapping, setMapping] = useState<Partial<ImportMapping>>({})
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null)
  const [updateExisting, setUpdateExisting] = useState(false)
  const [show, setShow] = useState<ImportPreviewRow['status'] | 'all'>('all')
  const run = useAction()
  const toast = useToast()
  const complete = mapping.holderName != null && mapping.members != null && (mapping.cardNumber != null || mapping.secretRef != null)
  const full = (): ImportMapping => ({ cardNumber: null, secretRef: null, bakery: null, ...mapping }) as ImportMapping
  const choose = (i: number): void => {
    setSheet(sheets[i].sheet)
    setMapping(sheets[i].mapping)
  }

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
          <div className="muted small">ملف xlsx أو csv. يُكتشف صف العناوين تلقائيًا حتى لو كان فوقه عنوان المكتب أو اسم التاجر.</div>
        </div>
        {sheet && sheets.length > 1 && (
          <select value={sheet.sheetName} onChange={(e) => choose(sheets.findIndex((s) => s.sheet.sheetName === e.target.value))}>
            {sheets.map((s) => (
              <option key={s.sheet.sheetName} value={s.sheet.sheetName}>
                {s.sheet.sheetName} · {s.sheet.rows.length} صف
              </option>
            ))}
          </select>
        )}
        {sheet && <span className="badge neutral">{sheet.fileName} · العناوين في الصف {sheet.headerRow}</span>}
        <button
          className="primary"
          onClick={async () => {
            const r = await run(() => call('import.pickFile'))
            if (r) {
              setSheets(r.sheets)
              // Start from the sheet with the most rows; the others stay selectable.
              const best = r.sheets.reduce((a, s, i) => (s.sheet.rows.length > r.sheets[a].sheet.rows.length ? i : a), 0)
              setSheet(r.sheets[best].sheet)
              setMapping(r.sheets[best].mapping)
            }
          }}
        >
          اختيار ملف…
        </button>
      </div>

      {sheet && (
        <div className="panel">
          <div className="panel-head"><h2>2. ربط الأعمدة</h2><span className="muted small">يلزم رقم البطاقة أو الرقم السري. بدون رقم البطاقة تُعرف البطاقة بالاسم مع الرقم السري.</span></div>
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
                    <td className="num">{r.cardNumber ?? '—'}</td>
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
