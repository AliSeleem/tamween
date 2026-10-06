import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { commitImport, guessMapping, previewImport, readSheet, readWorkbook } from '../src/main/services/importer'
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

describe('shop register layout (no card numbers, titles above the header)', () => {
  it('finds the header row, identifies cards by secret number and name, and picks sheets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamween-'))
    const path = join(dir, 'register.xlsx')
    const wb = new ExcelJS.Workbook()
    const old = wb.addWorksheet('Sheet1')
    old.addRow(['مكتب تموين'])
    old.addRow(['الاسم ', 'رقم سرى ', 'ع افراد', 'مخبز'])
    old.addRow(['قديم', 1, 1, 'ب'])
    const ws = wb.addWorksheet('Sheet3')
    ws.addRow(['مكتب تموين بنى حرام'])
    ws.addRow(['التاجرة /فلانة'])
    ws.addRow(['ربط البطاقات التموينية '])
    ws.addRow(['الاسم ', 'رقم سرى ', 'ع افراد', 'مخبز', 1, 2, 3])
    ws.addRow(['فتحى رشدى عبدالناصر', 1111, 1, 'ن'])
    ws.addRow(['محمد محمد خلف ', 1111, 2, 'ن '])   // same secret number, different person
    ws.addRow(['خالد  خميس محجوب', 8518, 3, 'ب'])
    ws.addRow(['خالد خميس محجوب ', 8518, 3, 'ب'])  // same person twice
    ws.addRow([])
    ws.addRow(['بدون رقم', null, 2, 'م'])
    await wb.xlsx.writeFile(path)

    const sheets = await readWorkbook(path)
    expect(sheets.map((s) => [s.sheetName, s.headerRow, s.rows.length])).toEqual([['Sheet1', 2, 1], ['Sheet3', 4, 6]])
    const sheet = sheets[1]
    const m = guessMapping(sheet.headers)
    expect(m).toEqual({ holderName: 0, secretRef: 1, members: 2, bakery: 3 })
    const mapping = { cardNumber: null, ...m } as Parameters<typeof previewImport>[2]

    const env = setup()
    const preview = previewImport(env.ctx, sheet, mapping)
    expect(preview.map((r) => [r.line, r.status])).toEqual([[5, 'new'], [6, 'new'], [7, 'new'], [8, 'error'], [10, 'error']])
    expect(preview[1].bakery).toBe('ن')
    expect(preview[2].holderName).toBe('خالد خميس محجوب')
    expect(commitImport(env.ctx, sheet, mapping, false)).toMatchObject({ created: 3 })

    // Re-importing finds the same cards (spelling variants folded) instead of duplicating them.
    const again = previewImport(env.ctx, sheet, mapping)
    expect(again.filter((r) => r.status !== 'error').map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(env.call('cards.search', { query: '1111' }).total).toBe(2)
  })
})

describe('search', () => {
  it('finds names whatever the spelling of ى/ي and أ/ا', () => {
    const env = setup()
    env.call('cards.create', { cardNumber: null, holderName: 'فتحى رشدى أحمد', secretRef: '1111', bakery: null, members: 1, status: 'active', groupName: null })
    expect(env.call('cards.search', { query: 'فتحي رشدي احمد' }).total).toBe(1)
    expect(env.call('cards.search', { query: '1111' }).total).toBe(1)
  })
})
