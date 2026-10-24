/**
 * DSH session log decoding.
 *
 * A DSH session is stored as `session.v4.jsonl.zstd`: a *container* of
 * concatenated zstd frames, each frame holding a slice of the JSONL stream.
 * Node's `zlib.zstdDecompressSync` only decodes the first frame of such a
 * container, so the frames have to be located by hand before they can be
 * inflated one by one.
 *
 * The result is a transcript with the same shape as a parsed Codex session,
 * so the rendering helpers can be reused for both.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const OUTPUT_PREVIEW_CHARS = 240
const SUMMARY_CHARS = 160

/**
 * Locate every zstd frame inside a container buffer.
 *
 * @param {Buffer} buffer
 * @returns {Array<{start: number, end: number}>}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  if (!Buffer.isBuffer(buffer)) return frames
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      offset += 1
      continue
    }
    const descriptor = buffer[offset + 4]
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictFlag = descriptor & 3
    const dictBytes = dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8

    let cursor = offset + 5
    if (!singleSegment) cursor += 1 // window descriptor
    cursor += dictBytes
    cursor += contentSizeBytes

    let end = cursor
    let complete = false
    while (cursor + 3 <= buffer.length) {
      const header = buffer.readUIntLE(cursor, 3)
      const last = (header & 1) === 1
      const type = (header >>> 1) & 3
      const size = header >>> 3
      cursor += 3
      if (type === 1) cursor += 1 // RLE block: one byte of payload
      else cursor += size // raw and compressed blocks carry `size` bytes
      if (last) {
        end = cursor
        complete = true
        break
      }
    }
    if (!complete) break
    if (checksum) end += 4
    if (end <= offset) break
    frames.push({ start: offset, end })
    offset = end
  }
  return frames
}

/**
 * Inflate every frame of a zstd container and concatenate the text.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeZstdContainer(buffer) {
  const parts = []
  for (const frame of scanZstdFrames(buffer)) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      // A half written tail frame is expected while a session is live.
    }
  }
  return parts.join('')
}

/**
 * The plain text of a message content block list.
 *
 * @param {unknown} content
 * @param {{includeReasoning?: boolean}} [options]
 * @returns {string}
 */
function contentText(content, options = {}) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text)
    } else if (block.type === 'reasoning' && options.includeReasoning) {
      if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * A short one-line description of a tool call.
 *
 * @param {string} name
 * @param {string} argumentsText
 * @returns {string}
 */
function summarizeCall(name, argumentsText) {
  let summary = argumentsText.replace(/\s+/gu, ' ').trim()
  try {
    const parsed = JSON.parse(argumentsText)
    const pick = (obj, keys) => {
      for (const key of keys) {
        const value = obj?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      return ''
    }
    const cmd = pick(parsed, ['cmd', 'command', 'script'])
    const file = pick(parsed, ['path', 'file_path', 'file', 'target_file'])
    const query = pick(parsed, ['query', 'url', 'prompt'])
    const detail = cmd || file || query
    if (detail) summary = detail
  } catch {
    /* the arguments are not JSON — the raw text stays */
  }
  if (summary.length > SUMMARY_CHARS) summary = `${summary.slice(0, SUMMARY_CHARS)}…`
  return summary
}

/**
 * Parse the JSONL text of a DSH session log.
 *
 * @param {string} raw
 * @param {{filePath?: string, sourceId?: string, sourceLabel?: string, isLocal?: boolean, maxMessages?: number}} [options]
 * @returns {object|null}
 */
export function parseDshLog(raw, options = {}) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const maxMessages = options.maxMessages ?? 5000
  const messages = []
  const toolCalls = []
  const callsById = new Map()
  const todos = []
  let id = ''
  let cwd = ''
  let createdAt = ''
  let title = ''
  let updatedAt = ''
  let turn = 0
  let step = 0

  const push = (role, text, timestamp, kind) => {
    if (!text) return
    if (messages.length >= maxMessages) return
    messages.push({ role, text, timestamp, kind: kind ?? role })
  }

  for (const line of raw.split('\n')) {
    if (!line || !line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    const type = typeof record.type === 'string' ? record.type : ''
    const data = record.data && typeof record.data === 'object' ? record.data : {}
    const time = Number.isFinite(record.time) ? new Date(record.time).toISOString() : ''

    if (type === 'session') {
      if (typeof record.id === 'string') id = record.id
      if (typeof record.cwd === 'string') cwd = record.cwd
      if (Number.isFinite(record.createdAt)) createdAt = new Date(record.createdAt).toISOString()
      continue
    }

    if (time) updatedAt = time

    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim()
      continue
    }

    if (type === 'turn/start') {
      turn = Number.isFinite(data.turn) ? data.turn : turn
      continue
    }

    if (type === 'step/start') {
      if (Number.isFinite(data.turn)) turn = data.turn
      if (Number.isFinite(data.step)) step = data.step
      continue
    }

    if (type === 'todo/write') {
      if (Array.isArray(data.todos)) todos.push(...data.todos)
      continue
    }

    if (type === 'user/message') {
      const text = contentText(data.content)
      if (text) push('user', text, time, 'message')
      continue
    }

    if (type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const text = contentText(message.content, options)
      if (text) push('assistant', text, time, 'assistant')
      continue
    }

    if (type === 'system/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const text = contentText(message.content)
      if (text) push('system', text, time, 'system')
      continue
    }

    if (type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name ? data.name : 'unknown'
      const argumentsText = typeof data.arguments === 'string' ? data.arguments : ''
      const call = {
        callId: String(data.callId ?? ''),
        name,
        kind: 'dsh',
        summary: summarizeCall(name, argumentsText),
        commands: [],
        files: [],
        workdirs: [],
        arguments: argumentsText,
        timestamp: time,
        output: '',
        failed: false,
      }
      toolCalls.push(call)
      if (call.callId) callsById.set(call.callId, call)
      continue
    }

    if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const callId = String(message.toolCallId ?? message.source?.callId ?? '')
      const call = callsById.get(callId)
      if (!call) continue
      const output = contentText(message.content)
      call.output = output.replace(/\s+/gu, ' ').trim().slice(0, OUTPUT_PREVIEW_CHARS)
      call.failed = message.isError === true
      continue
    }
  }

  if (!id) id = 'dsh-session'
  if (!title) {
    const first = messages.find((message) => message.role === 'user')
    title = first ? first.text.replace(/\s+/gu, ' ').slice(0, 80) : ''
  }
  if (!createdAt) createdAt = messages.find((message) => message.timestamp)?.timestamp ?? ''

  return {
    id,
    filePath: options.filePath ?? '',
    cwd,
    title,
    createdAt,
    updatedAt: updatedAt || createdAt,
    startedAt: createdAt,
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.role === 'user').length,
    assistantMessageCount: messages.filter((message) => message.role === 'assistant').length,
    toolCallCount: toolCalls.length,
    failedToolCallCount: toolCalls.filter((call) => call.failed).length,
    touchedFiles: [],
    preview: messages.find((message) => message.role === 'user')?.text.slice(0, 200) ?? '',
    messages,
    toolCalls,
    todos,
    turns: turn,
    steps: step,
    sourceId: options.sourceId ?? '',
    sourceLabel: options.sourceLabel ?? '',
    isLocal: options.isLocal === true,
  }
}

/**
 * Read and parse one DSH session log.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @returns {object|null}
 */
export function parseDshLogFile(filePath, options = {}) {
  let buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch {
    return null
  }
  const raw = decodeZstdContainer(buffer)
  if (!raw) return null
  return parseDshLog(raw, { ...options, filePath })
}
