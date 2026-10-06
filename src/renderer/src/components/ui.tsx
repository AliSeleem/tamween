import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Card, PosStatus, ReceiptStatus } from '@shared/types'
import { formatMoney, cardLabel } from '@shared/util'
import { call } from '../api'

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog">
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="link" onClick={props.onClose} aria-label="إغلاق">✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${props.className ?? ''}`}>
      <span>{props.label}</span>
      {props.children}
    </label>
  )
}

export function Money({ value }: { value: number | null | undefined }) {
  return <span className="num">{formatMoney(value)}</span>
}

export function PosBadge({ status }: { status: PosStatus }) {
  if (status === 'struck') return <span className="badge ok">ضُربت</span>
  if (status === 'partial') return <span className="badge warn">ضُربت جزئيًا</span>
  return <span className="badge neutral">لم تُضرب</span>
}

export function ReceiptBadge({ status }: { status: ReceiptStatus }) {
  if (status === 'full') return <span className="badge ok">استلم كامل</span>
  if (status === 'partial') return <span className="badge warn">استلم جزئي</span>
  return <span className="badge neutral">لم يستلم</span>
}

export function Meter(props: { label: string; used: number; limit: number; unit: string; format?: (n: number) => string; threshold: number }) {
  const f = props.format ?? ((n: number) => n.toLocaleString('en-US'))
  const pct = props.limit > 0 ? Math.min(100, (props.used / props.limit) * 100) : 0
  const cls = props.used > props.limit ? 'over' : pct >= props.threshold ? 'warn' : ''
  return (
    <div className={`meter panel stat ${cls}`}>
      <div className="row">
        <div className="label grow">{props.label}</div>
        <span className="small muted num">{pct.toFixed(0)}٪</span>
      </div>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="figures">
        <span>المستخدم <b className="num">{f(props.used)}</b></span>
        <span>المتبقي <b className="num">{f(props.limit - props.used)}</b></span>
        <span>الحد <b className="num">{f(props.limit)}</b> {props.unit}</span>
      </div>
    </div>
  )
}

/* Toasts */
type ToastKind = 'info' | 'error' | 'success'
const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {})
export const useToast = (): ((message: string, kind?: ToastKind) => void) => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null)
  const timer = useRef<number>(undefined)
  const show = (message: string, kind: ToastKind = 'info'): void => {
    setToast({ message, kind })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3000)
  }
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.message}</div>}
    </ToastCtx.Provider>
  )
}

/** Runs an action, shows its error as a toast, and returns whether it succeeded. */
export function useAction(): <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined> {
  const toast = useToast()
  return async (fn, success) => {
    try {
      const r = await fn()
      if (success) toast(success, 'success')
      return r
    } catch (e) {
      toast((e as Error).message, 'error')
      return undefined
    }
  }
}

/** Search box for a card by number or name; Enter on an exact number selects it directly. */
export function CardPicker(props: { onPick: (card: Card) => void; autoFocus?: boolean; placeholder?: string }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Card[]>([])
  const [hl, setHl] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    let live = true
    const t = window.setTimeout(() => {
      call('cards.search', { query: q, limit: 12 }).then((r) => {
        if (live) {
          setResults(r.rows)
          setHl(0)
          setOpen(true)
        }
      }).catch(() => {})
    }, 150)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [q])
  const pick = (c: Card): void => {
    props.onPick(c)
    setQ('')
    setResults([])
    setOpen(false)
  }
  return (
    <div className="picker">
      <input
        className="search"
        style={{ width: '100%' }}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder ?? 'ابحث برقم البطاقة أو الاسم…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, results.length - 1))
          else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0))
          else if (e.key === 'Enter' && results[hl]) pick(results[hl])
        }}
      />
      {open && results.length > 0 && (
        <div className="results">
          {results.map((c, i) => (
            <div key={c.id} className={i === hl ? 'hl' : ''} onMouseDown={() => pick(c)}>
              <b className="num">{cardLabel(c)}</b>
              <span className="grow">{c.holderName}</span>
              <span className="muted small">{c.members} أفراد</span>
              {c.status !== 'active' && <span className="badge danger">{c.status === 'suspended' ? 'موقوفة' : 'ملغاة'}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Asks for a reason and runs a void/reversal. Operations are never deleted (PRD §18). */
export function VoidDialog(props: { title: string; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>تراجع</button>
          <button
            className="danger"
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true)
              await props.onConfirm(reason)
              setBusy(false)
            }}
          >
            تأكيد الإلغاء
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>العملية لن تُحذف؛ ستُسجل عملية عكسية بنفس الكميات مع السبب واسم المستخدم.</p>
      <Field label="سبب الإلغاء">
        <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert danger">{error}</div> : null
}
