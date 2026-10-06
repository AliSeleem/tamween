import type { ApiArgs, ApiMethod, ApiResult } from '@shared/api'
import * as auth from './services/auth'
import * as cards from './services/cards'
import type { Ctx } from './services/context'
import { audit, requireAdmin, requireUser } from './services/context'
import * as distribution from './services/distribution'
import * as importer from './services/importer'
import * as inventory from './services/inventory'
import * as periods from './services/periods'
import * as pos from './services/pos'
import * as products from './services/products'
import * as settings from './services/settings'
import * as tracking from './services/tracking'

/** Things only the Electron shell can do (native dialogs); injected so the API can run in tests. */
export interface Platform {
  pickImportFile(): Promise<string | null>
  pickBackupPath(): Promise<string | null>
}

type Handlers = { [K in ApiMethod]: (args: ApiArgs<K>) => ApiResult<K> | Promise<ApiResult<K>> }

/** Methods callable before login. Everything else requires a signed-in user. */
export const PUBLIC_METHODS: ApiMethod[] = ['auth.login', 'auth.me']

export function createHandlers(ctx: Ctx, platform: Platform): Handlers {
  return {
    'auth.login': (a) => auth.login(ctx, a.username, a.password),
    'auth.logout': () => {
      if (ctx.user) audit(ctx, 'logout', 'user', ctx.user.id)
      ctx.user = null
    },
    'auth.me': () => (ctx.user ? auth.getUser(ctx, ctx.user.id) : null),
    'auth.changePassword': (a) => auth.changePassword(ctx, a.oldPassword, a.newPassword),
    'users.list': () => auth.listUsers(ctx),
    'users.save': (a) => auth.saveUser(ctx, a),

    'settings.get': () => settings.getSettings(ctx),
    'settings.save': (a) => settings.saveSettings(ctx, a),

    'products.list': () => products.listProducts(ctx),
    'products.save': (a) => products.saveProduct(ctx, a),

    'periods.list': () => periods.listPeriods(ctx),
    'periods.open': (a) => periods.openPeriod(ctx, a.month),
    'periods.close': (a) => periods.closePeriod(ctx, a.month),
    'periods.config': (a) => periods.getConfig(ctx, a.month),
    'periods.saveConfig': (a) => periods.savePeriodConfig(ctx, a),

    'cards.search': (a) => cards.searchCards(ctx, a),
    'cards.get': (a) => cards.getCard(ctx, a.id),
    'cards.findByNumber': (a) => cards.findCardByNumber(ctx, a.cardNumber),
    'cards.create': (a) => cards.createCard(ctx, a),
    'cards.update': (a) => cards.updateCard(ctx, a.id, a.card, a.reason),
    'cards.statement': (a) => cards.cardStatement(ctx, a.id),
    'cards.includeInMonth': (a) => cards.includeCard(ctx, a.cardId, a.month),
    'cards.monthContext': (a) => tracking.cardMonthContext(ctx, a.cardId, a.month),

    'pos.batches': (a) => pos.listBatches(ctx, a.month),
    'pos.createBatch': (a) => pos.createBatch(ctx, a),
    'pos.setBatchStatus': (a) => pos.setBatchStatus(ctx, a.id, a.status),
    'pos.batchSummary': (a) => pos.batchSummary(ctx, a.id),
    'pos.record': (a) => pos.recordPosTransaction(ctx, a),
    'pos.void': (a) => pos.voidPosTransaction(ctx, a.id, a.reason),

    'distribution.record': (a) => distribution.recordDistribution(ctx, a),
    'distribution.void': (a) => distribution.voidDistribution(ctx, a.id, a.reason),
    'distribution.list': (a) => distribution.listDistributions(ctx, a),

    'tracking.list': (a) => tracking.tracking(ctx, a),
    'dashboard.get': (a) => tracking.dashboard(ctx, a.month),

    'inventory.balances': (a) => inventory.inventoryBalances(ctx, a.asOf),
    'inventory.movements': (a) => inventory.listMovements(ctx, a),
    'inventory.record': (a) => inventory.recordMovement(ctx, a),
    'inventory.stocktake': (a) => inventory.recordStocktake(ctx, a),
    'inventory.reverse': (a) => inventory.reverseMovement(ctx, a.id, a.reason),

    'audit.list': (a) => {
      requireAdmin(ctx)
      return tracking.listAudit(ctx, a)
    },

    'import.pickFile': async () => {
      requireAdmin(ctx)
      const path = await platform.pickImportFile()
      if (!path) return null
      const sheet = await importer.readSheet(path)
      return { sheet, mapping: importer.guessMapping(sheet.headers) }
    },
    'import.preview': (a) => {
      requireUser(ctx)
      return importer.previewImport(ctx, a.sheet, a.mapping)
    },
    'import.commit': (a) => importer.commitImport(ctx, a.sheet, a.mapping, a.updateExisting),

    'backup.create': async () => {
      requireAdmin(ctx)
      const path = await platform.pickBackupPath()
      if (!path) return null
      ctx.db.run('VACUUM INTO ?', [path])
      audit(ctx, 'backup', 'database', null, { path })
      return { path }
    }
  }
}
