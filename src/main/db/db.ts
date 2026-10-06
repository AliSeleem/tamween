import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { migrations } from './schema'

export type Params = Record<string, SQLInputValue> | SQLInputValue[]

/** Thin synchronous wrapper over node:sqlite with nested transactions via savepoints. */
export class Db {
  readonly raw: DatabaseSync
  private depth = 0

  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL')
      this.raw.exec('PRAGMA busy_timeout = 5000')
    }
    this.migrate()
  }

  private migrate(): void {
    const current = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    for (let i = current; i < migrations.length; i++) {
      this.tx(() => {
        this.raw.exec(migrations[i])
        this.raw.exec(`PRAGMA user_version = ${i + 1}`)
      })
    }
  }

  all<T>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql)
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[]
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const stmt = this.raw.prepare(sql)
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined
  }

  run(sql: string, params: Params = []): { changes: number; lastId: number } {
    const stmt = this.raw.prepare(sql)
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }
  }

  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const result = fn()
      this.depth--
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
      return result
    } catch (e) {
      this.depth--
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw e
    }
  }

  close(): void {
    this.raw.close()
  }
}
