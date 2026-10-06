import { contextBridge, ipcRenderer } from 'electron'
import type { ApiMethod, ApiResponse } from '@shared/api'

const bridge = {
  call: (method: ApiMethod, args: unknown): Promise<ApiResponse<unknown>> => ipcRenderer.invoke('api', method, args),
  print: (): Promise<void> => ipcRenderer.invoke('print')
}

contextBridge.exposeInMainWorld('tamween', bridge)

export type Bridge = typeof bridge
