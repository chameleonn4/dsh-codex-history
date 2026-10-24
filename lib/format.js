/**
 * Transcript rendering.
 *
 * Codex transcripts are rendered as plain Markdown so they can be handed to a
 * model, pasted into a DSH conversation, or shown in the UI.
 */

/**
 * @param {object} session
 * @param {{limit?: number, includeAssistant?: boolean, maxChars?: number}} [options]
 * @returns {string}
 */
export function renderTranscript(session, options = {}) {
  const limit = options.limit ?? session.messages.length
  const includeAssistant = options.includeAssistant !== false
  const maxChars = options.maxChars ?? 20000
  const messages = session.messages.slice(-Math.max(1, limit))
  const lines = []
  for (const message of messages) {
    if (message.role === 'assistant' && !includeAssistant) continue
    const label = message.role === 'user' ? '用户' : 'Codex'
    lines.push(`### ${label}`)
    lines.push(message.text)
    lines.push('')
  }
  let text = lines.join('\n').trim()
  if (text.length > maxChars) {
    const kept = text.slice(text.length - maxChars)
    const cut = text.slice(0, text.length - maxChars).indexOf('\n')
    text = `…（前文已省略）\n${cut >= 0 ? kept.slice(cut + 1) : kept}`
  }
  return text
}

/**
 * The header block describing one Codex session.
 *
 * @param {object} session
 * @returns {string}
 */
export function renderSessionHeader(session) {
  const lines = [
    `Codex 会话 ${session.id}`,
    `标题：${session.title || session.preview || '(无标题)'}`,
  ]
  if (session.sourceLabel) lines.push(`来源机器：${session.sourceLabel}`)
  if (session.cwd) lines.push(`工作目录：${session.cwd}`)
  if (session.startedAt) lines.push(`开始时间：${session.startedAt}`)
  if (session.updatedAt) lines.push(`最后更新：${session.updatedAt}`)
  lines.push(`消息数：${session.messageCount}`)
  return lines.join('\n')
}

/**
 * The header block describing one DSH session.
 *
 * @param {object} session
 * @returns {string}
 */
export function renderDshSessionHeader(session) {
  const lines = [
    `DSH 会话 ${session.id}`,
    `标题：${session.title || session.preview || '(无标题)'}`,
  ]
  if (session.sourceLabel) lines.push(`来源机器：${session.sourceLabel}`)
  if (session.cwd) lines.push(`工作目录：${session.cwd}`)
  if (session.startedAt) lines.push(`开始时间：${session.startedAt}`)
  if (session.updatedAt) lines.push(`最后更新：${session.updatedAt}`)
  lines.push(`消息数：${session.messageCount}`)
  return lines.join('\n')
}

/**
 * The transcript of one DSH session.
 *
 * @param {object} session
 * @param {{limit?: number, maxChars?: number}} [options]
 * @returns {string}
 */
export function renderDshTranscript(session, options = {}) {
  const maxChars = options.maxChars ?? 20000
  const limit = options.limit ?? session.messages.length
  const messages = session.messages.slice(-Math.max(1, limit))
  const lines = []
  for (const message of messages) {
    const label =
      message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role === 'system' ? '系统' : '工具'
    lines.push(`### ${label}`)
    lines.push(message.text)
    lines.push('')
  }
  let text = lines.join('\n').trim()
  if (text.length > maxChars) {
    const kept = text.slice(text.length - maxChars)
    const cut = text.slice(0, text.length - maxChars).indexOf('\n')
    text = `…（前文已省略）\n${cut >= 0 ? kept.slice(cut + 1) : kept}`
  }
  return text
}

/**
 * A compact one-line summary of one session.
 *
 * @param {object} session
 * @returns {string}
 */
export function renderSessionLine(session) {
  const when = session.updatedAt ? session.updatedAt.replace('T', ' ').replace(/\..*$/u, '') : '未知时间'
  const title = (session.title || session.preview || '(无标题)').replace(/\s+/gu, ' ').slice(0, 80)
  const cwd = session.cwd ? ` [${session.cwd}]` : ''
  const source = session.sourceLabel ? ` @${session.sourceLabel}` : ''
  return `- ${when}${source} · ${session.messageCount} 条 · ${title}${cwd} · id=${session.id}`
}

/**
 * The text injected when a tracked Codex session received new messages.
 *
 * Only the messages after `fromIndex` are rendered, so the update stays small
 * no matter how long the conversation has become.
 *
 * @param {object} session
 * @param {number} fromIndex index of the first message that is new
 * @param {{maxChars?: number}} [options]
 * @returns {string} the payload, or an empty string when nothing is new
 */
