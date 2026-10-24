/**
 * Codex rollout parsing.
 *
 * Codex writes one JSONL file per conversation under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
 * Every line is `{ timestamp, ordinal, type, payload }`.
 *
 * This module is dependency-free (node builtins only) so the bundle can be
 * installed into a Harness profile without pulling any package.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROLLOUT_FILE = /rollout-.*\.jsonl$/i
const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const ANNOTATION_MARKER = /:codex-annotation\{index="\d+"\}/gu
const PATCH_FILE_HEADER = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/g
const COMMAND_KEYS = new Set(['cmd', 'command'])
const FILE_KEYS = new Set(['path', 'file_path', 'file', 'filePath', 'notebook_path', 'target_file'])
const OUTPUT_PREVIEW_CHARS = 240
const SUMMARY_CHARS = 160

/**
 * Remove the inline annotation anchors Codex writes into an answer.
 *
 * The Codex UI renders `:codex-annotation{index="1"}` as a clickable marker
 * bound to a comment the user placed on an earlier message. The marker is a
 * UI affordance, not prose, so a plain transcript must not carry it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnnotationMarkers(text) {
  if (typeof text !== 'string' || !text.includes('codex-annotation')) return text
  return text.replace(ANNOTATION_MARKER, '').replace(/[ \t]+(?=\n)/gu, '').trim()
}

/** @returns {string|null} the session uuid encoded in a rollout file name. */
export function sessionIdFromFile(filePath) {
  const match = UUID_IN_NAME.exec(path.basename(filePath))
  return match ? match[1] : null
}

/** @returns {boolean} whether the path looks like a Codex rollout file. */
export function isRolloutFile(filePath) {
  return ROLLOUT_FILE.test(path.basename(filePath))
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
}

/**
 * Walk an arbitrary JSON value and collect the string values stored under
 * any of the given keys.
 *
 * @param {unknown} value
 * @param {Set<string>} keys
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectValues(value, keys, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, keys, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      if (typeof item === 'string') out.push(item)
      else if (Array.isArray(item)) {
        for (const part of item) if (typeof part === 'string') out.push(part)
      }
      continue
    }
    if (typeof item === 'object' && item !== null) collectValues(item, keys, out)
  }
  return out
}

/**
 * Describe one tool invocation in a form a human can read.
 *
 * Codex records two shapes: `custom_tool_call` (a JavaScript snippet calling
 * `tools.exec_command({ cmd })`) and `function_call` (a JSON `arguments`
 * string). Both carry the real work of the turn — the commands that ran and
 * the files that were touched — which is exactly what a work report needs.
 *
 * @param {object} payload a `response_item` payload of type `custom_tool_call` or `function_call`
 * @returns {{name: string, kind: string, commands: string[], files: string[], summary: string}|null}
 */
