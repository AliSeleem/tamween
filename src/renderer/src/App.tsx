import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import type { User } from '@shared/types'
import { call } from './api'
import { Field, Modal, ToastProvider, useAction } from './components/ui'
import { AuditPage } from './pages/Audit'
import { CardDetailPage } from './pages/CardDetail'
import { CardsPage } from './pages/Cards'
import { DashboardPage } from './pages/Dashboard'
import { ImportPage } from './pages/Import'
import { InventoryPage } from './pages/Inventory'
import { LoginPage } from './pages/Login'
import { PosBatchPage, PosBatchesPage } from './pages/Pos'
import { ReceiptPage } from './pages/Receipt'
import { SettingsPage } from './pages/Settings'
import { TrackingPage } from './pages/Tracking'
import { SessionProvider, useSession } from './session'

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => {
    call('auth.me').then(setUser, () => setUser(null))
  }, [])
  if (user === undefined) return null
  return (
    <ToastProvider>
      {user ? (
        <SessionProvider
          user={user}
          onLogout={() => {
            void call('auth.logout').finally(() => setUser(null))
          }}
        >
          <HashRouter>
            <Shell onUserChange={setUser} />
          </HashRouter>
        </SessionProvider>
      ) : (
        <LoginPage onLogin={setUser} />
      )}
    </ToastProvider>
  )
}

function Shell({ onUserChange }: { onUserChange: (u: User) => void }) {
  const { user, isAdmin, logout } = useSession()
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          تموين
          <small>إدارة محل التموين</small>
        </div>
        <NavLink to="/" end>لوحة المتابعة</NavLink>
        <div className="section">التشغيل اليومي</div>
        <NavLink to="/receipt">الاستلام الفعلي</NavLink>
        <NavLink to="/pos">الضرب ودفعات التسوية</NavLink>
        <NavLink to="/tracking">متابعة البطاقات</NavLink>
        <div className="section">البيانات</div>
        <NavLink to="/cards">البطاقات</NavLink>
        <NavLink to="/inventory">المخزون</NavLink>
        {isAdmin && <NavLink to="/import">استيراد Excel</NavLink>}
        {isAdmin && (
          <>
            <div className="section">الإدارة</div>
            <NavLink to="/settings">الإعدادات والقواعد</NavLink>
            <NavLink to="/audit">سجل العمليات</NavLink>
          </>
        )}
        <div className="spacer" />
        <div className="user">
          {user.displayName} · {isAdmin ? 'مدير' : 'موظف'}
          <br />
          <button className="link small" style={{ color: '#cde7de', padding: 0 }} onClick={logout}>تسجيل الخروج</button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/receipt" element={<ReceiptPage />} />
          <Route path="/pos" element={<PosBatchesPage />} />
          <Route path="/pos/:id" element={<PosBatchPage />} />
          <Route path="/tracking" element={<TrackingPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/cards/:id" element={<CardDetailPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/import" element={isAdmin ? <ImportPage /> : <Navigate to="/" />} />
          <Route path="/settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" />} />
          <Route path="/audit" element={isAdmin ? <AuditPage /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      {user.mustChangePassword && <ChangePasswordModal onDone={() => onUserChange({ ...user, mustChangePassword: false })} />}
    </div>
  )
}

function ChangePasswordModal({ onDone }: { onDone: () => void }) {
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const run = useAction()
  return (
    <Modal
      title="تغيير كلمة المرور"
      onClose={() => {}}
      footer={
        <button
          className="primary"
          disabled={!newPassword || newPassword !== confirm}
          onClick={async () => {
            const ok = await run(() => call('auth.changePassword', { oldPassword, newPassword }).then(() => true), 'تم تغيير كلمة المرور')
            if (ok) onDone()
          }}
        >
          حفظ
        </button>
      }
    >
      <p className="muted" style={{ margin: 0 }}>يجب تغيير كلمة المرور الافتراضية قبل المتابعة.</p>
      <Field label="كلمة المرور الحالية"><input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus /></Field>
      <Field label="كلمة المرور الجديدة"><input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></Field>
      <Field label="تأكيد كلمة المرور"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      {confirm && newPassword !== confirm && <div className="alert danger">كلمتا المرور غير متطابقتين</div>}
    </Modal>
  )
}
