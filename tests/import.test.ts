import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { commitImport, guessMapping, previewImport, readSheet } from '../src/main/services/importer'
import { addCard, setup } from './helpers'

describe('Excel import', () => {
  it('reads xlsx, guesses Arabic headers, validates and imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamween-'))
    const path = join(dir, 'cards.xlsx')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('بطاقات')
    ws.addRow(['م', 'رقم البطاقة', 'اسم صاحب البطاقة', 'الرقم السري', 'المخبز', 'عدد الأفراد'])
    ws.addRow([1, '١٠٠١', 'أحمد', '1234', 'مخبز النور', 4]) // Arabic-Indic digits are normalized
    ws.addRow([2, '1002', 'منى', '', 'مخبز النور', 2])
    ws.addRow([3, '1002', 'مكرر', '', '', 3])
    ws.addRow([4, '1003', '', '', '', 'x'])
    ws.addRow([5, '9000', 'اسم جديد', '', '', 5])
    await wb.xlsx.writeFile(path)

    const env = setup()
    addCard(env, '9000', 5)
    const sheet = await readSheet(path)
    const mapping = guessMapping(sheet.headers)
    expect(mapping).toEqual({ cardNumber: 1, holderName: 2, secretRef: 3, bakery: 4, members: 5 })
    const full = { secretRef: null, bakery: null, ...mapping } as Parameters<typeof previewImport>[2]
    const preview = previewImport(env.ctx, sheet, full)
    expect(preview.map((r) => r.status)).toEqual(['new', 'new', 'error', 'error', 'update'])
    expect(preview[0].cardNumber).toBe('1001')
    expect(preview[2].errors[0]).toMatch(/مكرر/)

    expect(commitImport(env.ctx, sheet, full, false)).toEqual({ created: 2, updated: 0, skipped: 3 })
    expect(commitImport(env.ctx, sheet, full, true)).toEqual({ created: 0, updated: 1, skipped: 4 })
    const updated = env.call('cards.findByNumber', { cardNumber: '9000' })!
    expect(updated.holderName).toBe('اسم جديد')
    expect(env.call('cards.statement', { id: updated.id }).history[0].reason).toMatch(/cards.xlsx/)
  })

  it('reads CSV with quoted fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamween-'))
    const path = join(dir, 'cards.csv')
    writeFileSync(path, '﻿رقم البطاقة,الاسم,عدد الأفراد\n2001,"علي, محمد",3\n')
    const sheet = await readSheet(path)
    expect(sheet.rows).toEqual([['2001', 'علي, محمد', '3']])
  })
})