export function summarizeToolCall(payload) {
  if (!payload || typeof payload !== 'object') return null
  const kind = payload.type === 'custom_tool_call' ? 'custom' : payload.type === 'function_call' ? 'function' : ''
  if (!kind) return null

  const name = typeof payload.name === 'string' && payload.name ? payload.name : 'unknown'
  const raw = kind === 'custom' ? String(payload.input ?? '') : String(payload.arguments ?? '')

  let parsed = null
  if (kind === 'function' && raw.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }

  const commands = []
  const files = []
  const workdirs = []

  if (parsed) {
    for (const value of collectValues(parsed, COMMAND_KEYS)) {
      if (value.trim()) commands.push(value.trim())
    }
    for (const value of collectValues(parsed, FILE_KEYS)) {
      if (value.trim() && !files.includes(value.trim())) files.push(value.trim())
    }
    for (const value of collectValues(parsed, new Set(['workdir', 'cwd']))) {
      if (value.trim() && !workdirs.includes(value.trim())) workdirs.push(value.trim())
    }
  }

  // `exec` calls embed the real command inside a JavaScript snippet.
  for (const match of raw.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
    const command = match[1].replace(/\\"/gu, '"').replace(/\\\\/gu, '\\').split(/\\n/gu)[0].trim()
    if (command && !commands.includes(command)) commands.push(command.trim())
  }
  for (const match of raw.matchAll(/\b(?:path|file_path|filePath)\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
    const file = match[1].replace(/\\"/gu, '"').replace(/\\\\/gu, '\\').trim()
    if (file && !files.includes(file)) files.push(file)
  }
  for (const match of raw.matchAll(/\bworkdir\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
    const dir = match[1].replace(/\\"/gu, '"').replace(/\\\\/gu, '\\').trim()
    if (dir && !workdirs.includes(dir)) workdirs.push(dir)
  }

  // apply_patch carries the touched files in the patch header.
  for (const match of raw.matchAll(PATCH_FILE_HEADER)) {
    // The patch travels as an escaped string, so the file name ends at the
    // first newline escape, not at the end of the whole snippet.
    const file = match[1].split(/\\n|\r|\n/u)[0].replace(/\\\\/gu, '\\').trim()
    if (file && !files.includes(file)) files.push(file)
  }

  let summary = ''
  if (commands.length > 0) summary = commands[0]
  else if (files.length > 0) summary = files.join(', ')
  else summary = raw.replace(/\s+/gu, ' ').trim()
  if (summary.length > SUMMARY_CHARS) summary = `${summary.slice(0, SUMMARY_CHARS)}…`

  return { name, kind, commands, files, workdirs, summary }
}

/**
 * Flatten a tool output payload into plain text.
 *
 * @param {unknown} output
 * @returns {string}
 */
export function toolOutputText(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return textOf(output)
  if (output && typeof output === 'object') {
    const text = textOf(output.content ?? output.output ?? [])
    if (text) return text
    try {
      return JSON.stringify(output)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Decide whether a tool output reports a failure.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksFailed(text) {
  if (!text) return false
  return /(^|\n)\s*(?:error|failed|exception|traceback)\b/i.test(text) || /exit code:\s*[1-9]/i.test(text)
}

/**
 * Normalize one raw user message.
 *
 * Codex wraps user input in a few machine oriented envelopes; the raw text is
 * noisy for a transcript, so each envelope is unwrapped into plain prose.
 *
 * @returns {{text: string, kind: string}|null} null when the message carries
 * no human content (for example the injected `<environment_context>` block).
 */
export function cleanUserText(raw) {
  let text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null

  // The first user record of every session is the environment envelope.
  if (text.startsWith('<environment_context>')) return null

  // Answer to a clarification round: a JSON array of {question, answer}.
  const questionReply = /<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/.exec(text)
  if (questionReply) {
    try {
      const items = JSON.parse(questionReply[1].trim())
      if (Array.isArray(items) && items.length > 0) {
        const lines = items.map((item, index) => {
          const question = String(item?.question ?? '').trim()
          const answer = String(item?.answer ?? '').trim()
          return `Q${index + 1}: ${question}\nA${index + 1}: ${answer}`
        })
        const rest = text.replace(questionReply[0], '').trim()
        return { text: [lines.join('\n\n'), rest].filter(Boolean).join('\n\n'), kind: 'question-reply' }
      }
    } catch {
      /* fall through to the raw text */
    }
  }

  // "Files mentioned by the user" plus the actual request.
  if (text.startsWith('# Files mentioned by the user:')) {
    const files = [...text.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].trim())
    const request = /##\s*My request:\s*([\s\S]*)$/.exec(text)
    const body = request ? request[1].trim() : text
    const header = files.length > 0 ? `提到的文件：\n${files.map((f) => `- ${f}`).join('\n')}\n\n` : ''
    return { text: `${header}${body}`.trim(), kind: 'request' }
  }

  // Annotations over an earlier answer.
  if (text.startsWith('# Response annotations:')) {
    const annotations = /<response-annotations>([\s\S]*?)<\/response-annotations>/.exec(text)
    if (annotations) {
      try {
        const items = JSON.parse(annotations[1].trim())
        if (Array.isArray(items) && items.length > 0) {
          const lines = items.map((item, index) => {
            const comment = typeof item?.comment === 'string' ? item.comment.trim() : ''
            const quoted = String(item?.text ?? '').trim()
            const body = comment || quoted
            return `批注 ${index + 1}${comment ? '（针对上面这段内容）' : ''}：${body}`
          })
          return { text: lines.join('\n\n'), kind: 'annotation' }
        }
      } catch {
        /* fall through to the raw text */
      }
    }
  }

  return { text, kind: 'message' }
}

/**
 * Parse one rollout file into a transcript.
 *
 * @param {string} filePath absolute path of the rollout file
 * @param {{maxMessages?: number}} [options]
 * @returns {object|null} the parsed session, or null when the file is unusable
 */
export function parseRolloutFile(filePath, options = {}) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  return parseRollout(raw, { filePath, ...options })
}

/**
 * Parse rollout JSONL text into a transcript.
 *
 * @param {string} raw the file content
 * @param {{filePath?: string, maxMessages?: number}} [options]
 * @returns {object|null}
 */
export function parseRollout(raw, options = {}) {
  const maxMessages = options.maxMessages ?? 5000
  const lines = raw.split('\n')
  const messages = []
  const fallback = []
  const toolCalls = []
  const callsById = new Map()
  let meta = null
  let cwd = ''
  let model = ''
  let lastAgentMessage = ''
  let startedAt = ''
  let updatedAt = ''

  const push = (list, role, text, timestamp, kind) => {
    if (!text) return
    const clean = stripAnnotationMarkers(text)
    if (!clean) return
    if (list.length >= maxMessages) return
    list.push({ role, text: clean, timestamp: timestamp ?? '', kind: kind ?? role })
  }

  for (const line of lines) {
    if (!line || !line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : ''

    if (record.type === 'session_meta') {
      meta = payload
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.timestamp === 'string') startedAt = payload.timestamp
      continue
    }

    if (record.type === 'turn_context') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.model === 'string') model = payload.model
      continue
    }

    if (record.type === 'response_item') {
      if (payload.type === 'message') {
        const role = payload.role
        const content = textOf(payload.content)
        if (role === 'user') {
          const cleaned = cleanUserText(content)
          if (cleaned) push(messages, 'user', cleaned.text, timestamp, cleaned.kind)
        } else if (role === 'assistant') {
          push(messages, 'assistant', content.trim(), timestamp, 'assistant')
        }
      } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const summary = summarizeToolCall(payload)
        if (summary) {
          const call = {
            callId: String(payload.call_id ?? payload.id ?? ''),
            name: summary.name,
            kind: summary.kind,
            summary: summary.summary,
            commands: summary.commands,
            files: summary.files,
            workdirs: summary.workdirs,
            timestamp,
            output: '',
            failed: false,
          }
          toolCalls.push(call)
          if (call.callId) callsById.set(call.callId, call)
        }
      } else if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        const call = callsById.get(String(payload.call_id ?? ''))
        if (call) {
          const output = toolOutputText(payload.output)
          call.output = output.replace(/\s+/gu, ' ').trim().slice(0, OUTPUT_PREVIEW_CHARS)
          call.failed = looksFailed(output)
        }
      }
      continue
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'item_completed' && payload.item && typeof payload.item === 'object') {
        const item = payload.item
        const content = textOf(item.content)
        if (item.type === 'UserMessage') {
          const cleaned = cleanUserText(content)
          if (cleaned) push(fallback, 'user', cleaned.text, timestamp, cleaned.kind)
        } else if (item.type === 'AgentMessage') {
          push(fallback, 'assistant', content.trim(), timestamp, 'assistant')
        }
      } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
        lastAgentMessage = payload.last_agent_message
      }
      continue
    }
  }

  if (messages.length === 0 && fallback.length > 0) messages.push(...fallback)

  if (lastAgentMessage) {
    const hasSame = messages.some((m) => m.role === 'assistant' && m.text.trim() === lastAgentMessage.trim())
    if (!hasSame) {
      push(messages, 'assistant', lastAgentMessage, updatedAt, 'assistant')
    }
  }

  const id = (meta && (meta.session_id ?? meta.id)) || sessionIdFromFile(options.filePath ?? '') || path.basename(options.filePath ?? 'session')
  const firstUser = messages.find((m) => m.role === 'user')
  const timestamps = messages.map((m) => m.timestamp).filter(Boolean)
  const touchedFiles = []
  for (const call of toolCalls) {
    for (const file of call.files) if (!touchedFiles.includes(file)) touchedFiles.push(file)
  }

  return {
    id: String(id),
    filePath: options.filePath ?? '',
    cwd: cwd || (meta && typeof meta.cwd === 'string' ? meta.cwd : '') || '',
    title: '',
    originator: (meta && typeof meta.originator === 'string' ? meta.originator : '') || '',
    cliVersion: (meta && typeof meta.cli_version === 'string' ? meta.cli_version : '') || '',
    modelProvider: (meta && typeof meta.model_provider === 'string' ? meta.model_provider : '') || '',
    model,
    startedAt: startedAt || timestamps[0] || '',
    updatedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1] : startedAt,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === 'user').length,
    assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
    toolCallCount: toolCalls.length,
    failedToolCallCount: toolCalls.filter((call) => call.failed).length,
    touchedFiles,
    preview: firstUser ? firstUser.text.slice(0, 200) : '',
    messages,
    toolCalls,
  }
}

/**
 * Parse `~/.codex/session_index.jsonl` into a title map.
 *
 * @param {string} raw file content
 * @returns {Map<string, {title: string, updatedAt: string}>}
 */
export function parseSessionIndex(raw) {
  const titles = new Map()
  if (typeof raw !== 'string') return titles
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry.id === 'string') {
        titles.set(entry.id, {
          title: typeof entry.thread_name === 'string' ? entry.thread_name : '',
          updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : '',
        })
      }
    } catch {
      continue
    }
  }
  return titles
}
