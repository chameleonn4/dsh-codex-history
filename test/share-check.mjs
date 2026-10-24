/**
 * Cross-machine sharing check.
 *
 * Usage: node test/share-check.mjs
 *
 * Simulates the dorm desktop and the office laptop with two synthetic
 * machines and asserts the whole chain:
 *  - the local Codex and DSH logs are mirrored into the share folder;
 *  - the mirror only writes inside the folder of this machine;
 *  - the folders of the other machine are discovered and read;
 *  - a remote Codex session shows up with its machine label;
 *  - a remote DSH session can be listed, read and searched;
 *  - a `session_index` conflict copy still contributes its title.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { CodexHistoryStore } from '../lib/store.js'
import { DshHistoryStore } from '../lib/dshstore.js'
import { ShareMirror, discoverCodexSources, discoverDshSources, readMachineDescriptors } from '../lib/share.js'

const failures = []
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-'))
const localCodex = path.join(root, 'local', 'codex')
const localDsh = path.join(root, 'local', 'dsh', 'sessions')
const shareDir = path.join(root, 'CodexShare')

const write = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

/** Build a Codex rollout file. */
function rollout(id, cwd, messages, startedAt = '2026-10-24T01:00:00.000Z') {
  const lines = [
    JSON.stringify({
      timestamp: startedAt,
      type: 'session_meta',
      payload: { id, cwd, timestamp: startedAt, originator: 'codex_cli_rs', cli_version: '0.42.0' },
    }),
  ]
  for (const message of messages) {
    lines.push(
      JSON.stringify({
        timestamp: message.timestamp ?? startedAt,
        type: 'response_item',
        payload: { type: 'message', role: message.role, content: [{ type: 'input_text', text: message.text }] },
      }),
    )
  }
  return `${lines.join('\n')}\n`
}

/** Build a DSH v4 session log: a container of several zstd frames. */
function dshLog({ id, cwd, title, messages, createdAt = 1792210277301 }) {
  const events = [
    { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'session/title', seq: 1, time: createdAt + 1000, data: { title, messageSeqs: [2], source: { kind: 'fallback' } } },
    ...messages.flatMap((message, index) => [
      {
        type: 'user/message',
        seq: 2 + index * 2,
        time: createdAt + 2000 + index * 1000,
        data: { content: [{ type: 'text', text: message.user }], source: { kind: 'user' }, role: 'user', id: `u-${index}` },
      },
      {
        type: 'assistant/message',
        seq: 3 + index * 2,
        time: createdAt + 2500 + index * 1000,
        data: {
          turn: 1,
          step: index + 1,
          message: { role: 'assistant', content: [{ type: 'text', text: message.assistant }] },
        },
      },
    ]),
  ]
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  // Two frames, so the multi-frame container path is exercised.
  const half = Math.floor(text.length / 2)
  return Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(text.slice(0, half), 'utf8')),
    zlib.zstdCompressSync(Buffer.from(text.slice(half), 'utf8')),
  ])
}

console.log(`workspace: ${root}\n`)

// ---------------------------------------------------------------- this machine
const localRollout = path.join(localCodex, 'sessions', '2026', '10', '24', 'rollout-2026-10-24T01-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
write(localRollout, rollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'D:\\本地项目', [
  { role: 'user', text: '本机的问题：帮我看看这个脚本' },
  { role: 'assistant', text: '本机的回答。' },
]))
write(path.join(localCodex, 'session_index.jsonl'), `${JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', thread_name: '本机会话', updated_at: '2026-10-24T01:05:00.000Z' })}\n`)

const localDshId = 'session-11111111-2222-3333-4444-555555555555'
const localDshFile = path.join(localDsh, '--D-DSH~63D2--', localDshId, 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(localDshFile), { recursive: true })
fs.writeFileSync(localDshFile, dshLog({
  id: localDshId,
  cwd: 'D:\\本地项目',
  title: '本机 DSH 会话',
  messages: [{ user: '本机 DSH 的问题', assistant: '本机 DSH 的回答' }],
}))

// ------------------------------------------------------------------- the mirror
console.log('=== mirror ===')
const mirror = new ShareMirror({
  root: shareDir,
  machineId: 'desktop',
  label: '宿舍台式机',
  codexSessionsDir: path.join(localCodex, 'sessions'),
  codexIndexPath: path.join(localCodex, 'session_index.jsonl'),
  dshSessionsDir: localDsh,
  intervalMs: 0,
})
const first = await mirror.run()
check('the mirror copied files', first.copied >= 3, JSON.stringify(first))
check('the rollout landed in the share folder', fs.existsSync(path.join(shareDir, 'codex', 'desktop', 'sessions', '2026', '10', '24', path.basename(localRollout))))
check('the session index landed in the share folder', fs.existsSync(path.join(shareDir, 'codex', 'desktop', 'session_index.jsonl')))
check('the DSH log landed in the share folder', fs.existsSync(path.join(shareDir, 'dsh', 'desktop', 'sessions', '--D-DSH~63D2--', localDshId, 'session.v4.jsonl.zstd')))
check('the machine descriptor was written', fs.existsSync(path.join(shareDir, 'machines', 'desktop.json')))

const second = await mirror.run()
check('a second pass copies nothing', second.copied === 0, JSON.stringify(second))

// A file that changed on disk is copied again.
fs.appendFileSync(localRollout, `${JSON.stringify({ timestamp: '2026-10-24T02:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: '追加的回答。' }] } })}\n`)
const third = await mirror.run()
check('a changed file is copied again', third.copied === 1, JSON.stringify(third))

