import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import ExcelJS from 'exceljs'
import type { ImportMapping, ImportPreviewRow, ImportResult, ImportSheet } from '@shared/types'
import { normalizeDigits } from '@shared/util'
import { createCard, findCardByNumber, updateCard } from './cards'
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

/** Reads the first worksheet of an .xlsx file (or a .csv) into a header row and data rows. */
export async function readSheet(path: string): Promise<ImportSheet> {
  const ext = extname(path).toLowerCase()
  let grid: string[][]
  if (ext === '.csv' || ext === '.txt') {
    grid = parseCsv((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  } else if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(path)
    const ws = wb.worksheets[0]
    if (!ws) throw new AppError('الملف لا يحتوي على أوراق عمل')
    grid = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value).trim())
      grid.push(cells)
    })
  } else {
    throw new AppError('صيغة الملف غير مدعومة. احفظ الملف بصيغة xlsx أو csv')
  }
  grid = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (grid.length < 2) throw new AppError('الملف فارغ أو لا يحتوي على بيانات بعد صف العناوين')
  const [headers, ...rows] = grid
  return { fileName: basename(path), headers: headers.map((h) => h.trim()), rows }
}

const HINTS: Record<keyof ImportMapping, string[]> = {
  cardNumber: ['رقم البطاقة', 'رقم البطاقه', 'البطاقة', 'card'],
  holderName: ['الاسم', 'اسم صاحب', 'صاحب البطاقة', 'name'],
  secretRef: ['الرقم السري', 'السري', 'الرقم القومي', 'البيان', 'pin'],
  bakery: ['المخبز', 'مخبز', 'bakery'],
  members: ['عدد الأفراد', 'الأفراد', 'افراد', 'أفراد', 'العدد', 'members']
}

export function guessMapping(headers: string[]): Partial<ImportMapping> {
  const out: Partial<ImportMapping> = {}
  const used = new Set<number>()
  for (const key of Object.keys(HINTS) as (keyof ImportMapping)[]) {
    for (const hint of HINTS[key]) {
      const idx = headers.findIndex((h, i) => !used.has(i) && h.toLowerCase().includes(hint.toLowerCase()))
      if (idx >= 0) { out[key] = idx; used.add(idx); break }
    }
  }
  return out
}

export function previewImport(ctx: Ctx, sheet: ImportSheet, mapping: ImportMapping): ImportPreviewRow[] {
  const seen = new Map<string, number>()
  const col = (row: string[], idx: number | null): string => (idx == null ? '' : normalizeDigits(row[idx] ?? '').trim())
  return sheet.rows.map((row, i) => {
    const line = i + 2
    const errors: string[] = []
    const cardNumber = col(row, mapping.cardNumber)
    const holderName = col(row, mapping.holderName)
    const membersText = col(row, mapping.members)
    const members = /^\d+$/.test(membersText) ? Number(membersText) : null
    if (!cardNumber) errors.push('رقم البطاقة فارغ')
    if (!holderName) errors.push('الاسم فارغ')
    if (members == null || members < 1 || members > 30) errors.push('عدد الأفراد غير صحيح')
    if (cardNumber) {
      if (seen.has(cardNumber)) errors.push(`رقم البطاقة مكرر في الملف (السطر ${seen.get(cardNumber)})`)
      else seen.set(cardNumber, line)
    }
    const secretRef = col(row, mapping.secretRef) || null
    const bakery = col(row, mapping.bakery) || null
    let status: ImportPreviewRow['status'] = 'new'
    if (errors.length) status = 'error'
    else {
      const existing = findCardByNumber(ctx, cardNumber)
      if (existing) {
        const same = existing.holderName === holderName && existing.members === members && existing.secretRef === secretRef && existing.bakery === bakery
        status = same ? 'unchanged' : 'update'
      }
    }
    return { line, cardNumber, holderName, secretRef, bakery, members, status, errors }
  })
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
        createCard(ctx, { ...data, status: 'active', groupName: null }, `import:${sheet.fileName}`)
        result.created++
      } else {
        const existing = findCardByNumber(ctx, r.cardNumber)!
        updateCard(ctx, existing.id, { ...existing, ...data }, `استيراد من ${sheet.fileName}`)
        result.updated++
      }
    }
    audit(ctx, 'import', 'cards', null, { file: sheet.fileName, ...result })
  })
  return result
}
