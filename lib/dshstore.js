/**
 * Remote DSH session index.
 *
 * The share folder carries the DSH session logs of every machine. This store
 * walks those folders, decodes the logs and keeps a searchable index, so the
 * conversations that happened on the office laptop can be read from the dorm
 * desktop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseDshLogFile } from './dshlog.js'
import { resolveRange, sameCwd, sessionInRange, timestampInRange } from './store.js'

const LOG_FILE = 'session.v4.jsonl.zstd'
const MAX_DEPTH = 4

/**
 * @param {string} dir
 * @param {number} depth
 * @param {string[]} out
 * @returns {string[]}
 */
function findLogs(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findLogs(full, depth + 1, out)
    else if (entry.isFile() && entry.name === LOG_FILE) out.push(full)
  }
  return out
}

export class DshHistoryStore {
  /**
   * @param {{sources?: Array<{id: string, label: string, sessionsDir: string, machineId?: string}>, pollIntervalMs?: number}} [options]
   */
  constructor(options = {}) {
    this.sources = Array.isArray(options.sources) ? options.sources : []
    this.pollIntervalMs = options.pollIntervalMs ?? 20000
    /** @type {Map<string, {mtimeMs: number, size: number, session: object}>} */
    this.files = new Map()
    /** @type {Set<(sessions: object[]) => void>} */
    this.listeners = new Set()
    this.timer = null
    this.refreshing = null
    this.available = false
    this.lastError = ''
  }

  /** Start watching the shared DSH folders. */
  start() {
    this.stop()
    void this.refresh(true)
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh(false)
      }, this.pollIntervalMs)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  /** Stop watching. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Subscribe to refresh notifications. */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Replace the watched folders.
   *
   * @param {Array<{id: string, label: string, sessionsDir: string, machineId?: string}>} sources
   */
  setSources(sources) {
    this.sources = Array.isArray(sources) ? sources : []
  }

  /**
   * Rescan the shared DSH folders.
   *
   * @param {boolean} [force]
   * @returns {Promise<object[]>}
   */
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.#refresh(force).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async #refresh(force) {
    const seen = new Set()
    let available = false
    let lastError = ''
    let changed = false

    for (const source of this.sources) {
      if (!source?.sessionsDir) continue
      const files = findLogs(source.sessionsDir)
      if (files.length > 0) available = true
      for (const filePath of files) {
        seen.add(filePath)
        let stat
        try {
          stat = fs.statSync(filePath)
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          continue
        }
        const cached = this.files.get(filePath)
        if (!force && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue
        const session = parseDshLogFile(filePath, {
          sourceId: source.id,
          sourceLabel: source.label,
          isLocal: source.isLocal === true,
        })
        if (!session) continue
        this.files.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, session })
        changed = true
      }
    }

    for (const filePath of [...this.files.keys()]) {
      if (!seen.has(filePath)) {
        this.files.delete(filePath)
        changed = true
      }
    }

    this.available = available
    this.lastError = available ? '' : lastError
    if (changed) {
      const sessions = this.listSessions()
      for (const listener of this.listeners) {
        try {
          listener(sessions)
        } catch {
          /* a listener must never break the store */
        }
      }
    }
    return this.listSessions()
  }

  /**
   * Every known DSH session, newest first.
   *
   * @param {{since?: string, until?: string}} [options]
   * @returns {object[]}
   */
  listSessions(options = {}) {
    const range = resolveRange(options)
    const sessions = []
    for (const entry of this.files.values()) {
      if (!sessionInRange(entry.session, range)) continue
      sessions.push(entry.session)
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return sessions
  }

  /**
   * Lightweight session descriptors.
   *
   * @param {{query?: string, cwd?: string, limit?: number, since?: string, until?: string}} [options]
   * @returns {object[]}
   */
  listSummaries(options = {}) {
    const query = (options.query ?? '').trim().toLowerCase()
    const cwd = options.cwd ?? ''
    const limit = options.limit ?? 50
    const result = []
    for (const session of this.listSessions(options)) {
      if (cwd && !sameCwd(session.cwd, cwd)) continue
      if (query) {
        const haystack = `${session.title}\n${session.preview}\n${session.cwd}\n${session.sourceLabel ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) continue
      }
      result.push({
        id: session.id,
        title: session.title || session.preview || '(untitled)',
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        startedAt: session.startedAt,
        messageCount: session.messageCount,
        toolCallCount: session.toolCallCount ?? 0,
        filePath: session.filePath,
        sourceId: session.sourceId ?? '',
        sourceLabel: session.sourceLabel ?? '',
        isLocal: session.isLocal === true,
      })
      if (result.length >= limit) break
    }
    return result
  }

  /**
   * Look one session up by id.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getSession(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    const wanted = id.trim().toLowerCase()
    for (const entry of this.files.values()) {
      if (entry.session.id.toLowerCase() === wanted) return entry.session
    }
    return null
  }

  /**
   * Search every message of every session.
   *
   * @param {string} query
   * @param {{limit?: number, since?: string, until?: string}} [options]
   * @returns {Array<{sessionId: string, title: string, cwd: string, role: string, text: string, timestamp: string, sourceLabel: string}>}
   */
  search(query, options = {}) {
    const needle = (query ?? '').trim().toLowerCase()
    const limit = options.limit ?? 20
    const range = resolveRange(options)
    const hits = []
    if (!needle) return hits
    for (const session of this.listSessions(options)) {
      for (const message of session.messages) {
        if (!message.text.toLowerCase().includes(needle)) continue
        if (!timestampInRange(message.timestamp, range)) continue
        hits.push({
          sessionId: session.id,
          title: session.title || session.preview || '(untitled)',
          cwd: session.cwd,
          role: message.role,
          text: message.text.slice(0, 400),
          timestamp: message.timestamp,
          sourceId: session.sourceId ?? '',
          sourceLabel: session.sourceLabel ?? '',
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }
}
