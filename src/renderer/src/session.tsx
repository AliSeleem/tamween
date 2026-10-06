import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Period, Product, User } from '@shared/types'
import { call } from './api'

interface Session {
  user: User
  isAdmin: boolean
  /** working month for POS, receipts and tracking */
  month: string | null
  setMonth: (m: string) => void
  periods: Period[]
  products: Product[]
  refresh: () => Promise<void>
  logout: () => void
}

const SessionCtx = createContext<Session | null>(null)

export function useSession(): Session {
  const s = useContext(SessionCtx)
  if (!s) throw new Error('no session')
  return s
}

const MONTH_KEY = 'tamween.month'

export function SessionProvider(props: { user: User; onLogout: () => void; children: ReactNode }) {
  const [periods, setPeriods] = useState<Period[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [month, setMonthState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MONTH_KEY)
    } catch {
      return null
    }
  })

  const refresh = useCallback(async () => {
    const [ps, prods] = await Promise.all([call('periods.list'), call('products.list')])
    setPeriods(ps)
    setProducts(prods)
    setMonthState((m) => {
      if (m && ps.some((p) => p.month === m)) return m
      return ps.find((p) => p.status === 'open')?.month ?? ps[0]?.month ?? null
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setMonth = (m: string): void => {
    setMonthState(m)
    try {
      localStorage.setItem(MONTH_KEY, m)
    } catch {
      /* per-device convenience only */
    }
  }

  const value: Session = {
    user: props.user,
    isAdmin: props.user.role === 'admin',
    month,
    setMonth,
    periods,
    products,
    refresh,
    logout: props.onLogout
  }
  return <SessionCtx.Provider value={value}>{props.children}</SessionCtx.Provider>
}
