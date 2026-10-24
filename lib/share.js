/**
 * Cross-machine sharing.
 *
 * The dorm desktop and the office laptop each run their own Codex and DSH.
 * This module copies the local conversation logs into a *share folder* that a
 * folder sync tool (Syncthing, OneDrive, a network share, …) keeps identical
 * on both machines, and it discovers the folders the other machines wrote so
 * the plugin can show their conversations too.
 *
 * Layout of the share folder:
 *
 *   <root>/
 *     machines/<machineId>.json          machine descriptor (label, host, platform)
 *     codex/<machineId>/sessions/…       Codex rollout files of one machine
 *     codex/<machineId>/session_index.jsonl
 *     dsh/<machineId>/sessions/…         DSH session logs of one machine
 *
 * Every machine only ever writes inside its own `<machineId>` subtree, so a
 * sync tool never has to merge two writers: the folders simply meet.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MANIFEST_FILE = '.mirror-manifest.json'

/** @returns {string} the default share folder. */
export function defaultShareDir() {
  return path.join(os.homedir(), 'CodexShare')
}

/**
 * The folder that holds the DSH session logs of this machine.
 *
 * @returns {string}
 */
export function defaultDshSessionsDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * Turn an arbitrary name into something safe to use as a folder name.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeMachineId(value) {
  const text = String(value ?? '').trim()
  const cleaned = text.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return cleaned || 'machine'
}

/**
 * The id of this machine: the host name, sanitized.
 *
 * @param {string} [hostname]
 * @returns {string}
 */
export function defaultMachineId(hostname = os.hostname()) {
  return sanitizeMachineId(hostname)
}

/**
 * The paths of a share folder.
 *
 * @param {string} root
 * @returns {{root: string, machinesDir: string, codexDir: string, dshDir: string}}
 */
export function shareLayout(root) {
  const base = path.resolve(root)
  return {
    root: base,
    machinesDir: path.join(base, 'machines'),
    codexDir: path.join(base, 'codex'),
    dshDir: path.join(base, 'dsh'),
  }
}

/**
 * The Codex subtree of one machine.
 *
 * @param {string} root
 * @param {string} machineId
 * @returns {string}
 */
export function machineCodexDir(root, machineId) {
  return path.join(shareLayout(root).codexDir, sanitizeMachineId(machineId))
}

/**
 * The DSH subtree of one machine.
 *
 * @param {string} root
 * @param {string} machineId
 * @returns {string}
 */
export function machineDshDir(root, machineId) {
  return path.join(shareLayout(root).dshDir, sanitizeMachineId(machineId))
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read every machine descriptor of the share folder.
 *
 * @param {string} root
 * @returns {Map<string, {machineId: string, label: string, hostname?: string, platform?: string}>}
 */
export function readMachineDescriptors(root) {
  const descriptors = new Map()
  const dir = shareLayout(root).machinesDir
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return descriptors
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const data = readJsonFile(path.join(dir, entry))
    if (!data || typeof data.machineId !== 'string') continue
    descriptors.set(data.machineId, {
      machineId: data.machineId,
      label: typeof data.label === 'string' && data.label.trim() ? data.label.trim() : data.machineId,
      hostname: typeof data.hostname === 'string' ? data.hostname : '',
      platform: typeof data.platform === 'string' ? data.platform : '',
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    })
  }
  return descriptors
}

/**
 * Write the descriptor of this machine.
 *
 * @param {string} root
 * @param {{machineId: string, label: string, hostname?: string, platform?: string}} info
 * @returns {boolean} whether the descriptor was written
 */
