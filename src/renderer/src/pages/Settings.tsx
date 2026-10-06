import { useEffect, useState } from 'react'
import type { AppSettings, PeriodConfig, Product, Role, User } from '@shared/types'
import { addMonths, currentMonth, formatMoney, monthLabel, parseMoney } from '@shared/util'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { ErrorBox, Field, Modal, useAction, useToast } from '../components/ui'
import { useSession } from '../session'

type Tab = 'periods' | 'rules' | 'products' | 'users' | 'general'

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('periods')
  return (
    <Page title="الإعدادات والقواعد" showMonth={false}>
      <div className="panel">
        <div className="tabs">
          {([
            ['periods', 'الشهور'],
            ['rules', 'الاستحقاق والأسعار'],
            ['products', 'الأصناف'],
            ['users', 'المستخدمون'],
            ['general', 'عام والنسخ الاحتياطي']
          ] as [Tab, string][]).map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'periods' && <PeriodsTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'products' && <ProductsTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'general' && <GeneralTab />}
        </div>
      </div>
    </Page>
  )
}

function PeriodsTab() {
  const { periods, refresh, setMonth } = useSession()
  const latest = periods[0]?.month
  const [month, setNewMonth] = useState(latest ? addMonths(latest, 1) : currentMonth())
  const [closing, setClosing] = useState<string | null>(null)
  const run = useAction()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row">
        <Field label="فتح شهر جديد"><input type="month" value={month} onChange={(e) => setNewMonth(e.target.value)} /></Field>
        <button
          className="primary"
          style={{ alignSelf: 'flex-end' }}
          onClick={async () => {
            const p = await run(() => call('periods.open', { month }), `تم فتح ${monthLabel(month)}`)
            if (p) {
              await refresh()
              setMonth(p.month)
            }
          }}
        >
          فتح الشهر
        </button>
        <div className="muted small grow" style={{ alignSelf: 'flex-end' }}>
          فتح الشهر يأخذ لقطة بعدد أفراد كل بطاقة نشطة الآن ويحسب استحقاقها بقواعد الشهر (تُنسخ من الشهر السابق ويمكن تعديلها).
        </div>
      </div>
      <table>
        <thead><tr><th>الشهر</th><th>الحالة</th><th className="num">البطاقات</th><th>تاريخ الفتح</th><th>تاريخ الإغلاق</th><th /></tr></thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.month}>
              <td>{monthLabel(p.month)}</td>
              <td>{p.status === 'open' ? <span className="badge ok">مفتوح</span> : <span className="badge neutral">مغلق</span>}</td>
              <td className="num">{p.cardCount}</td>
              <td className="num small">{p.openedAt}</td>
              <td className="num small">{p.closedAt ?? '—'}</td>
              <td>{p.status === 'open' && <button className="small danger" onClick={() => setClosing(p.month)}>إغلاق الشهر</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {closing && (
        <Modal
          title={`إغلاق ${monthLabel(closing)}`}
          onClose={() => setClosing(null)}
          footer={
            <>
              <button onClick={() => setClosing(null)}>تراجع</button>
              <button
                className="danger"
                onClick={async () => {
                  const ok = await run(() => call('periods.close', { month: closing }).then(() => true), 'تم إغلاق الشهر')
                  if (ok) {
                    setClosing(null)
                    await refresh()
                  }
                }}
              >
                تأكيد الإغلاق
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            بعد الإغلاق لن تُقبل عمليات ضرب أو استلام على هذا الشهر. الرصيد المتبقي لكل مواطن يُرحّل إلى {monthLabel(addMonths(closing, 1))} للأصناف
            التي تسمح بالترحيل، وينتهي لغيرها. يجب إغلاق دفعات الضرب المفتوحة أولًا.
          </p>
        </Modal>
      )}
    </div>
  )
}

