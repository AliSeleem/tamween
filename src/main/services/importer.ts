import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import ExcelJS from 'exceljs'
import type { ImportMapping, ImportPreviewRow, ImportResult, ImportSheet } from '@shared/types'
import { arabicKey, normalizeDigits } from '@shared/util'
import { createCard, findCardByNumber, findCardBySecretAndName, updateCard } from './cards'
import type { Ctx } from './context'
import { AppError, audit, requireAdmin } from './context'

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    if ('text' in v && v.text != null) return String(v.text)
    if ('result' in v && v.result != null) return String(v.result)
    if ('richText' in v) return v.richText.map((r) => r.text).join('')
    if (v instanceof Date) return v.toISOString().slice(0, 10)
  }
  return String(v)
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const HINTS: Record<keyof ImportMapping, string[]> = {
  cardNumber: ['رقم البطاقه', 'رقم البطاقة', 'البطاقه', 'card'],
  holderName: ['اسم صاحب', 'صاحب البطاقه', 'الاسم', 'اسم', 'name'],
  secretRef: ['الرقم السري', 'رقم سري', 'السري', 'سري', 'الرقم القومي', 'البيان', 'pin'],
  bakery: ['المخبز', 'مخبز', 'bakery'],
  members: ['عدد الافراد', 'ع افراد', 'الافراد', 'افراد', 'members']
}

function matchHeaders(headers: string[]): Partial<ImportMapping> {
  const keys = headers.map(arabicKey)
  const out: Partial<ImportMapping> = {}
  const used = new Set<number>()
  // Most specific field first so "رقم سري" is not taken as the card number.
  for (const key of ['members', 'secretRef', 'bakery', 'cardNumber', 'holderName'] as (keyof ImportMapping)[]) {
    for (const hint of HINTS[key].map(arabicKey)) {
      const idx = keys.findIndex((h, i) => !used.has(i) && h.includes(hint))
      if (idx >= 0) {
        out[key] = idx
        used.add(idx)
        break
      }
    }
  }
  return out
}

export function guessMapping(headers: string[]): Partial<ImportMapping> {
  return matchHeaders(headers)
}

/** The header is the row among the first 20 that names the most known columns (titles often sit above it). */
function toSheet(fileName: string, sheetName: string, grid: string[][]): ImportSheet | null {
  let best = -1
  let bestScore = 0
  grid.slice(0, 20).forEach((row, i) => {
    const score = Object.keys(matchHeaders(row)).length
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  if (best < 0 || bestScore < 2) return null
  const headers = grid[best].map((h) => h.trim())
  // Blank rows in the middle stay so preview line numbers match the sheet; trailing ones are dropped.
  const rows = grid.slice(best + 1)
  while (rows.length && !rows[rows.length - 1].some((c) => c.trim() !== '')) rows.pop()
  if (!rows.length) return null
  return { fileName, sheetName, headerRow: best + 1, headers, rows }
}

/** Reads every worksheet of an .xlsx file (or a .csv) that has a recognizable header row. */
export async function readWorkbook(path: string): Promise<ImportSheet[]> {
  const ext = extname(path).toLowerCase()
  const fileName = basename(path)
  const sheets: ImportSheet[] = []
  if (ext === '.csv' || ext === '.txt') {
    const s = toSheet(fileName, fileName, parseCsv((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')))
    if (s) sheets.push(s)
  } else if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(path)
    for (const ws of wb.worksheets) {
      const grid: string[][] = []
      // Keep row positions so line numbers in the preview match the sheet.
      for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r)
        const cells: string[] = []
        for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value).trim())
        grid.push(cells)
      }
      const s = toSheet(fileName, ws.name, grid)
      if (s) sheets.push(s)
    }
  } else {
    throw new AppError('صيغة الملف غير مدعومة. احفظ الملف بصيغة xlsx أو csv')
  }
  if (!sheets.length) throw new AppError('لم أجد صف عناوين (الاسم، الرقم السري، عدد الأفراد…) في أي ورقة من الملف')
  return sheets
}