export function writeMachineDescriptor(root, info) {
  const layout = shareLayout(root)
  const machineId = sanitizeMachineId(info?.machineId)
  try {
    fs.mkdirSync(layout.machinesDir, { recursive: true })
    const payload = {
      machineId,
      label: typeof info?.label === 'string' && info.label.trim() ? info.label.trim() : machineId,
      hostname: info?.hostname ?? os.hostname(),
      platform: info?.platform ?? process.platform,
      updatedAt: new Date().toISOString(),
    }
    const target = path.join(layout.machinesDir, `${machineId}.json`)
    const temp = `${target}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, target)
    return true
  } catch {
    return false
  }
}

/**
 * The Codex sources found in the share folder.
 *
 * Every machine folder under `<root>/codex` becomes one read-only source.
 * The folder of this machine is skipped: the same conversations are already
 * read from the local Codex directory.
 *
 * @param {string} root
 * @param {{exclude?: string, descriptors?: Map<string, object>}} [options]
 * @returns {Array<{id: string, label: string, sessionsDir: string, indexPath: string, machineId: string}>}
 */
export function discoverCodexSources(root, options = {}) {
  const layout = shareLayout(root)
  const descriptors = options.descriptors ?? readMachineDescriptors(root)
  const sources = []
  let entries = []
  try {
    entries = fs.readdirSync(layout.codexDir, { withFileTypes: true })
  } catch {
    return sources
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const machineId = entry.name
    if (options.exclude && machineId === options.exclude) continue
    const sessionsDir = path.join(layout.codexDir, machineId, 'sessions')
    try {
      if (!fs.statSync(sessionsDir).isDirectory()) continue
    } catch {
      continue
    }
    const descriptor = descriptors.get(machineId)
    sources.push({
      id: `share:${machineId}`,
      machineId,
      label: descriptor?.label ?? machineId,
      sessionsDir,
      indexPath: path.join(layout.codexDir, machineId, 'session_index.jsonl'),
    })
  }
  return sources
}

/**
 * The DSH sources found in the share folder.
 *
 * @param {string} root
 * @param {{exclude?: string, descriptors?: Map<string, object>}} [options]
 * @returns {Array<{id: string, label: string, sessionsDir: string, machineId: string}>}
 */
export function discoverDshSources(root, options = {}) {
  const layout = shareLayout(root)
  const descriptors = options.descriptors ?? readMachineDescriptors(root)
  const sources = []
  let entries = []
  try {
    entries = fs.readdirSync(layout.dshDir, { withFileTypes: true })
  } catch {
    return sources
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const machineId = entry.name
    if (options.exclude && machineId === options.exclude) continue
    const sessionsDir = path.join(layout.dshDir, machineId, 'sessions')
    try {
      if (!fs.statSync(sessionsDir).isDirectory()) continue
    } catch {
      continue
    }
    const descriptor = descriptors.get(machineId)
    sources.push({
      id: `share:${machineId}`,
      machineId,
      label: descriptor?.label ?? machineId,
      sessionsDir,
    })
  }
  return sources
}

/**
 * List the files of a directory tree.
 *
 * @param {string} dir
 * @param {number} [depth]
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkFiles(dir, depth = 0, out = []) {
  if (depth > 6) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, depth + 1, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Copy one file, replacing the destination atomically.
 *
 * @param {string} source
 * @param {string} target
 * @returns {boolean}
 */
function copyFileAtomic(source, target) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.part`
    fs.copyFileSync(source, temp)
    fs.renameSync(temp, target)
    return true
  } catch {
    return false
  }
}

/**
 * Mirror one directory tree into the share folder.
 *
 * Only files whose size or modification time changed are copied, so the
 * mirror is cheap enough to run every few seconds.
 *
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {Map<string, {size: number, mtimeMs: number}>} manifest
 * @returns {{copied: number, removed: number}}
 */
function mirrorTree(sourceDir, targetDir, manifest, prefix = '') {
  let copied = 0
  let removed = 0
  const files = walkFiles(sourceDir)
  const seen = new Set()
  for (const file of files) {
    const relative = path.relative(sourceDir, file)
    const key = `${prefix}${relative}`
    const target = path.join(targetDir, relative)
    seen.add(key)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    const known = manifest.get(key)
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue
    if (copyFileAtomic(file, target)) {
      manifest.set(key, { size: stat.size, mtimeMs: stat.mtimeMs })
      copied += 1
    }
  }
  // Files that disappeared locally are dropped from the share as well.
  for (const key of [...manifest.keys()]) {
    if (seen.has(key)) continue
    if (!key.startsWith(prefix)) continue
    const target = path.join(targetDir, key.slice(prefix.length))
    try {
      fs.rmSync(target, { force: true })
    } catch {
      /* the sync tool may still be holding the file */
    }
    manifest.delete(key)
    removed += 1
  }
  return { copied, removed }
}