// ----------------------------------------------------------------- other machine
console.log('\n=== the other machine ===')
const remoteRolloutName = 'rollout-2026-10-23T09-00-00-99999999-8888-7777-6666-555555555555.jsonl'
write(path.join(shareDir, 'codex', 'laptop', 'sessions', '2026', '10', '23', remoteRolloutName), rollout(
  '99999999-8888-7777-6666-555555555555',
  'D:\\工位项目',
  [
    { role: 'user', text: '工位的问题：帮我改一下这个函数', timestamp: '2026-10-23T09:00:01.000Z' },
    { role: 'assistant', text: '工位的回答。', timestamp: '2026-10-23T09:00:02.000Z' },
  ],
))
write(path.join(shareDir, 'codex', 'laptop', 'session_index.jsonl'), `${JSON.stringify({ id: '99999999-8888-7777-6666-555555555555', thread_name: '工位会话', updated_at: '2026-10-23T09:10:00.000Z' })}\n`)
write(path.join(shareDir, 'machines', 'laptop.json'), `${JSON.stringify({ machineId: 'laptop', label: '工位笔记本', hostname: 'R9000P' }, null, 2)}\n`)

const remoteDshId = 'session-99999999-8888-7777-6666-555555555555'
const remoteDshFile = path.join(shareDir, 'dsh', 'laptop', 'sessions', '--D-DSH~5DE5~4F4C--', remoteDshId, 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(remoteDshFile), { recursive: true })
fs.writeFileSync(remoteDshFile, dshLog({
  id: remoteDshId,
  cwd: 'D:\\工位项目',
  title: '工位 DSH 会话',
  messages: [
    { user: '工位 DSH 的问题：那个报错怎么修', assistant: '工位 DSH 的回答：改一行配置就行' },
  ],
}))

const descriptors = readMachineDescriptors(shareDir)
check('both machine descriptors are read', descriptors.size === 2, [...descriptors.keys()].join(','))
check('the remote label is read', descriptors.get('laptop')?.label === '工位笔记本', descriptors.get('laptop')?.label)

const codexSources = discoverCodexSources(shareDir, { exclude: 'desktop', descriptors })
check('the remote Codex folder is discovered', codexSources.length === 1, JSON.stringify(codexSources.map((s) => s.id)))
check('the remote source carries the machine label', codexSources[0]?.label === '工位笔记本')

const dshSources = discoverDshSources(shareDir, { exclude: 'desktop', descriptors })
check('the remote DSH folder is discovered', dshSources.length === 1, JSON.stringify(dshSources.map((s) => s.id)))

// --------------------------------------------------------------- reading it all
console.log('\n=== reading ===')
const store = new CodexHistoryStore({
  sessionsDir: path.join(localCodex, 'sessions'),
  indexPath: path.join(localCodex, 'session_index.jsonl'),
  pollIntervalMs: 0,
  sources: codexSources,
})
await store.refresh(true)
const sessions = store.listSessions()
check('both Codex sessions are listed', sessions.length === 2, `${sessions.length} sessions`)
const local = sessions.find((s) => s.sourceId === 'local')
const remote = sessions.find((s) => s.sourceId === 'share:laptop')
check('the local session keeps the local label', local?.sourceLabel === '本机', local?.sourceLabel)
check('the remote session carries the machine label', remote?.sourceLabel === '工位笔记本', remote?.sourceLabel)
check('the remote session carries its title', remote?.title === '工位会话', remote?.title)
check('the remote session keeps its working directory', remote?.cwd === 'D:\\工位项目', remote?.cwd)
check('the remote session has its messages', remote?.messageCount === 2, String(remote?.messageCount))

// A conflict copy of the index still contributes its title.
write(path.join(localCodex, 'session_index.sync-conflict-2026.jsonl'), `${JSON.stringify({ id: '99999999-8888-7777-6666-555555555555', thread_name: '工位会话（冲突副本）', updated_at: '2026-10-24T03:00:00.000Z' })}\n`)
await store.refresh(true)
const conflictTitle = store.listSessions().find((s) => s.id === '99999999-8888-7777-6666-555555555555')?.title
check('a conflict copy of the index still contributes its title', conflictTitle === '工位会话（冲突副本）', conflictTitle)

const hits = store.search('工位', { limit: 10 })
check('the remote session is searchable', hits.length > 0, `${hits.length} hits`)
check('a hit knows where it came from', hits[0]?.sourceLabel === '工位笔记本', hits[0]?.sourceLabel)

const dshStore = new DshHistoryStore({ sources: dshSources, pollIntervalMs: 0 })
await dshStore.refresh(true)
const dshSessions = dshStore.listSessions()
check('the remote DSH session is listed', dshSessions.length === 1, `${dshSessions.length} sessions`)
check('the remote DSH session carries its title', dshSessions[0]?.title === '工位 DSH 会话', dshSessions[0]?.title)
check('the remote DSH session carries its working directory', dshSessions[0]?.cwd === 'D:\\工位项目', dshSessions[0]?.cwd)
check('the remote DSH session carries its messages', dshSessions[0]?.messageCount === 2, String(dshSessions[0]?.messageCount))
check('the remote DSH session carries the machine label', dshSessions[0]?.sourceLabel === '工位笔记本', dshSessions[0]?.sourceLabel)

const dshHit = dshStore.search('报错', { limit: 5 })
check('the remote DSH session is searchable', dshHit.length === 1, `${dshHit.length} hits`)

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join('; ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
