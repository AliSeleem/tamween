import type {
  AppSettings, AuditEntry, BatchSummary, Card, CardInput, CardMonthContext, CardStatement, CardStatus, DashboardSummary,
  Distribution, DistributionItem, ImportMapping, ImportPreviewRow, ImportResult, ImportSheet, InventoryBalance,
  InventoryMovement, InventoryTxType, Period, PeriodConfig, PosBatch, PosTransaction, PosTransactionItem, Product, Role,
  TrackingFilter, TrackingResult, User
} from './types'

/** The IPC contract: method name -> [argument, result]. Main implements it, the renderer calls it. */
export interface ApiSpec {
  'auth.login': [{ username: string; password: string }, User]
  'auth.logout': [void, void]
  'auth.me': [void, User | null]
  'auth.changePassword': [{ oldPassword: string; newPassword: string }, void]
  'users.list': [void, User[]]
  'users.save': [{ id?: number; username: string; displayName: string; role: Role; active: boolean; password?: string }, User]

  'settings.get': [void, AppSettings]
  'settings.save': [Partial<AppSettings>, AppSettings]

  'products.list': [void, Product[]]
  'products.save': [Omit<Product, 'id'> & { id?: number }, Product]

  'periods.list': [void, Period[]]
  'periods.open': [{ month: string }, Period]
  'periods.close': [{ month: string }, Period]
  'periods.config': [{ month: string }, PeriodConfig]
  'periods.saveConfig': [PeriodConfig, PeriodConfig]

  'cards.search': [{ query?: string; status?: CardStatus | 'all'; limit?: number; offset?: number }, { rows: Card[]; total: number }]
  'cards.get': [{ id: number }, Card]
  'cards.findByNumber': [{ cardNumber: string }, Card | null]
  'cards.create': [CardInput, Card]
  'cards.update': [{ id: number; card: CardInput; reason?: string }, Card]
  'cards.statement': [{ id: number }, CardStatement]
  'cards.includeInMonth': [{ cardId: number; month: string }, void]
  'cards.monthContext': [{ cardId: number; month: string }, CardMonthContext]

  'pos.batches': [{ month?: string }, PosBatch[]]
  'pos.createBatch': [
    { month: string; batchNumber?: string; institution?: string; moneyLimitPiasters?: number; sugarLimit?: number; oilLimit?: number; notes?: string },
    PosBatch
  ]
  'pos.setBatchStatus': [{ id: number; status: 'open' | 'closed' }, PosBatch]
  'pos.batchSummary': [{ id: number }, BatchSummary]
  'pos.record': [
    { batchId: number; cardId: number; executedAt: string; items: PosTransactionItem[]; notes?: string; allowAdditional?: boolean },
    PosTransaction
  ]
  'pos.void': [{ id: number; reason: string }, void]

  'distribution.record': [{ cardId: number; month: string; distributedAt?: string; items: DistributionItem[]; notes?: string }, Distribution]
  'distribution.void': [{ id: number; reason: string }, void]
  'distribution.list': [{ cardId?: number; month?: string }, Distribution[]]

  'tracking.list': [{ month: string; filter: TrackingFilter; query?: string; limit?: number; offset?: number }, TrackingResult]
  'dashboard.get': [{ month?: string | null }, DashboardSummary]

  'inventory.balances': [{ asOf?: string }, InventoryBalance[]]
  'inventory.movements': [{ productId?: number; type?: InventoryTxType; from?: string; to?: string; limit?: number }, InventoryMovement[]]
  'inventory.record': [{ productId: number; type: InventoryTxType; quantity: number; date?: string; documentRef?: string; note?: string }, number]
  'inventory.stocktake': [{ productId: number; counted: number; date?: string; note?: string }, { difference: number }]
  'inventory.reverse': [{ id: number; reason: string }, void]

  'audit.list': [{ entity?: string; limit?: number; offset?: number }, AuditEntry[]]

  'import.pickFile': [void, { sheet: ImportSheet; mapping: Partial<ImportMapping> } | null]
  'import.preview': [{ sheet: ImportSheet; mapping: ImportMapping }, ImportPreviewRow[]]
  'import.commit': [{ sheet: ImportSheet; mapping: ImportMapping; updateExisting: boolean }, ImportResult]

  'backup.create': [void, { path: string } | null]
}

export type ApiMethod = keyof ApiSpec
export type ApiArgs<K extends ApiMethod> = ApiSpec[K][0]
export type ApiResult<K extends ApiMethod> = ApiSpec[K][1]

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string }
