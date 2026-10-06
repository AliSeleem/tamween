export type Role = 'admin' | 'clerk'
export type CardStatus = 'active' | 'suspended' | 'cancelled'
export type PosStatus = 'none' | 'struck' | 'partial'
export type ReceiptStatus = 'none' | 'full' | 'partial'
export type InventoryTxType = 'opening' | 'receipt' | 'distribution' | 'return' | 'damage' | 'stocktake'
export type LimitKey = 'sugar' | 'oil'

export interface User {
  id: number
  username: string
  displayName: string
  role: Role
  active: boolean
  mustChangePassword: boolean
}

export interface AppSettings {
  shopName: string
  defaultMoneyLimitPiasters: number
  defaultSugarLimit: number
  defaultOilLimit: number
  /** warn when a batch reaches this percentage of a limit */
  alertThresholdPercent: number
}

export interface Product {
  id: number
  name: string
  unit: string
  limitKey: LimitKey | null
  carryoverAllowed: boolean
  active: boolean
  sortOrder: number
}

export interface Period {
  month: string
  status: 'open' | 'closed'
  openedAt: string
  closedAt: string | null
  cardCount: number
}

export interface PeriodConfig {
  month: string
  /** entitlement quantity by product id then members count */
  rules: { productId: number; members: number; quantity: number }[]
  cardValues: { members: number; valuePiasters: number }[]
  prices: { productId: number; pricePiasters: number }[]
}

export interface Card {
  id: number
  cardNumber: string
  holderName: string
  secretRef: string | null
  bakery: string | null
  members: number
  status: CardStatus
  groupName: string | null
  createdAt: string
  updatedAt: string
}

export type CardInput = Omit<Card, 'id' | 'createdAt' | 'updatedAt'>

export interface CardHistoryEntry {
  id: number
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  userName: string | null
  changedAt: string
}

/** One row of the citizen rights ledger summary for a card, month and product. */
export interface RightsRow {
  month: string
  productId: number
  productName: string
  unit: string
  entitled: number
  posRight: number
  carriedIn: number
  delivered: number
  carriedOut: number
  expired: number
  remaining: number
  posQuantity: number
}

export interface LedgerEntry {
  id: number
  month: string
  productName: string
  entryType: string
  quantity: number
  note: string | null
  userName: string | null
  createdAt: string
}

export interface PosTransactionItem {
  productId: number
  productName?: string
  quantity: number
  unitPricePiasters: number
  lineTotalPiasters?: number
}

export interface PosTransaction {
  id: number
  batchId: number
  batchNumber: string
  cardId: number
  cardNumber: string
  holderName: string
  month: string
  executedAt: string
  totalPiasters: number
  entitledValuePiasters: number | null
  differencePiasters: number
  status: 'active' | 'voided'
  voidReason: string | null
  notes: string | null
  items: PosTransactionItem[]
  createdBy: string | null
}

export interface DistributionItem {
  productId: number
  productName?: string
  quantity: number
  appliesToMonth: string
}

export interface Distribution {
  id: number
  cardId: number
  cardNumber: string
  holderName: string
  month: string
  distributedAt: string
  status: 'active' | 'voided'
  voidReason: string | null
  notes: string | null
  items: DistributionItem[]
  createdBy: string | null
}

export interface CardStatement {
  card: Card
  snapshots: { month: string; members: number; valuePiasters: number | null }[]
  rights: RightsRow[]
  ledger: LedgerEntry[]
  posTransactions: PosTransaction[]
  distributions: Distribution[]
  history: CardHistoryEntry[]
}

/** Everything the POS and receipt screens need about one card in one month. */
export interface CardMonthContext {
  card: Card
  month: string
  periodOpen: boolean
  snapshotMembers: number | null
  entitledValuePiasters: number | null
  rights: RightsRow[]
  nextMonthRights: RightsRow[]
  posStatus: PosStatus
  receiptStatus: ReceiptStatus
  posTransactions: PosTransaction[]
  distributions: Distribution[]
  prices: { productId: number; pricePiasters: number }[]
}

export interface PosBatch {
  id: number
  batchNumber: string
  month: string
  institution: string | null
  moneyLimitPiasters: number
  sugarLimit: number
  oilLimit: number
  status: 'open' | 'closed'
  notes: string | null
  createdAt: string
}

export interface BatchSummary {
  batch: PosBatch
  transactionCount: number
  moneyUsedPiasters: number
  sugarUsed: number
  oilUsed: number
  overagePiasters: number
  shortfallPiasters: number
  transactions: PosTransaction[]
}

export type TrackingFilter =
  | 'all'
  | 'struck_not_received'
  | 'received_not_struck'
  | 'struck_and_received'
  | 'neither'
  | 'partial_receipt'
  | 'has_balance'

export interface TrackingRow {
  cardId: number
  cardNumber: string
  holderName: string
  members: number
  posStatus: PosStatus
  receiptStatus: ReceiptStatus
  remainingUnits: number
  owedUnits: number
  needsLink: boolean
}

export interface TrackingResult {
  rows: TrackingRow[]
  total: number
  counts: Record<TrackingFilter, number>
}

export interface InventoryBalance {
  productId: number
  productName: string
  unit: string
  opening: number
  receipts: number
  returns: number
  distributed: number
  damaged: number
  stocktake: number
  balance: number
}

export interface InventoryMovement {
  id: number
  productId: number
  productName: string
  txType: InventoryTxType
  quantity: number
  txDate: string
  documentRef: string | null
  note: string | null
  reversed: boolean
  isReversal: boolean
  userName: string | null
  createdAt: string
}

export interface Alert {
  level: 'warning' | 'danger' | 'info'
  message: string
  link?: string
}

export interface DashboardSummary {
  month: string | null
  cardCount: number
  activeCardCount: number
  membersTotal: number
  struckCount: number
  receivedCount: number
  fullCycleCount: number
  posTotalPiasters: number
  overagePiasters: number
  core: { productId: number; productName: string; unit: string; entitled: number; delivered: number; struck: number; stock: number }[]
  alerts: Alert[]
}

export interface AuditEntry {
  id: number
  at: string
  userName: string | null
  action: string
  entity: string
  entityId: string | null
  details: string | null
}

export interface ImportSheet {
  fileName: string
  headers: string[]
  rows: string[][]
}

export interface ImportMapping {
  cardNumber: number
  holderName: number
  secretRef: number | null
  bakery: number | null
  members: number
}

export interface ImportPreviewRow {
  line: number
  cardNumber: string
  holderName: string
  secretRef: string | null
  bakery: string | null
  members: number | null
  status: 'new' | 'update' | 'unchanged' | 'error'
  errors: string[]
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}
