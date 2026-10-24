/**
 * Local Codex history store.
 *
 * Keeps an in-memory index of every Codex conversation found under
 * `~/.codex/sessions`, refreshes it when files change on disk, and answers
 * list / read / search questions.
 *
 * Since v1.3.0 the store can watch more than one directory at the same time.
 * The local `~/.codex/sessions` tree is always the primary source; extra
 * sources are usually the *shared* tree that a folder sync tool (Syncthing,
 * OneDrive, a network share, …) keeps in sync between several machines, so a
 * conversation started on the office laptop shows up on the dorm desktop.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRolloutFile, parseRolloutFile, parseSessionIndex } from './parse.js'

const MAX_DEPTH = 6

/** @returns {string} the default Codex sessions directory. */
export function defaultSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions')
}

/** @returns {string} the default Codex session index file. */
export function defaultIndexPath() {
  return path.join(os.homedir(), '.codex', 'session_index.jsonl')
}

/**
 * Expand a leading `~` and environment variables in a configured path.
 *
 * @param {string} value
 * @returns {string}
 */
export function expandPath(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  let text = value
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2))
  return path.resolve(text)
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  let text = value.replace(/[\\/]+$/u, '')
  if (text.length === 0) text = value
  return text.toLowerCase()
}

/** Compare two working directories for equality, ignoring case and trailing separators. */
export function sameCwd(a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (!left || !right) return false
  return left === right
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * Parse one boundary of a time window.
 *
 * A bare `YYYY-MM-DD` is read as a whole UTC day: the start of the day for
 * `since`, the end of the day for `until`. Anything else must be a full
 * ISO 8601 timestamp, because the stored Codex timestamps are UTC.
 *
 * @param {string|undefined} value
 * @param {'start'|'end'} kind
 * @returns {number|null} epoch milliseconds, or null when unusable
 */
function toRangeBound(value, kind) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  if (BARE_DATE.test(text)) {
    const time = Date.parse(`${text}T${kind === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`)
    return Number.isNaN(time) ? null : time
  }
  const time = Date.parse(text)
  return Number.isNaN(time) ? null : time
}

/**
 * Resolve a `{ since, until }` pair into epoch milliseconds.
 *
 * @param {{since?: string, until?: string}} [options]
 * @returns {{since: number|null, until: number|null}}
 */
export function resolveRange(options = {}) {
  return {
    since: toRangeBound(options.since, 'start'),
    until: toRangeBound(options.until, 'end'),
  }
}

/**
 * Whether a session overlaps the window.
 *
 * Overlap — not containment — is the right rule for weekly or monthly
 * reports: work done inside the window may live in a session that started
 * days earlier. Sessions without usable timestamps are always kept.
 *
 * @param {object} session
 * @param {{since?: number|null, until?: number|null}} range
 * @returns {boolean}
 */
export function sessionInRange(session, range) {
  if (range.since === null && range.until === null) return true
  const start = Date.parse(session?.startedAt || session?.updatedAt || '')
  const end = Date.parse(session?.updatedAt || session?.startedAt || '')
  if (Number.isNaN(start) || Number.isNaN(end)) return true
  if (range.since !== null && end < range.since) return false
  if (range.until !== null && start > range.until) return false
  return true
}

/**
 * Whether a timestamp falls inside the window.
 *
 * @param {string} timestamp
 * @param {{since?: number|null, until?: number|null}} range
 * @returns {boolean}
 */
export function timestampInRange(timestamp, range) {
  if (!timestamp) return false
  if (range.since === null && range.until === null) return true
  const time = Date.parse(timestamp)
  if (Number.isNaN(time)) return false
  if (range.since !== null && time < range.since) return false
  if (range.until !== null && time > range.until) return false
  return true
}

/**
 * Normalize one source definition.
 *
 * @param {object} source
 * @returns {{id: string, label: string, sessionsDir: string, indexPath: string}}
 */
function normalizeSource(source, fallbackId) {
  const raw = source && typeof source === 'object' ? source : {}
  const sessionsDir = expandPath(raw.sessionsDir ?? '')
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
    sessionsDir,
    indexPath: expandPath(raw.indexPath ?? path.join(path.dirname(sessionsDir), 'session_index.jsonl')),
  }
}