/**
 * Mirror one single file into the share folder.
 *
 * @param {string} source
 * @param {string} target
 * @param {Map<string, {size: number, mtimeMs: number}>} manifest
 * @param {string} key
 * @returns {boolean} whether the file was copied
 */
function mirrorFile(source, target, manifest, key) {
  let stat
  try {
    stat = fs.statSync(source)
  } catch {
    return false
  }
  const known = manifest.get(key)
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return false
  if (!copyFileAtomic(source, target)) return false
  manifest.set(key, { size: stat.size, mtimeMs: stat.mtimeMs })
  return true
}

/**
 * Keep the share folder up to date with the local conversation logs.
 *
 * The mirror only ever writes inside the folder of this machine, so the other
 * machines never see a file that is being written.
 */
export class ShareMirror {
  /**
   * @param {{root: string, machineId: string, label: string, codexSessionsDir?: string, codexIndexPath?: string, dshSessionsDir?: string, intervalMs?: number}} options
   */
  constructor(options) {
    this.root = path.resolve(options.root)
    this.machineId = sanitizeMachineId(options.machineId)
    this.label = options.label ?? this.machineId
    this.codexSessionsDir = options.codexSessionsDir ?? ''
    this.codexIndexPath = options.codexIndexPath ?? ''
    this.dshSessionsDir = options.dshSessionsDir ?? ''
    this.intervalMs = options.intervalMs ?? 30000
    this.timer = null
    this.running = false
    /** @type {Map<string, {size: number, mtimeMs: number}>} */
    this.manifest = new Map()
    this.lastError = ''
    this.lastRunAt = ''
  }

  /** Start the periodic mirror. */
  start() {
    this.stop()
    void this.run()
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.run()
      }, this.intervalMs)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  /** Stop the periodic mirror. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  #loadManifest() {
    const file = path.join(machineCodexDir(this.root, this.machineId), MANIFEST_FILE)
    const data = readJsonFile(file)
    this.manifest = new Map()
    if (!data || typeof data.files !== 'object' || !data.files) return
    for (const [key, value] of Object.entries(data.files)) {
      if (!value || typeof value !== 'object') continue
      this.manifest.set(key, { size: Number(value.size) || 0, mtimeMs: Number(value.mtimeMs) || 0 })
    }
  }

  #saveManifest() {
    const file = path.join(machineCodexDir(this.root, this.machineId), MANIFEST_FILE)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = { version: 1, files: Object.fromEntries(this.manifest) }
      const temp = `${file}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, file)
    } catch {
      /* the manifest is an optimization, not a requirement */
    }
  }

  /**
   * Run one mirror pass.
   *
   * @returns {{copied: number, removed: number}}
   */
  async run() {
    if (this.running) return { copied: 0, removed: 0 }
    this.running = true
    try {
      writeMachineDescriptor(this.root, { machineId: this.machineId, label: this.label })
      this.#loadManifest()

      let copied = 0
      let removed = 0
      const codexTarget = machineCodexDir(this.root, this.machineId)
      if (this.codexSessionsDir) {
        const result = mirrorTree(this.codexSessionsDir, path.join(codexTarget, 'sessions'), this.manifest, 'codex:')
        copied += result.copied
        removed += result.removed
      }
      if (this.codexIndexPath) {
        if (mirrorFile(this.codexIndexPath, path.join(codexTarget, 'session_index.jsonl'), this.manifest, 'index:__index__')) copied += 1
      }
      if (this.dshSessionsDir) {
        const result = mirrorTree(this.dshSessionsDir, path.join(machineDshDir(this.root, this.machineId), 'sessions'), this.manifest, 'dsh:')
        copied += result.copied
        removed += result.removed
      }
      this.#saveManifest()
      this.lastError = ''
      this.lastRunAt = new Date().toISOString()
      return { copied, removed }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return { copied: 0, removed: 0 }
    } finally {
      this.running = false
    }
  }
}
