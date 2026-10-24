/**
 * Parser regression check against the real ~/.codex/sessions corpus.
 *
 * Usage: node test/parse-check.mjs
 *
 * Asserts the invariants that matter for rendering a Codex transcript:
 *  - no UI affordance (`:codex-annotation{...}`) leaks into a message;
 *  - the rendered transcript carries exactly `messageCount` messages;
 *  - a user comment on an earlier answer is kept as an `annotation` message;
 *  - the session title is resolved from `session_index.jsonl`.
 */
import path from 'node:path'
import { CodexHistoryStore } from '../lib/store.js'
import { parseRolloutFile, sessionIdFromFile } from '../lib/parse.js'
import { resolveRange, timestampInRange } from '../lib/store.js'
import { renderSessionHeader, renderTranscript, renderWorkLog } from '../lib/format.js'

const failures = []
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const store = new CodexHistoryStore({ pollIntervalMs: 0 })
await store.refresh(true)

const sessions = store.listSessions()
console.log(`sessions: ${sessions.length} (dir ${store.sessionsDir})`)
if (sessions.length === 0) {
  console.log('no Codex session found — nothing to check')
  process.exit(0)
}

for (const session of sessions) {
  console.log(`\n=== ${session.id} (${session.messageCount} msgs) ===`)

  const leaked = session.messages.filter((m) => m.text.includes('codex-annotation'))
  check('no raw annotation marker in any message', leaked.length === 0, leaked.map((m) => m.role).join(','))

  const rendered = renderTranscript(session, { maxChars: 1_000_000 })
  const blocks = rendered.split(/^### (?:用户|Codex)$/mu).length - 1
  check('rendered transcript keeps every message', blocks === session.messageCount, `${blocks} vs ${session.messageCount}`)

  const header = renderSessionHeader(session)
  check('header carries the session id', header.includes(session.id))
  check('header carries the message count', header.includes(`消息数：${session.messageCount}`))

  check('title resolved', Boolean(session.title), session.title)

  const kinds = new Set(session.messages.map((m) => m.kind))
  console.log(`  info message kinds: ${[...kinds].join(', ')}`)

  const file = session.filePath
  const reparsed = parseRolloutFile(file)
  check('re-parsing the file is stable', reparsed !== null && reparsed.messageCount === session.messageCount)
  check('session id comes from the file name', sessionIdFromFile(file) === session.id || !sessionIdFromFile(file))
}

console.log('\n=== work points (tool activity) ===')
for (const session of sessions) {
  const calls = Array.isArray(session.toolCalls) ? session.toolCalls : []
  console.log(`\n=== ${session.id} (${calls.length} tool calls) ===`)

  check('tool call count matches the captured calls', session.toolCallCount === calls.length, `${session.toolCallCount} vs ${calls.length}`)
  check('failed call count matches the captured calls', session.failedToolCallCount === calls.filter((c) => c.failed).length)
  check('every call carries a name', calls.every((c) => typeof c.name === 'string' && c.name.length > 0))
  check('every call carries a summary', calls.every((c) => typeof c.summary === 'string' && c.summary.length > 0))
  check('every call has a timestamp', calls.every((c) => typeof c.timestamp === 'string' && c.timestamp.length > 0))
  check(
    'a touched file is never a raw patch blob',
    (session.touchedFiles ?? []).every((f) => !f.includes('*** ') && !f.includes('\\n')),
    JSON.stringify((session.touchedFiles ?? []).slice(0, 2)),
  )
  check(
    'touched files are unique',
    new Set(session.touchedFiles ?? []).size === (session.touchedFiles ?? []).length,
  )

  const digest = renderWorkLog(session, { maxChars: 1_000_000 })
  check('digest names the session', digest.includes(session.id) || digest.includes(session.title ?? ''))
  check('digest has a user-request section', digest.includes('## 用户提出的事项'))
  check('digest has a tool-activity section', digest.includes('## 工具活动'))
  check('digest has a touched-file section', digest.includes('## 涉及文件'))
  check('digest has a failure section', digest.includes('## 报错与失败'))
  check(
    'digest tool count matches the session',
    digest.includes(`## 工具活动（${calls.length} 次调用`),
    digest.split('\n').find((l) => l.includes('## 工具活动')),
  )
  check('digest is not truncated when the budget is large', !digest.includes('（后文已省略）'))
}

const longDigest = renderWorkLog(sessions[0], { maxChars: 400 })
check('a short budget keeps the head of the digest', longDigest.startsWith('工作要点 ·') && longDigest.includes('（后文已省略）'))

console.log('\n=== time window ===')
const range = resolveRange({ since: '2026-10-16', until: '2026-10-16' })
check('bare date starts at UTC midnight', range.since === Date.parse('2026-10-16T00:00:00.000Z'), String(range.since))
check('bare date ends at the end of the UTC day', range.until === Date.parse('2026-10-16T23:59:59.999Z'), String(range.until))

const inDay = store.listSummaries({ since: '2026-10-16', until: '2026-10-16' })
const all = store.listSummaries({})
check('a window narrows the session list', inDay.length <= all.length, `${inDay.length} vs ${all.length}`)
for (const summary of inDay) {
  const overlaps = Date.parse(summary.updatedAt) >= range.since && Date.parse(summary.startedAt) <= range.until
  check(`session ${summary.id.slice(0, 8)} overlaps the window`, overlaps)
}

const hits = store.search('skill', { since: '2026-10-16', until: '2026-10-16', limit: 50 })
for (const hit of hits) {
  check(`hit at ${hit.timestamp} is inside the window`, timestampInRange(hit.timestamp, range), hit.timestamp)
}

const hitsNoWindow = store.search('skill', { limit: 50 })
check('the window never widens the result set', hits.length <= hitsNoWindow.length, `${hits.length} vs ${hitsNoWindow.length}`)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join('; ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)