function RulesTab() {
  const { periods, products, month: workingMonth } = useSession()
  const [month, setMonth] = useState(workingMonth ?? periods[0]?.month ?? '')
  const { data, error, reload } = useApi('periods.config', { month }, [month], !!month)
  const [draft, setDraft] = useState<PeriodConfig | null>(null)
  const [maxMembers, setMaxMembers] = useState(7)
  const run = useAction()
  const period = periods.find((p) => p.month === month)
  const editable = period?.status === 'open'
  useEffect(() => {
    if (data) {
      setDraft(data)
      setMaxMembers(Math.max(7, ...data.rules.map((r) => r.members), ...data.cardValues.map((v) => v.members)))
    }
  }, [data])
  if (!month) return <div className="muted">افتح شهرًا أولًا.</div>
  if (!draft) return <ErrorBox error={error} />

  const ruleProducts = products.filter((p) => p.active && (p.limitKey || draft.rules.some((r) => r.productId === p.id)))
  const qty = (pid: number, m: number): string => String(draft.rules.find((r) => r.productId === pid && r.members === m)?.quantity ?? '')
  const setQty = (pid: number, m: number, v: string): void => {
    const rules = draft.rules.filter((r) => !(r.productId === pid && r.members === m))
    if (v !== '') rules.push({ productId: pid, members: m, quantity: Number(v) })
    setDraft({ ...draft, rules })
  }
  const value = (m: number): string => {
    const v = draft.cardValues.find((x) => x.members === m)
    return v ? formatMoney(v.valuePiasters).replace(/,/g, '') : ''
  }
  const setValue = (m: number, v: string): void => {
    const cardValues = draft.cardValues.filter((x) => x.members !== m)
    const p = parseMoney(v)
    if (p != null) cardValues.push({ members: m, valuePiasters: p })
    setDraft({ ...draft, cardValues })
  }
  const price = (pid: number): string => {
    const v = draft.prices.find((x) => x.productId === pid)
    return v ? formatMoney(v.pricePiasters).replace(/,/g, '') : ''
  }
  const setPrice = (pid: number, v: string): void => {
    const prices = draft.prices.filter((x) => x.productId !== pid)
    const p = parseMoney(v)
    if (p != null) prices.push({ productId: pid, pricePiasters: p })
    setDraft({ ...draft, prices })
  }
  const members = Array.from({ length: maxMembers }, (_, i) => i + 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row">
        <Field label="الشهر">
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {periods.map((p) => <option key={p.month} value={p.month}>{monthLabel(p.month)}</option>)}
          </select>
        </Field>
        <div className="grow muted small" style={{ alignSelf: 'flex-end' }}>
          {editable ? 'حفظ التعديل على شهر مفتوح يعدّل استحقاق كل بطاقات الشهر بحركات تسوية مسجلة.' : 'الشهر مغلق؛ القواعد للعرض فقط.'}
        </div>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <h3 style={{ marginBottom: 8 }}>الاستحقاق وقيمة البطاقة حسب عدد الأفراد</h3>
          <table>
            <thead>
              <tr>
                <th>الأفراد</th>
                {ruleProducts.map((p) => <th key={p.id}>{p.name} ({p.unit})</th>)}
                <th>قيمة البطاقة (ج)</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m}>
                  <td className="num">{m}{m === maxMembers ? '+' : ''}</td>
                  {ruleProducts.map((p) => (
                    <td key={p.id}><input className="qty" type="number" min={0} disabled={!editable} value={qty(p.id, m)} onChange={(e) => setQty(p.id, m, e.target.value)} /></td>
                  ))}
                  <td><input className="money" disabled={!editable} value={value(m)} onChange={(e) => setValue(m, e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {editable && <button className="small" style={{ marginTop: 8 }} onClick={() => setMaxMembers(maxMembers + 1)}>+ صف</button>}
          <p className="muted small">البطاقات التي أفرادها أكثر من آخر صف تأخذ قيم آخر صف.</p>
        </div>
        <div>
          <h3 style={{ marginBottom: 8 }}>أسعار الأصناف على الـPOS (ج للوحدة)</h3>
          <table>
            <tbody>
              {products.filter((p) => p.active).map((p) => (
                <tr key={p.id}>
                  <td>{p.name} <span className="muted small">({p.unit})</span></td>
                  <td><input className="money" disabled={!editable} value={price(p.id)} onChange={(e) => setPrice(p.id, e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editable && (
        <div className="row end">
          <button onClick={reload}>تراجع عن التعديلات</button>
          <button className="primary" onClick={() => run(() => call('periods.saveConfig', draft).then(reload), 'تم حفظ قواعد الشهر')}>حفظ</button>
        </div>
      )}
    </div>
  )
}

function ProductsTab() {
  const { products, refresh } = useSession()
  const [editing, setEditing] = useState<(Omit<Product, 'id'> & { id?: number }) | null>(null)
  const run = useAction()
  return (
    <>
      <div className="row end" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setEditing({ name: '', unit: 'عبوة', limitKey: null, carryoverAllowed: true, active: true, sortOrder: products.length + 1 })}>+ صنف</button>
      </div>
      <table>
        <thead><tr><th>الصنف</th><th>الوحدة</th><th>حد الدفعة</th><th>يسمح بالترحيل</th><th>الحالة</th><th /></tr></thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.unit}</td>
              <td>{p.limitKey === 'sugar' ? 'حد السكر' : p.limitKey === 'oil' ? 'حد الزيت' : '—'}</td>
              <td>{p.carryoverAllowed ? 'نعم' : 'لا'}</td>
              <td>{p.active ? <span className="badge ok">نشط</span> : <span className="badge neutral">موقوف</span>}</td>
              <td><button className="small" onClick={() => setEditing(p)}>تعديل</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal
          title={editing.id ? `تعديل ${editing.name}` : 'صنف جديد'}
          onClose={() => setEditing(null)}
          footer={
            <button
              className="primary"
              onClick={async () => {
                const ok = await run(() => call('products.save', editing).then(() => true), 'تم الحفظ')
                if (ok) {
                  setEditing(null)
                  await refresh()
                }
              }}
            >
              حفظ
            </button>
          }
        >
          <div className="grid cols-2">
            <Field label="الاسم"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus /></Field>
            <Field label="الوحدة"><input value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} /></Field>
            <Field label="يُحسب على حد الدفعة">
              <select value={editing.limitKey ?? ''} onChange={(e) => setEditing({ ...editing, limitKey: (e.target.value || null) as Product['limitKey'] })}>
                <option value="">لا</option>
                <option value="sugar">حد السكر</option>
                <option value="oil">حد الزيت</option>
              </select>
            </Field>
            <Field label="الترتيب"><input type="number" value={editing.sortOrder} onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={editing.carryoverAllowed} onChange={(e) => setEditing({ ...editing, carryoverAllowed: e.target.checked })} /> الرصيد غير المستلم يُرحّل للشهر التالي</label>
          <label className="check"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> نشط</label>
        </Modal>
      )}
    </>
  )
}