export class CodexHistoryStore {
  /**
   * @param {{sessionsDir?: string, indexPath?: string, pollIntervalMs?: number, sources?: object[]}} [options]
   */
  constructor(options = {}) {
    const local = normalizeSource(
      {
        id: 'local',
        label: options.sourceLabel ?? '本机',
        sessionsDir: options.sessionsDir ?? defaultSessionsDir(),
        indexPath: options.indexPath ?? defaultIndexPath(),
      },
      'local',
    )
    const extra = Array.isArray(options.sources) ? options.sources : []
    this.sources = [local, ...extra.map((source, index) => normalizeSource(source, `source-${index + 1}`))]
    this.localSourceId = local.id
    this.sessionsDir = local.sessionsDir
    this.indexPath = local.indexPath
    this.pollIntervalMs = options.pollIntervalMs ?? 5000
    /** @type {Map<string, {mtimeMs: number, size: number, session: object}>} */
    this.files = new Map()
    /** @type {Map<string, {title: string, updatedAt: string}>} */
    this.titles = new Map()
    /** @type {Set<(sessions: object[]) => void>} */
    this.listeners = new Set()
    this.timer = null
    this.refreshing = null
    this.available = false
    this.lastError = ''
  }

  /** Start watching the sessions directory for changes. */
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