/** Kept for single-sheet callers: the sheet with the most rows. */
export async function readSheet(path: string): Promise<ImportSheet> {
  const sheets = await readWorkbook(path)
  return sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a))
}

export function previewImport(ctx: Ctx, sheet: ImportSheet, mapping: ImportMapping): ImportPreviewRow[] {
  const seen = new Map<string, number>()
  const col = (row: string[], idx: number | null): string => (idx == null ? '' : normalizeDigits(row[idx] ?? '').replace(/\s+/g, ' ').trim())
  const rows: ImportPreviewRow[] = []
  sheet.rows.forEach((row, i) => {
    const errors: string[] = []
    const cardNumber = col(row, mapping.cardNumber) || null
    const holderName = col(row, mapping.holderName)
    const secretRef = col(row, mapping.secretRef) || null
    const membersText = col(row, mapping.members)
    // Rows that are entirely blank in the mapped columns are separators, not data.
    if (!cardNumber && !holderName && !secretRef && !membersText) return
    const line = sheet.headerRow + 1 + i
    const members = /^\d+$/.test(membersText) ? Number(membersText) : null
    if (!holderName) errors.push('الاسم فارغ')
    if (mapping.cardNumber != null && !cardNumber) errors.push('رقم البطاقة فارغ')
    if (mapping.cardNumber == null && !secretRef) errors.push('الرقم السري فارغ')
    if (members == null || members < 1 || members > 30) errors.push('عدد الأفراد غير صحيح')
    const key = cardNumber ?? (secretRef && holderName ? `${secretRef}|${arabicKey(holderName)}` : null)
    if (key) {
      if (seen.has(key)) errors.push(`مكرر في الملف (السطر ${seen.get(key)})`)
      else seen.set(key, line)
    }
    const bakery = col(row, mapping.bakery) || null
    let status: ImportPreviewRow['status'] = 'new'
    if (errors.length) status = 'error'
    else {
      const existing = cardNumber ? findCardByNumber(ctx, cardNumber) : findCardBySecretAndName(ctx, secretRef!, holderName)
      if (existing) {
        const same = existing.holderName === holderName && existing.members === members && existing.secretRef === secretRef && existing.bakery === bakery
        status = same ? 'unchanged' : 'update'
      }
    }
    rows.push({ line, cardNumber, holderName, secretRef, bakery, members, status, errors })
  })
  return rows
}

/**
 * Applies a previewed import in one transaction. Existing cards are updated only when `updateExisting`
 * is set, through the normal update path so each change lands in the card history.
 */
export function commitImport(ctx: Ctx, sheet: ImportSheet, mapping: ImportMapping, updateExisting: boolean): ImportResult {
  requireAdmin(ctx)
  const preview = previewImport(ctx, sheet, mapping)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0 }
  ctx.db.tx(() => {
    for (const r of preview) {
      if (r.status === 'error' || r.status === 'unchanged' || (r.status === 'update' && !updateExisting)) {
        result.skipped++
        continue
      }
      const data = { cardNumber: r.cardNumber, holderName: r.holderName, secretRef: r.secretRef, bakery: r.bakery, members: r.members! }
      if (r.status === 'new') {
        createCard(ctx, { ...data, status: 'active', groupName: null }, `import:${sheet.fileName}/${sheet.sheetName}`)
        result.created++
      } else {
        const existing = (r.cardNumber ? findCardByNumber(ctx, r.cardNumber) : findCardBySecretAndName(ctx, r.secretRef!, r.holderName))!
        updateCard(ctx, existing.id, { ...existing, ...data }, `استيراد من ${sheet.fileName}`)
        result.updated++
      }
    }
    audit(ctx, 'import', 'cards', null, { file: sheet.fileName, ...result })
  })
  return result
}
