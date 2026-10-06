const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonth(m: string): boolean {
  return MONTH_RE.test(m)
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']

export function monthLabel(month: string): string {
  if (!isMonth(month)) return month
  const [y, m] = month.split('-').map(Number)
  return `${AR_MONTHS[m - 1]} ${y}`
}

/** 9850 -> "98.50" */
export function formatMoney(piasters: number | null | undefined): string {
  if (piasters == null) return '—'
  const sign = piasters < 0 ? '-' : ''
  const abs = Math.abs(piasters)
  const pounds = Math.floor(abs / 100).toLocaleString('en-US')
  return `${sign}${pounds}.${String(abs % 100).padStart(2, '0')}`
}

/** "98.50" -> 9850; returns null for invalid input. Accepts Arabic-Indic digits. */
export function parseMoney(text: string): number | null {
  const t = normalizeDigits(text).replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  const neg = t.startsWith('-')
  const [p, f = ''] = t.replace('-', '').split('.')
  const v = Number(p) * 100 + Number(f.padEnd(2, '0'))
  return neg ? -v : v
}

export function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
}

/** Keeps a code such as a batch number in left-to-right order inside Arabic text. */
export function ltr(text: string): string {
  return `\u2066${text}\u2069`
}

export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