function UsersTab() {
  const { data, reload } = useApi('users.list', undefined)
  const [editing, setEditing] = useState<{ id?: number; username: string; displayName: string; role: Role; active: boolean; password?: string } | null>(null)
  const run = useAction()
  return (
    <>
      <div className="row end" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => setEditing({ username: '', displayName: '', role: 'clerk', active: true, password: '' })}>+ مستخدم</button>
      </div>
      <table>
        <thead><tr><th>اسم المستخدم</th><th>الاسم</th><th>الصلاحية</th><th>الحالة</th><th /></tr></thead>
        <tbody>
          {data?.map((u: User) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.displayName}</td>
              <td>{u.role === 'admin' ? 'مدير' : 'موظف'}</td>
              <td>{u.active ? <span className="badge ok">نشط</span> : <span className="badge neutral">موقوف</span>}</td>
              <td><button className="small" onClick={() => setEditing({ ...u, password: '' })}>تعديل</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal
          title={editing.id ? `تعديل ${editing.username}` : 'مستخدم جديد'}
          onClose={() => setEditing(null)}
          footer={
            <button
              className="primary"
              onClick={async () => {
                const ok = await run(() => call('users.save', { ...editing, password: editing.password || undefined }).then(() => true), 'تم الحفظ')
                if (ok) {
                  setEditing(null)
                  reload()
                }
              }}
            >
              حفظ
            </button>
          }
        >
          <div className="grid cols-2">
            <Field label="اسم المستخدم"><input value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} autoFocus /></Field>
            <Field label="الاسم الظاهر"><input value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} /></Field>
            <Field label="الصلاحية">
              <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}>
                <option value="clerk">موظف</option>
                <option value="admin">مدير</option>
              </select>
            </Field>
            <Field label={editing.id ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور'}>
              <input type="password" value={editing.password ?? ''} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> نشط</label>
          <p className="muted small" style={{ margin: 0 }}>سيُطلب من المستخدم تغيير كلمة المرور عند أول دخول.</p>
        </Modal>
      )}
    </>
  )
}

