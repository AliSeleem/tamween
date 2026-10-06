import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Card, CardInput, CardStatus } from '@shared/types'
import { call, useApi } from '../api'
import { Page } from '../components/Page'
import { Empty, ErrorBox, Field, Modal, useAction } from '../components/ui'

export const CARD_STATUS_LABEL: Record<CardStatus, string> = { active: 'نشطة', suspended: 'موقوفة', cancelled: 'ملغاة' }
const PAGE = 50

export function CardsPage() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<CardStatus | 'all'>('all')
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<Card | 'new' | null>(null)
  const nav = useNavigate()
  const { data, error, reload } = useApi('cards.search', { query, status, limit: PAGE, offset }, [query, status, offset])
  return (
    <Page title="البطاقات" showMonth={false} actions={<button className="primary" onClick={() => setEditing('new')}>+ بطاقة جديدة</button>}>
      <div className="panel">
        <div className="panel-head">
          <input className="search" placeholder="ابحث برقم البطاقة أو الاسم…" value={query} autoFocus onChange={(e) => { setQuery(e.target.value); setOffset(0) }} />
          <select value={status} onChange={(e) => { setStatus(e.target.value as CardStatus | 'all'); setOffset(0) }}>
            <option value="all">كل الحالات</option>
            <option value="active">نشطة</option>
            <option value="suspended">موقوفة</option>
            <option value="cancelled">ملغاة</option>
          </select>
          <span className="grow" />
          {data && <span className="muted">{data.total.toLocaleString('en-US')} بطاقة</span>}
        </div>
        <ErrorBox error={error} />
        {data && data.rows.length === 0 ? (
          <Empty>لا توجد بطاقات. أضف بطاقة أو استورد ملف Excel.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>رقم البطاقة</th><th>صاحب البطاقة</th><th className="num">الأفراد</th><th>المخبز</th><th>الحالة</th><th>آخر تحديث</th></tr>
              </thead>
              <tbody>
                {data?.rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => nav(`/cards/${c.id}`)}>
                    <td className="num"><b>{c.cardNumber}</b></td>
                    <td>{c.holderName}</td>
                    <td className="num">{c.members}</td>
                    <td>{c.bakery ?? '—'}</td>
                    <td><span className={`badge ${c.status === 'active' ? 'ok' : 'danger'}`}>{CARD_STATUS_LABEL[c.status]}</span></td>
                    <td className="muted small num">{c.updatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > PAGE && (
          <div className="panel-body row end">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>السابق</button>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, data.total)} من {data.total}</span>
            <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>التالي</button>
          </div>
        )}
      </div>
      {editing && (
        <CardForm
          card={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null)
            reload()
            if (editing === 'new') nav(`/cards/${c.id}`)
          }}
        />
      )}
    </Page>
  )
}

export function CardForm(props: { card: Card | null; onClose: () => void; onSaved: (c: Card) => void }) {
  const [form, setForm] = useState<CardInput>(
    props.card ?? { cardNumber: '', holderName: '', secretRef: null, bakery: null, members: 1, status: 'active', groupName: null }
  )
  const [reason, setReason] = useState('')
  const run = useAction()
  const set = <K extends keyof CardInput>(k: K, v: CardInput[K]): void => setForm({ ...form, [k]: v })
  const membersChanged = props.card && props.card.members !== form.members
  return (
    <Modal
      title={props.card ? `تعديل البطاقة ${props.card.cardNumber}` : 'بطاقة جديدة'}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>إلغاء</button>
          <button
            className="primary"
            onClick={async () => {
              const saved = await run(
                () => (props.card ? call('cards.update', { id: props.card.id, card: form, reason: reason || undefined }) : call('cards.create', form)),
                'تم الحفظ'
              )
              if (saved) props.onSaved(saved)
            }}
          >
            حفظ
          </button>
        </>
      }
    >
      <div className="grid cols-2">
        <Field label="رقم البطاقة"><input value={form.cardNumber} onChange={(e) => set('cardNumber', e.target.value)} autoFocus /></Field>
        <Field label="اسم صاحب البطاقة"><input value={form.holderName} onChange={(e) => set('holderName', e.target.value)} /></Field>
        <Field label="عدد الأفراد"><input type="number" min={1} value={form.members} onChange={(e) => set('members', Number(e.target.value))} /></Field>
        <Field label="الرقم السري / البيان التعريفي"><input value={form.secretRef ?? ''} onChange={(e) => set('secretRef', e.target.value)} /></Field>
        <Field label="المخبز"><input value={form.bakery ?? ''} onChange={(e) => set('bakery', e.target.value)} /></Field>
        <Field label="المجموعة / المصدر"><input value={form.groupName ?? ''} onChange={(e) => set('groupName', e.target.value)} /></Field>
        <Field label="الحالة">
          <select value={form.status} onChange={(e) => set('status', e.target.value as CardStatus)}>
            <option value="active">نشطة</option>
            <option value="suspended">موقوفة</option>
            <option value="cancelled">ملغاة</option>
          </select>
        </Field>
      </div>
      {props.card && (
        <Field label="سبب التعديل (يُسجل في سجل البطاقة)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      )}
      {membersChanged && (
        <div className="alert info">تغيير عدد الأفراد لا يغيّر استحقاق الشهر الجاري. يُطبق من الشهر الذي يُفتح بعد التعديل.</div>
      )}
    </Modal>
  )
}
