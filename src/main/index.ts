import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ApiMethod, ApiResponse } from '@shared/api'
import { todayIso } from '@shared/util'
import { createHandlers, PUBLIC_METHODS } from './api'
import { Db } from './db/db'
import { AppError, type Ctx } from './services/context'
import { seedIfEmpty } from './services/seed'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: 'تموين',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  const dbPath = process.env.TAMWEEN_DB ?? join(app.getPath('userData'), 'tamween.sqlite')
  const db = new Db(dbPath)
  seedIfEmpty(db)
  const ctx: Ctx = { db, user: null }

  const handlers = createHandlers(ctx, {
    async pickImportFile() {
      const r = await dialog.showOpenDialog(win!, {
        title: 'اختر ملف البطاقات',
        properties: ['openFile'],
        filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv'] }]
      })
      return r.canceled ? null : r.filePaths[0]
    },
    async pickBackupPath() {
      const r = await dialog.showSaveDialog(win!, {
        title: 'حفظ نسخة احتياطية',
        defaultPath: `tamween-backup-${todayIso()}.sqlite`,
        filters: [{ name: 'SQLite', extensions: ['sqlite'] }]
      })
      return r.canceled || !r.filePath ? null : r.filePath
    }
  })

  ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown): Promise<ApiResponse<unknown>> => {
    try {
      const handler = handlers[method] as ((a: unknown) => unknown) | undefined
      if (!handler) throw new AppError(`طلب غير معروف: ${method}`)
      if (!ctx.user && !PUBLIC_METHODS.includes(method)) throw new AppError('يجب تسجيل الدخول أولاً')
      return { ok: true, data: await handler(args) }
    } catch (e) {
      if (!(e instanceof AppError)) console.error(`[api] ${method}`, e)
      const message = e instanceof AppError ? e.message : `حدث خطأ غير متوقع: ${(e as Error).message}`
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('print', async () => {
    win?.webContents.print({ silent: false, printBackground: true })
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('will-quit', () => db.close())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
