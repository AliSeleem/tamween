import { invoke } from '@tauri-apps/api/core'
import type { ApiMethod, ApiResponse } from '@shared/api'

/** The one channel to the Rust side: the same method names and response shape the app always had. */
export const bridge = {
  call: (method: ApiMethod, args: unknown): Promise<ApiResponse<unknown>> =>
    invoke<ApiResponse<unknown>>('api', { method, args: args ?? null }).catch((e) => ({
      ok: false as const,
      error: `تعذر الاتصال بالنظام: ${String(e)}`
    })),
  /** Opens the webview's print dialog for the current screen. */
  print: (): void => window.print()
}
