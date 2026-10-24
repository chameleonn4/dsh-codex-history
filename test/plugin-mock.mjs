/**
 * Integration test for the plugin's Host half.
 *
 * Loads index.js with a mock plugin context and exercises the tool, the
 * command, the HTTP routes, and the agent/created hook.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const logs = []
const sections = []
const injected = []
let tool = null
let command = null
let route = null
const handlers = new Map()

const agent = {
  id: 'agent-1',
  ctx: {
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: (name) => (name === 'TOOL_SESSION_QUERY' ? 2300 : 0),
    },
  },
  session: { header: { cwd: 'D:\\skills' } },
  inject: (message) => injected.push({ via: 'inject', message }),
  followup: (message) => injected.push({ via: 'followup', message }),
}

const ctx = {
  logger: {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  },
  effect: (fn) => {
    const result = fn()
    return typeof result === 'function' ? result : undefined
  },
  on: (event, handler) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get: (name) => {
    if (name === 'agents') {
      return { get: (id) => (id === 'agent-1' ? agent : undefined), roots: () => [agent] }
    }
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  tools: { register: (definition) => { tool = definition; return () => {} } },
  commands: { register: (definition) => { command = definition; return () => {} } },
  webServer: { register: (definition) => { route = definition; return () => {} } },
}

apply(ctx, {})
console.log('apply() ok — logs:', logs.filter(([l]) => l === 'info').length, 'info line(s)')

// --- tool -----------------------------------------------------------------
assert.ok(tool, 'tool registered')
assert.equal(tool.name, 'codex_history')
assert.equal(tool.parameters.required[0], 'action')

const listed = await tool.execute({ action: 'list' }, {})
assert.equal(listed.action, 'list')
assert.ok(Array.isArray(listed.sessions), 'list returns sessions')
assert.ok(listed.sessions.length >= 1, 'at least one Codex session found')
console.log('tool list →', listed.sessions.length, 'session(s)')

const first = listed.sessions[0]
const read = await tool.execute({ action: 'read', session_id: first.id }, {})
assert.ok(read.text.includes('Codex 会话'), 'read returns a transcript')
console.log('tool read →', read.text.length, 'chars')

const searched = await tool.execute({ action: 'search', query: 'codex' }, {})
assert.ok(searched.hits.length >= 1, 'search finds hits')
console.log('tool search →', searched.hits.length, 'hit(s)')

const latest = await tool.execute({ action: 'latest', cwd: 'D:\\skills' }, {})
assert.ok(latest.session, 'latest finds the session for D:\\skills')
console.log('tool latest →', latest.session.id)

const missing = await tool.execute({ action: 'read', session_id: 'nope' }, {})
assert.ok(missing.error, 'unknown id reports an error')

// --- command --------------------------------------------------------------
assert.ok(command, 'command registered')
assert.equal(command.name, 'codex')

const listResult = await command.handler({ rawInput: 'list', agent })
assert.equal(listResult.kind, 'success')
assert.ok(listResult.text.includes('Codex'), 'command lists sessions')

const importResult = await command.handler({ rawInput: first.id, agent })
assert.equal(importResult.kind, 'success')
assert.equal(injected.at(-1).via, 'followup')
assert.equal(injected.at(-1).message.role, 'user')
assert.equal(injected.at(-1).message.source.kind, 'user')
assert.ok(injected.at(-1).message.content[0].text.includes('Codex CLI'))
console.log('command import → injected', injected.at(-1).message.content[0].text.length, 'chars')

// --- routes ---------------------------------------------------------------
assert.ok(route, 'route registered')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/api/codex-history')

const callRoute = async (method, url, body) => {
  const request = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) { status = code; return response },
    end(text) { payload = text; return response },
  }
  await route.handler(request, response)
  return { status, body: payload ? JSON.parse(payload) : undefined }
}

const sessionsResponse = await callRoute('GET', '/api/codex-history/sessions?limit=5')
assert.equal(sessionsResponse.status, 200)
assert.equal(sessionsResponse.body.ok, true)
assert.ok(sessionsResponse.body.sessions.length >= 1)
console.log('route sessions →', sessionsResponse.body.sessions.length, 'session(s)')

const searchResponse = await callRoute('GET', '/api/codex-history/sessions?query=skills')
assert.equal(searchResponse.body.sessions.length, 1)
assert.equal(searchResponse.body.sessions[0].cwd, 'D:\\skills')

const oneResponse = await callRoute('GET', `/api/codex-history/session?id=${first.id}`)
assert.equal(oneResponse.status, 200)
assert.ok(Array.isArray(oneResponse.body.session.messages))

const worklogResponse = await callRoute('GET', `/api/codex-history/worklog?id=${first.id}`)
assert.equal(worklogResponse.status, 200)
assert.equal(worklogResponse.body.ok, true)
assert.ok(typeof worklogResponse.body.text === 'string' && worklogResponse.body.text.length > 0)
assert.ok(worklogResponse.body.sessions[0].id === first.id)
console.log('route worklog →', worklogResponse.body.text.length, 'chars')

const worklogWindow = await callRoute('GET', '/api/codex-history/worklog?since=2026-10-22&until=2026-10-22')
assert.equal(worklogWindow.status, 200)
assert.ok(worklogWindow.body.sessions.length >= 1)

const worklogMissing = await callRoute('GET', '/api/codex-history/worklog?id=nope')
assert.equal(worklogMissing.status, 404)

const notFound = await callRoute('GET', '/api/codex-history/session?id=nope')
assert.equal(notFound.status, 404)

const importResponse = await callRoute('POST', '/api/codex-history/import', { id: first.id, targetSessionId: 'agent-1' })
assert.equal(importResponse.status, 200)
assert.equal(importResponse.body.imported, true)
assert.equal(injected.at(-1).via, 'followup')
console.log('route import → injected into agent-1')

const badTarget = await callRoute('POST', '/api/codex-history/import', { id: first.id, targetSessionId: 'ghost' })
assert.equal(badTarget.status, 409)

const unknown = await callRoute('GET', '/api/codex-history/nope')
assert.equal(unknown.status, 404)
console.log('route error paths → 404 / 409 ok')

// --- agent hook -----------------------------------------------------------
assert.ok(sections.length === 0, 'no prompt section before an agent exists')
await handlers.get('agent/created')({ agent })
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'codex-history')
assert.equal(sections[0].order, 2300)
assert.ok(sections[0].text().includes('codex_history'))
console.log('agent hook → prompt section registered')

const autoImported = injected.filter((entry) => entry.via === 'inject')
assert.equal(autoImported.length, 1, 'the matching Codex session was auto-imported')
assert.ok(autoImported[0].message.content[0].text.includes('D:\\skills'))
console.log('agent hook → auto-imported', autoImported[0].message.content[0].text.length, 'chars of Codex context')

console.log('\nALL HOST INTEGRATION CHECKS PASSED')