  #notify() {
    const sessions = this.listSessions()
    for (const listener of this.listeners) {
      try {
        listener(sessions)
      } catch {
        /* a listener must never break the store */
      }
    }
  }

  /**
   * Replace the set of watched sources.
   *
   * Used by the shared-source discovery: the share folder gains and loses
   * machine folders over time, and the store has to follow.
   *
   * @param {object[]} sources extra sources, without the local one
   */
  setExtraSources(sources) {
    const local = this.sources.find((source) => source.id === this.localSourceId)
    const extra = Array.isArray(sources) ? sources.map((source, index) => normalizeSource(source, `source-${index + 1}`)) : []
    this.sources = local ? [local, ...extra] : extra
  }

  /**
   * Rescan the sessions directories.
   *
   * @param {boolean} [force] reparse every file even when it is unchanged
   * @returns {Promise<object[]>} the known sessions, newest first
   */
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.#refresh(force).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async #refresh(force) {
    const files = []
    let available = false
    let lastError = ''
    for (const source of this.sources) {
      if (!source.sessionsDir) continue
      try {
        files.push(...this.#collectFiles(source.sessionsDir, 0, source))
        available = true
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    this.available = available
    this.lastError = available ? '' : lastError

    let changed = false
    const seen = new Set()
    for (const entry of files) {
      const filePath = entry.filePath
      const source = entry.source
      seen.add(filePath)
      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      const cached = this.files.get(filePath)
      if (!force && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue
      const session = parseRolloutFile(filePath)
      if (!session) continue
      session.sourceId = source.id
      session.sourceLabel = source.label
      session.isLocal = source.id === this.localSourceId
      this.files.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, session })
      changed = true
    }
    for (const filePath of [...this.files.keys()]) {
      if (!seen.has(filePath)) {
        this.files.delete(filePath)
        changed = true
      }
    }

    const titles = this.#readTitles()
    if (titles.size !== this.titles.size) changed = true
    this.titles = titles
    for (const entry of this.files.values()) {
      const indexed = titles.get(entry.session.id)
      if (indexed && indexed.title) {
        if (entry.session.title !== indexed.title) {
          entry.session.title = indexed.title
          changed = true
        }
      }
    }

    if (changed) this.#notify()
    return this.listSessions()
  }

  /**
   * Read every session index file of every source.
   *
   * A source directory usually holds one `session_index.jsonl`, but a folder
   * sync tool that sees two machines writing the same file leaves conflict
   * copies behind (`session_index.sync-conflict-*.jsonl`). Reading every
   * `session_index*.jsonl` in the directory makes those copies contribute
   * their titles instead of losing them.
   *
   * @returns {Map<string, {title: string, updatedAt: string}>}
   */
  #readTitles() {
    const titles = new Map()
    for (const source of this.sources) {
      if (!source.indexPath) continue
      for (const filePath of this.#indexFiles(source.indexPath)) {
        let raw = ''
        try {
          raw = fs.readFileSync(filePath, 'utf8')
        } catch {
          continue
        }
        for (const [id, entry] of parseSessionIndex(raw)) {
          const current = titles.get(id)
          if (!current) {
            titles.set(id, entry)
            continue
          }
          const currentTime = Date.parse(current.updatedAt || '') || 0
          const nextTime = Date.parse(entry.updatedAt || '') || 0
          if (nextTime > currentTime || (!entry.title && current.title)) titles.set(id, entry)
        }
      }
    }
    return titles
  }

  /**
   * Every index file that belongs to one source.
   *
   * @param {string} indexPath
   * @returns {string[]}
   */
  #indexFiles(indexPath) {
    const files = new Set()
    const dir = path.dirname(indexPath)
    const base = path.basename(indexPath)
    files.add(indexPath)
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return [...files]
    }
    const prefix = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue
      if (entry === base) continue
      files.add(path.join(dir, entry))
    }
    return [...files]
  }

  /**
   * @param {string} dir
   * @param {number} depth
   * @param {object} source
   * @returns {Array<{filePath: string, source: object}>}
   */
  #collectFiles(dir, depth, source) {
    if (depth > MAX_DEPTH) return []
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const files = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...this.#collectFiles(full, depth + 1, source))
      } else if (entry.isFile() && isRolloutFile(full)) {
        files.push({ filePath: full, source })
      }
    }
    return files
  }

  /**
   * Every known session, newest first.
   *
   * A session that exists in more than one source (the local copy and the
   * shared copy of the same conversation) is reported once, using the copy
   * with the newest update.
   *
   * @param {{since?: string, until?: string}} [options] optional time window
   * @returns {object[]}
   */
  listSessions(options = {}) {
    const range = resolveRange(options)
    const byId = new Map()
    for (const entry of this.files.values()) {
      const session = entry.session
      if (!session.title) {
        const indexed = this.titles.get(session.id)
        session.title = indexed?.title ?? session.preview ?? ''
      }
      if (!sessionInRange(session, range)) continue
      const current = byId.get(session.id)
      if (!current) {
        byId.set(session.id, session)
        continue
      }
      const currentTime = Date.parse(current.updatedAt || '') || 0
      const nextTime = Date.parse(session.updatedAt || '') || 0
      if (nextTime > currentTime) byId.set(session.id, session)
    }
    const sessions = [...byId.values()]
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return sessions
  }

  /**
   * Lightweight session descriptors (no transcript) for UI lists.
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
        originator: session.originator,
        model: session.model,
        updatedAt: session.updatedAt,
        startedAt: session.startedAt,
        messageCount: session.messageCount,
        toolCallCount: session.toolCalls?.length ?? 0,
        touchedFiles: session.touchedFiles ?? [],
        filePath: session.filePath,
        sourceId: session.sourceId ?? this.localSourceId,
        sourceLabel: session.sourceLabel ?? '',
        isLocal: (session.sourceId ?? this.localSourceId) === this.localSourceId,
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
    for (const entry of this.files.values()) {
      if (path.basename(entry.session.filePath).toLowerCase().includes(wanted)) return entry.session
    }
    return null
  }

  /**
   * The most recently updated session recorded for a working directory.
   *
   * @param {string} cwd
   * @param {{since?: string, until?: string}} [options]
   * @returns {object|null}
   */
  findLatestForCwd(cwd, options = {}) {
    if (!cwd) return null
    let latest = null
    for (const session of this.listSessions(options)) {
      if (!sameCwd(session.cwd, cwd)) continue
      if (!latest || String(session.updatedAt) > String(latest.updatedAt)) latest = session
    }
    return latest
  }

  /**
   * Search every message of every session.
   *
   * @param {string} query
   * @param {{limit?: number, cwd?: string, since?: string, until?: string}} [options]
   * @returns {Array<{sessionId: string, title: string, cwd: string, role: string, text: string, timestamp: string}>}
   */
  search(query, options = {}) {
    const needle = (query ?? '').trim().toLowerCase()
    const limit = options.limit ?? 20
    const range = resolveRange(options)
    const hits = []
    if (!needle) return hits
    for (const session of this.listSessions(options)) {
      if (options.cwd && !sameCwd(session.cwd, options.cwd)) continue
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
          sourceId: session.sourceId ?? this.localSourceId,
          sourceLabel: session.sourceLabel ?? '',
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }
}
