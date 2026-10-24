/**
 * End-to-end check of the live sync: a Codex session that grows on disk has to
 * push its new messages into the DSH conversation that already carries its
 * context.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const CWD = 'D:\\skills'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'))
const sessionsDir = path.join(root, 'sessions')
const dayDir = path.join(sessionsDir, '2026', '10', '22')
fs.mkdirSync(dayDir, { recursive: true })
const rollout = path.join(dayDir, `rollout-2026-10-22T23-12-43-${SESSION_ID}.jsonl`)

const line = (timestamp, type, payload) => `${JSON.stringify({ timestamp, ordinal: 1, type, payload })}\n`

fs.writeFileSync(
  rollout,
  line('2026-10-22T23:12:43.000Z', 'session_meta', {
    id: SESSION_ID,
    session_id: SESSION_ID,
    timestamp: '2026-10-22T23:12:43.000Z',
    cwd: CWD,
    originator: 'Codex Desktop',
    cli_version: '0.163.0-alpha.11',
    model_provider: 'custom',
  }) +
    line('2026-10-22T23:12:44.000Z', 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '第一个问题' }],
    }) +
    line('2026-10-22T23:12:45.000Z', 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '第一个回答' }],
    }),
  'utf8',
)

const injected = []
const sections = []
const handlers = new Map()
const agent = {
  id: 'agent-1',
  ctx: {
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: () => 2300,
    },
  },
  session: { header: { cwd: CWD } },
  inject: (message) => injected.push({ via: 'inject', message }),
  followup: (message) => injected.push({ via: 'followup', message }),
}

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => {
    const result = fn()
    return typeof result === 'function' ? result : undefined
  },
  on: (event, handler) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get: (name) => {
    if (name === 'agents') return { get: (id) => (id === 'agent-1' ? agent : undefined), roots: () => [agent] }
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  tools: { register: () => () => {} },
  commands: { register: () => () => {} },
  webServer: { register: () => () => {} },
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

apply(ctx, { sessionsDir, indexPath: path.join(root, 'missing-index.jsonl'), pollIntervalMs: 100 })
await wait(400)

await handlers.get('agent/created')({ agent })

const first = injected.filter((entry) => entry.via === 'inject')
assert.equal(first.length, 1, 'the Codex session was auto-imported once')
assert.ok(first[0].message.content[0].text.includes('第一个回答'))
console.log('auto-import →', first[0].message.content[0].text.length, 'chars')

// Codex keeps working: append two more records to the rollout file.
fs.appendFileSync(
  rollout,
  line('2026-10-22T23:20:00.000Z', 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '继续做第二件事' }],
  }) +
    line('2026-10-22T23:20:01.000Z', 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '第二件事的进展' }],
    }),
  'utf8',
)

await wait(600)

const syncs = injected.filter((entry) => entry.via === 'inject')
assert.equal(syncs.length, 2, 'the grown session produced exactly one sync message')
const delta = syncs[1].message.content[0].text
assert.ok(delta.includes('第二件事的进展'), 'the sync carries the new messages')
assert.ok(delta.includes('继续做第二件事'))
assert.ok(!delta.includes('第一个回答'), 'the sync only carries what is new')
console.log('live sync →', delta.length, 'chars of new Codex content')

fs.rmSync(root, { recursive: true, force: true })
console.log('\nLIVE SYNC CHECK PASSED')
