import { useState } from 'react'
import type { User } from '@shared/types'
import { call } from '../api'
import { ErrorBox, Field } from '../components/ui'

export function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="login">
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            onLogin(await call('auth.login', { username, password }))
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div>
          <h1>تموين</h1>
          <div className="muted">نظام إدارة وتشغيل محل التموين</div>
        </div>
        <Field label="اسم المستخدم">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label="كلمة المرور">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy || !username}>دخول</button>
      </form>
    </div>
  )
}