export function renderDeltaPayload(session, fromIndex, options = {}) {
  const maxChars = options.maxChars ?? 6000
  const messages = session.messages.slice(Math.max(0, fromIndex))
  if (messages.length === 0) return ''
  const lines = [
    `Codex 会话 ${session.id} 有了新的进展（新增 ${messages.length} 条消息，最后更新 ${session.updatedAt || '未知时间'}）。`,
    '请把下面这些新增内容当作当前任务的最新上下文继续工作。',
    '',
  ]
  for (const message of messages) {
    lines.push(`### ${message.role === 'user' ? '用户' : 'Codex'}`)
    lines.push(message.text)
    lines.push('')
  }
  let text = lines.join('\n').trim()
  if (text.length > maxChars) {
    const kept = text.slice(text.length - maxChars)
    const cut = text.slice(0, text.length - maxChars).indexOf('\n')
    text = `…（前文已省略）\n${cut >= 0 ? kept.slice(cut + 1) : kept}`
  }
  return text
}

/**
 * The text injected into a DSH conversation when a Codex session is imported.
 *
 * @param {object} session
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function renderImportPayload(session, options = {}) {
  const maxChars = options.maxChars ?? 12000
  return [
    '以下内容来自本地 Codex CLI 的历史会话记录（自动读取 ~/.codex/sessions）。',
    '请把它当作当前任务的既有上下文，在其基础上继续工作；如需更多细节，可调用 codex_history 工具读取完整记录。',
    '',
    renderSessionHeader(session),
    '',
    renderTranscript(session, { maxChars }),
  ].join('\n')
}

/**
 * A work-point digest for one Codex session.
 *
 * The transcript alone only shows the conversation. The commands that ran and
 * the files that were touched are where the actual work is, so the digest
 * groups the tool activity and lists the touched files.
 *
 * @param {object} session
 * @param {{maxChars?: number, maxItems?: number}} [options]
 * @returns {string}
 */
export function renderWorkLog(session, options = {}) {
  const maxChars = options.maxChars ?? 12000
  const maxItems = options.maxItems ?? 10
  const lines = []

  lines.push(`工作要点 · ${session.title || session.preview || session.id}`)
  const when = [session.startedAt, session.updatedAt].filter(Boolean).join(' → ')
  if (when) lines.push(`时间：${when}`)
  if (session.cwd) lines.push(`工作目录：${session.cwd}`)
  lines.push('')

  const requests = session.messages.filter((m) => m.role === 'user')
  const answers = session.messages.filter((m) => m.role === 'assistant')
  lines.push(`## 用户提出的事项（${requests.length}）`)
  if (requests.length === 0) lines.push('- （无用户消息）')
  for (const message of requests.slice(0, maxItems)) {
    lines.push(`- ${message.text.replace(/\s+/gu, ' ').slice(0, 200)}`)
  }
  lines.push('')

  lines.push(`## 助手的产出（${answers.length}）`)
  if (answers.length === 0) lines.push('- （无助手消息）')
  for (const message of answers.slice(-maxItems)) {
    lines.push(`- ${message.text.replace(/\s+/gu, ' ').slice(0, 200)}`)
  }
  lines.push('')

  const calls = Array.isArray(session.toolCalls) ? session.toolCalls : []
  const groups = new Map()
  for (const call of calls) {
    const key = call.name || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(call)
  }
  lines.push(`## 工具活动（${calls.length} 次调用，${groups.size} 种工具）`)
  if (groups.size === 0) lines.push('- （本次会话没有记录到工具调用）')
  for (const [name, list] of groups) {
    const files = []
    for (const call of list) for (const file of call.files) if (!files.includes(file)) files.push(file)
    const commands = []
    for (const call of list) for (const command of call.commands) if (!commands.includes(command)) commands.push(command)
    const detail = files.length > 0 ? files.slice(0, 8).join('、') : commands.slice(0, 3).join('；')
    lines.push(`- ${name}（${list.length} 次）：${detail || '—'}`)
  }
  lines.push('')

  const files = Array.isArray(session.touchedFiles) ? session.touchedFiles : []
  lines.push(`## 涉及文件（${files.length}）`)
  if (files.length === 0) lines.push('- （没有记录到文件操作）')
  for (const file of files.slice(0, maxItems * 2)) lines.push(`- ${file}`)
  lines.push('')

  const failed = calls.filter((call) => call.failed)
  lines.push(`## 报错与失败（${failed.length}）`)
  if (failed.length === 0) lines.push('- （没有记录到失败）')
  for (const call of failed.slice(0, maxItems)) {
    lines.push(`- ${call.name}：${call.output || call.summary}`)
  }

  let text = lines.join('\n').trim()
  if (text.length > maxChars) {
    // The digest is read top down, so the head stays and the tail is cut.
    text = `${text.slice(0, maxChars)}\n…（后文已省略）`
  }
  return text
}