function GeneralTab() {
  const { data } = useApi('settings.get', undefined)
  const { refresh, setMonth } = useSession()
  const toast = useToast()
  const [s, setS] = useState<AppSettings | null>(null)
  const [money, setMoney] = useState('')
  const run = useAction()
  useEffect(() => {
    if (data) {
      setS(data)
      setMoney(formatMoney(data.defaultMoneyLimitPiasters).replace(/,/g, ''))
    }
  }, [data])
  if (!s) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid cols-3">
        <Field label="اسم المحل"><input value={s.shopName} onChange={(e) => setS({ ...s, shopName: e.target.value })} /></Field>
        <Field label="الحد المالي الافتراضي للدفعة (ج)"><input className="money" value={money} onChange={(e) => setMoney(e.target.value)} /></Field>
        <Field label="حد السكر الافتراضي"><input type="number" value={s.defaultSugarLimit} onChange={(e) => setS({ ...s, defaultSugarLimit: Number(e.target.value) })} /></Field>
        <Field label="حد الزيت الافتراضي"><input type="number" value={s.defaultOilLimit} onChange={(e) => setS({ ...s, defaultOilLimit: Number(e.target.value) })} /></Field>
        <Field label="التنبيه عند الوصول إلى (٪ من الحد)"><input type="number" value={s.alertThresholdPercent} onChange={(e) => setS({ ...s, alertThresholdPercent: Number(e.target.value) })} /></Field>
      </div>
      <div className="row end">
        <button
          className="primary"
          onClick={() => {
            const p = parseMoney(money)
            void run(() => call('settings.save', { ...s, defaultMoneyLimitPiasters: p ?? s.defaultMoneyLimitPiasters }), 'تم الحفظ')
          }}
        >
          حفظ
        </button>
      </div>
      <div className="alert info">
        <span className="grow">النسخة الاحتياطية تحفظ قاعدة البيانات كاملة في ملف واحد يمكن نقله إلى فلاشة أو جهاز آخر.</span>
        <button
          onClick={async () => {
            const r = await run(() => call('backup.create'))
            if (r) toast(`تم حفظ النسخة الاحتياطية في ${r.path}`, 'success')
          }}
        >
          نسخة احتياطية الآن…
        </button>
      </div>
      <div className="alert warning">
        <span className="grow">للتجربة فقط: تحميل 12 بطاقة وشهر مفتوح وأسعار ودفعة ضرب وعمليات استلام. يعمل على قاعدة بيانات فارغة فقط.</span>
        <button
          onClick={async () => {
            const r = await run(() => call('demo.load'), 'تم تحميل البيانات التجريبية')
            if (r) {
              await refresh()
              setMonth(r.month)
            }
          }}
        >
          تحميل بيانات تجريبية
        </button>
      </div>
    </div>
  )
}
