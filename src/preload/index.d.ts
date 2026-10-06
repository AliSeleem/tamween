import type { ApiMethod, ApiResponse } from '../shared/api'

declare global {
  interface Window {
    tamween: {
      call(method: ApiMethod, args: unknown): Promise<ApiResponse<unknown>>
      print(): Promise<void>
    }
  }
}

export {}
