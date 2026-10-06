import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiArgs, ApiMethod, ApiResult } from '@shared/api'

export async function call<K extends ApiMethod>(method: K, ...args: ApiArgs<K> extends void ? [] : [ApiArgs<K>]): Promise<ApiResult<K>> {
  const r = await window.tamween.call(method, args[0])
  if (!r.ok) throw new Error(r.error)
  return r.data as ApiResult<K>
}

/** Loads an API method and reloads when `deps` change. */
export function useApi<K extends ApiMethod>(
  method: K,
  args: ApiArgs<K>,
  deps: unknown[] = [],
  enabled = true
): { data: ApiResult<K> | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<ApiResult<K>>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const argsRef = useRef(args)
  argsRef.current = args

  const load = useCallback(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const id = ++seq.current
    setLoading(true)
    window.tamween.call(method, argsRef.current).then((r) => {
      if (id !== seq.current) return
      if (r.ok) {
        setData(r.data as ApiResult<K>)
        setError(null)
      } else setError(r.error)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, enabled, ...deps])

  useEffect(load, [load])
  return { data, error, loading, reload: load }
}
