import type { ReactNode } from 'react'
import { monthLabel } from '@shared/util'
import { useSession } from '../session'

/** Page header with the working-month selector shared by all operational screens. */
export function Page(props: { title: ReactNode; actions?: ReactNode; children: ReactNode; showMonth?: boolean }) {
  const { month, setMonth, periods } = useSession()
  return (
    <>
      <div className="topbar">
        <h1 className="title">{props.title}</h1>
        <div className="actions row">
          {props.actions}
          {props.showMonth !== false && periods.length > 0 && (
            <select value={month ?? ''} onChange={(e) => setMonth(e.target.value)} title="شهر العمل">
              {periods.map((p) => (
                <option key={p.month} value={p.month}>
                  {monthLabel(p.month)} {p.status === 'closed' ? '(مغلق)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="content">{props.children}</div>
    </>
  )
}
