/**
 * Codex History — read the local Codex CLI conversation history and hand it to
 * DeepSeek Harness.
 *
 * Host half. Responsibilities:
 *  - index `~/.codex/sessions` rollout jsonl files and keep them fresh;
 *  - expose the history to the model through the `codex_history` tool;
 *  - expose it to the user through the `/codex` command;
 *  - expose it to the Web UI through `/api/codex-history/*` routes;
 *  - optionally import the matching Codex session into a fresh DSH session;
 *  - mirror the local Codex and DSH logs into a shared folder so the other
 *    machine can read them, and read the logs the other machine shared.
 */
import { randomUUID } from 'node:crypto'
import { CodexHistoryStore, defaultIndexPath, defaultSessionsDir, expandPath, sameCwd } from './lib/store.js'
import { DshHistoryStore } from './lib/dshstore.js'
import {
  defaultDshSessionsDir,
  defaultMachineId,
  defaultShareDir,
  discoverCodexSources,
  discoverDshSources,
  readMachineDescriptors,
  sanitizeMachineId,
  ShareMirror,
} from './lib/share.js'
import {
  renderDeltaPayload,
  renderDshSessionHeader,
  renderDshTranscript,
  renderImportPayload,
  renderSessionHeader,
  renderSessionLine,
  renderTranscript,
  renderWorkLog,
} from './lib/format.js'

const API_BASE = '/api/codex-history'
const VERSION = '1.3.1'

const DEFAULTS = {
  sessionsDir: undefined,
  indexPath: undefined,
  pollIntervalMs: 5000,
  maxListResults: 50,
  maxTranscriptChars: 20000,
  maxImportChars: 12000,
  autoImport: {
    enabled: true,
    matchCwd: true,
    maxChars: 6000,
    maxMessages: 40,
  },
  liveSync: {
    enabled: true,
    maxChars: 6000,
  },
  share: {
    enabled: false,
    dir: undefined,
    machineId: undefined,
    label: undefined,
    mirrorCodex: true,
    mirrorDsh: true,
    intervalMs: 30000,
    discoverIntervalMs: 15000,
  },
}

function mergeSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const auto = raw.autoImport && typeof raw.autoImport === 'object' ? raw.autoImport : {}
  const live = raw.liveSync && typeof raw.liveSync === 'object' ? raw.liveSync : {}
  const share = raw.share && typeof raw.share === 'object' ? raw.share : {}
  const machineId = sanitizeMachineId(share.machineId ?? defaultMachineId())
  return {
    ...DEFAULTS,
    ...raw,
    sessionsDir: raw.sessionsDir ?? defaultSessionsDir(),
    indexPath: raw.indexPath ?? defaultIndexPath(),
    autoImport: { ...DEFAULTS.autoImport, ...auto },
    liveSync: { ...DEFAULTS.liveSync, ...live },
    share: {
      ...DEFAULTS.share,
      ...share,
      dir: expandPath(share.dir ?? defaultShareDir()),
      machineId,
      label:
        typeof share.label === 'string' && share.label.trim()
          ? share.label.trim()
          : machineId,
      mirrorCodex: share.mirrorCodex !== false,
      mirrorDsh: share.mirrorDsh !== false,
      intervalMs: Number.isFinite(share.intervalMs) && share.intervalMs > 0 ? share.intervalMs : DEFAULTS.share.intervalMs,
      discoverIntervalMs:
        Number.isFinite(share.discoverIntervalMs) && share.discoverIntervalMs > 0
          ? share.discoverIntervalMs
          : DEFAULTS.share.discoverIntervalMs,
    },
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * Build the message handed to a DSH agent.
 *
 * @param {string} text
 * @returns {object} a user-role message the agent loop accepts
 */
function buildUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

/**
 * @param {object} ctx the plugin context
 * @param {object} settings resolved settings
 * @returns {CodexHistoryStore}
 */
function createStore(ctx, settings) {
  const store = new CodexHistoryStore({
    sessionsDir: settings.sessionsDir,
    indexPath: settings.indexPath,
    pollIntervalMs: settings.pollIntervalMs,
  })
  store.start()
  ctx.effect(() => () => store.stop())
  return store
}

/**
 * Mirror the local conversation logs into the shared folder and pick up the
 * folders the other machines wrote.
 *
 * The mirror only writes inside the folder of this machine, so a sync tool
 * never has to merge two writers. The discovery runs on its own timer: a
 * machine that wakes up finds the other machine's conversations within a few
 * seconds, without a restart.
 *
 * @param {object} ctx the plugin context
 * @param {object} settings resolved settings
 * @param {CodexHistoryStore} store the Codex history store
 * @param {DshHistoryStore} dshStore the shared DSH session store
 */
function setupShare(ctx, settings, store, dshStore) {
  if (!settings.share.enabled) return
  const mirror = new ShareMirror({
    root: settings.share.dir,
    machineId: settings.share.machineId,
    label: settings.share.label,
    codexSessionsDir: settings.share.mirrorCodex ? settings.sessionsDir : '',
    codexIndexPath: settings.share.mirrorCodex ? settings.indexPath : '',
    dshSessionsDir: settings.share.mirrorDsh ? defaultDshSessionsDir() : '',
    intervalMs: settings.share.intervalMs,
  })
  mirror.start()
  ctx.effect(() => () => mirror.stop())

  const refreshSources = async () => {
    try {
      const descriptors = readMachineDescriptors(settings.share.dir)
      const codexSources = discoverCodexSources(settings.share.dir, {
        exclude: settings.share.machineId,
        descriptors,
      })
      const dshSources = discoverDshSources(settings.share.dir, {
        exclude: settings.share.machineId,
        descriptors,
      })
      store.setExtraSources(codexSources)
      dshStore.setSources(dshSources)
      await store.refresh(false)
      await dshStore.refresh(false)
    } catch (error) {
      ctx.logger.warn(`codex-history: 刷新共享目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void refreshSources()
  const timer = setInterval(() => {
    void refreshSources()
  }, settings.share.discoverIntervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer))
  ctx.logger.info(
    `codex-history: 共享目录已启用 ${settings.share.dir}（本机 ${settings.share.label}），与其他机器互看历史。`,
  )
}

/**
 * Remember which Codex session was imported into which DSH session, so later
 * Codex messages can be synced back into the same conversation.
 *
 * @param {Map<string, {sessionId: string, messageCount: number, updatedAt: string}>} tracked
 * @param {object} agent the DSH agent that received the context
 * @param {object} session the Codex session
 */
function trackImport(tracked, agent, session) {
  if (!agent?.id || !session?.id) return
  tracked.set(agent.id, {
    sessionId: session.id,
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
  })
}

/**
 * Push new Codex messages into the DSH conversations that already carry the
 * context of that Codex session.
 *
 * The update is injected rather than followed up, so it never starts a model
 * turn on its own: it is picked up by the next step of the conversation.
 *
 * @param {object} ctx
 * @param {CodexHistoryStore} store
 * @param {Map<string, {sessionId: string, messageCount: number, updatedAt: string}>} tracked
 * @param {object} settings
 */
function registerLiveSync(ctx, store, tracked, settings) {
  if (!settings.liveSync.enabled) return
  const unsubscribe = store.onChange(() => {
    for (const [agentId, entry] of [...tracked.entries()]) {
      try {
        const session = store.getSession(entry.sessionId)
        if (!session) continue
        if (session.messages.length <= entry.messageCount) continue
        const agent = ctx.get('agents')?.get(agentId)
        if (!agent) {
          tracked.delete(agentId)
          continue
        }
        const payload = renderDeltaPayload(session, entry.messageCount, { maxChars: settings.liveSync.maxChars })
        if (!payload) continue
        if (typeof agent.inject === 'function') {
          agent.inject(buildUserMessage(payload))
          entry.messageCount = session.messages.length
          entry.updatedAt = session.updatedAt
          ctx.logger.info(`codex-history: 已把 Codex 会话 ${session.id} 的新增内容同步到 DSH 会话 ${agentId}`)
        }
      } catch (error) {
        ctx.logger.warn(`codex-history: 同步 Codex 新内容失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  ctx.effect(() => () => unsubscribe())
}

/**
 * Register the `codex_history` tool.
 *
 * @param {object} ctx
 * @param {CodexHistoryStore} store
 * @param {object} settings
 */
function registerTool(ctx, store, settings) {
  const definition = {
    name: 'codex_history',
    description:
      'Read the Codex CLI conversation history stored under ~/.codex/sessions ' +
      '(and, when a shared folder is configured, the conversations the other machines shared). ' +
      'Use action=list to see recent Codex sessions, action=read to read one transcript, ' +
      'action=search to search every message, action=latest to find the session that ' +
      'matches the current working directory, and action=worklog to get a work-point digest ' +
      '(requests, deliverables, commands, touched files) for one session or for a time window. ' +
      'The index refreshes automatically, so a Codex conversation started outside DSH can be ' +
      'picked up right away.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'search', 'latest', 'worklog'],
          description: 'list: recent Codex sessions. read: one transcript by id. search: full-text search over all messages. latest: the newest session recorded for a working directory. worklog: work-point digest for one session or for a time window.',
        },
        session_id: {
          type: 'string',
          description: 'Codex session id (action=read, action=worklog).',
        },
        query: {
          type: 'string',
          description: 'Search text (action=search).',
        },
        cwd: {
          type: 'string',
          description: 'Working directory to match (action=latest, optional).',
        },
        since: {
          type: 'string',
          description:
            'Start of the reporting window, ISO 8601 date or date-time (optional). ' +
            'A bare YYYY-MM-DD means the start of that UTC day. Sessions overlapping the window are kept, ' +
            'so work done inside the window is still found in a session that started earlier.',
        },
        until: {
          type: 'string',
          description:
            'End of the reporting window, ISO 8601 date or date-time (optional). ' +
            'A bare YYYY-MM-DD means the end of that UTC day.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = String(args?.action ?? 'list')
      const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20
      const since = typeof args?.since === 'string' && args.since.trim() ? args.since.trim() : undefined
      const until = typeof args?.until === 'string' && args.until.trim() ? args.until.trim() : undefined

      if (action === 'list') {
        const sessions = store.listSummaries({ limit: Math.max(limit, settings.maxListResults), since, until })
        if (sessions.length === 0) {
          return { action, sessions: [], text: `No Codex session found under ${store.sessionsDir}.` }
        }
        const text = [
          `Codex sessions (${sessions.length}), from ${store.sources.map((source) => source.label).join('、') || '本机'}:`,
          ...sessions.map(
            (session) =>
              `- ${session.updatedAt} · ${session.sourceLabel || '本机'} · ${session.messageCount} msgs · ${session.title}${session.cwd ? ` [${session.cwd}]` : ''} · id=${session.id}`,
          ),
        ].join('\n')
        return { action, sessions, text }
      }

      if (action === 'read') {
        const session = store.getSession(String(args?.session_id ?? ''))
        if (!session) return { action, error: 'session not found', text: `No Codex session matched id "${args?.session_id ?? ''}".` }
        const text = `${renderSessionHeader(session)}\n\n${renderTranscript(session, { maxChars: settings.maxTranscriptChars })}`
        return { action, session: { id: session.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt, messageCount: session.messageCount }, text }
      }

      if (action === 'search') {
        const query = String(args?.query ?? '')
        const hits = store.search(query, { limit, since, until })
        if (hits.length === 0) return { action, query, hits: [], text: `No Codex message matched "${query}".` }
        const text = [`Codex messages matching "${query}" (${hits.length}):`, ...hits.map((hit) => `- [${hit.sessionId}] ${hit.role}: ${hit.text.replace(/\s+/gu, ' ').slice(0, 200)}`)].join('\n')
        return { action, query, hits, text }
      }

      if (action === 'worklog') {
        const sessionId = String(args?.session_id ?? '').trim()
        const cwd = String(args?.cwd ?? '').trim()
        const sessions = sessionId
          ? [store.getSession(sessionId)].filter(Boolean)
          : store
              .listSessions({ since, until })
              .filter((session) => !cwd || sameCwd(session.cwd, cwd))
              .slice(0, Math.max(1, Math.min(limit, 10)))
        if (sessions.length === 0) {
          return {
            action,
            sessions: [],
            text: `No Codex session matched session_id="${sessionId}" or the window ${since ?? '(any)'} → ${until ?? '(any)'}.`,
          }
        }
        const text = sessions
          .map((session) => renderWorkLog(session, { maxChars: settings.maxTranscriptChars }))
          .join('\n\n---\n\n')
        const brief = sessions.map((session) => ({
          id: session.id,
          title: session.title,
          cwd: session.cwd,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          toolCallCount: session.toolCallCount ?? 0,
          failedToolCallCount: session.failedToolCallCount ?? 0,
          touchedFiles: session.touchedFiles ?? [],
        }))
        return { action, sessions: brief, text }
      }

      // action === 'latest'
      const cwd = String(args?.cwd ?? '')
      const session = store.findLatestForCwd(cwd, { since, until })
      if (!session) {
        return { action, text: `No Codex session was recorded for working directory "${cwd}".` }
      }
      const text = `${renderSessionHeader(session)}\n\n${renderTranscript(session, { maxChars: settings.maxTranscriptChars })}`
      return { action, session: { id: session.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt }, text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Codex 历史 · ${String(args?.action ?? 'list')}`,
      kind: 'read',
    }),
  }
  ctx.effect(() => ctx.tools.register(definition))
}

/**
 * Register the `dsh_history` tool.
 *
 * It reads the DSH conversations of the *other* machines out of the shared
 * folder, which is the DSH counterpart of `codex_history`.
 *
 * @param {object} ctx
 * @param {DshHistoryStore} dshStore
 * @param {object} settings
 */
function registerDshTool(ctx, dshStore, settings) {
  const definition = {
    name: 'dsh_history',
    description:
      'Read the DSH conversations that the other machines shared through the shared folder. ' +
      'Use action=list to see recent DSH sessions of the other machines, action=read to read one ' +
      'transcript, and action=search to search every message. The shared folder is refreshed ' +
      'automatically, so a conversation that happened on the other machine shows up right away.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'search'],
          description:
            'list: recent DSH sessions of the other machines. read: one transcript by id. search: full-text search over all messages.',
        },
        session_id: {
          type: 'string',
          description: 'DSH session id (action=read).',
        },
        query: {
          type: 'string',
          description: 'Search text (action=search).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = String(args?.action ?? 'list')
      const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20

      if (action === 'list') {
        const sessions = dshStore.listSummaries({ limit: Math.max(limit, settings.maxListResults) })
        if (sessions.length === 0) {
          return {
            action,
            sessions: [],
            text:
              'No DSH session was found in the shared folder. Enable share.enabled and make sure the other machine writes into the same share directory.',
          }
        }
        const text = [
          `DSH sessions shared by the other machines (${sessions.length}):`,
          ...sessions.map(
            (session) =>
              `- ${session.updatedAt} · ${session.sourceLabel || session.sourceId} · ${session.messageCount} msgs · ${session.title}${session.cwd ? ` [${session.cwd}]` : ''} · id=${session.id}`,
          ),
        ].join('\n')
        return { action, sessions, text }
      }

      if (action === 'read') {
        const session = dshStore.getSession(String(args?.session_id ?? ''))
        if (!session) {
          return { action, error: 'session not found', text: `No DSH session matched id "${args?.session_id ?? ''}".` }
        }
        const text = `${renderDshSessionHeader(session)}\n\n${renderDshTranscript(session, { maxChars: settings.maxTranscriptChars })}`
        return {
          action,
          session: {
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            sourceLabel: session.sourceLabel,
          },
          text,
        }
      }

      const query = String(args?.query ?? '')
      const hits = dshStore.search(query, { limit })
      if (hits.length === 0) return { action, query, hits: [], text: `No DSH message matched "${query}".` }
      const text = [
        `DSH messages matching "${query}" (${hits.length}):`,
        ...hits.map(
          (hit) =>
            `- [${hit.sourceLabel || hit.sourceId}] ${hit.role}: ${hit.text.replace(/\s+/gu, ' ').slice(0, 200)}`,
        ),
      ].join('\n')
      return { action, query, hits, text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `DSH 历史 · ${String(args?.action ?? 'list')}`,
      kind: 'read',
    }),
  }
  ctx.effect(() => ctx.tools.register(definition))
}

/**
 * Register the `/dsh` command.
 *
 * @param {object} ctx
 * @param {DshHistoryStore} dshStore
 * @param {object} settings
 */
function registerDshCommand(ctx, dshStore, settings) {
  const definition = {
    name: 'dsh',
    description: '浏览其他机器共享过来的 DSH 会话。',
    input: { hint: '/dsh [list | search <关键词> | <会话 id>]' },
    recordInput: false,
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()

      if (raw === '' || raw === 'list') {
        const sessions = dshStore.listSummaries({ limit: 10 })
        if (sessions.length === 0) {
          return { kind: 'success', text: '共享目录里还没有其他机器的 DSH 会话。' }
        }
        return {
          kind: 'success',
          text: [
            `其他机器共享的 DSH 会话（${sessions.length}）：`,
            ...sessions.map(
              (session) =>
                `- ${session.updatedAt} · ${session.sourceLabel || session.sourceId} · ${session.messageCount} 条 · ${session.title}${session.cwd ? ` [${session.cwd}]` : ''} · id=${session.id}`,
            ),
          ].join('\n'),
        }
      }

      if (raw.startsWith('search ')) {
        const query = raw.slice('search '.length).trim()
        const hits = dshStore.search(query, { limit: 10 })
        if (hits.length === 0) return { kind: 'success', text: `没有匹配的 DSH 消息："${query}"` }
        return {
          kind: 'success',
          text: [
            `匹配 "${query}" 的 DSH 消息（${hits.length}）：`,
            ...hits.map(
              (hit) => `- [${hit.sourceLabel || hit.sourceId}] ${hit.role}: ${hit.text.replace(/\s+/gu, ' ').slice(0, 160)}`,
            ),
          ].join('\n'),
        }
      }

      const session = dshStore.getSession(raw)
      if (!session) {
        return { kind: 'error', text: `找不到 DSH 会话 "${raw}"。先用 /dsh list 查看可用会话。` }
      }
      const text = `${renderDshSessionHeader(session)}\n\n${renderDshTranscript(session, { maxChars: settings.maxImportChars })}`
      return { kind: 'success', text }
    },
  }
  ctx.effect(() => ctx.commands.register(definition))
}

/**
 * Register the `/codex` command.
 *
 * @param {object} ctx
 * @param {CodexHistoryStore} store
 * @param {object} settings
 */
function registerCommand(ctx, store, settings, tracked) {
  const definition = {
    name: 'codex',
    description: '浏览本地 Codex 历史会话，或把某个 Codex 会话导入当前对话继续工作。',
    input: { hint: '/codex [list | search <关键词> | worklog [起始日期] [结束日期] | <会话 id>]' },
    recordInput: false,
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      const agent = invocation.agent

      if (!store.available) {
        return { kind: 'error', text: `无法读取 Codex 历史目录 ${store.sessionsDir}：${store.lastError || '目录不存在'}` }
      }

      if (raw === '' || raw === 'list') {
        const sessions = store.listSummaries({ limit: 10 })
        if (sessions.length === 0) {
          return { kind: 'success', text: `没有在 ${store.sessionsDir} 找到 Codex 会话。` }
        }
        return {
          kind: 'success',
          text: [
            `最近的 Codex 会话（${sessions.length}）：`,
            ...sessions.map((session) => renderSessionLine(session)),
            '',
            '用 /codex <会话 id> 把某个会话导入当前对话。',
          ].join('\n'),
        }
      }

      if (raw.startsWith('search ')) {
        const query = raw.slice('search '.length).trim()
        const hits = store.search(query, { limit: 10 })
        if (hits.length === 0) return { kind: 'success', text: `没有匹配的 Codex 消息："${query}"` }
        return {
          kind: 'success',
          text: [`匹配 "${query}" 的 Codex 消息（${hits.length}）：`, ...hits.map((hit) => `- [${hit.sessionId}] ${hit.role}: ${hit.text.replace(/\s+/gu, ' ').slice(0, 160)}`)].join('\n'),
        }
      }

      if (raw.startsWith('worklog')) {
        const parts = raw.split(/\s+/u).filter(Boolean).slice(1)
        const since = parts[0] ?? undefined
        const until = parts[1] ?? undefined
        const sessions = store.listSessions({ since, until }).slice(0, 10)
        if (sessions.length === 0) {
          return { kind: 'success', text: `没有在 ${since ?? '全部时间'} → ${until ?? '现在'} 期间找到 Codex 会话。` }
        }
        const text = sessions
          .map((session) => renderWorkLog(session, { maxChars: settings.maxTranscriptChars }))
          .join('\n\n---\n\n')
        return { kind: 'success', text }
      }

      const [id, tail] = raw.split(/\s+/u, 2)
      const session = store.getSession(id)
      if (!session) {
        return { kind: 'error', text: `找不到 Codex 会话 "${id}"。先用 /codex list 查看可用会话。` }
      }
      const messageCount = Number.parseInt(tail ?? '', 10)
      const limit = Number.isSafeInteger(messageCount) && messageCount > 0 ? messageCount : session.messages.length
      const payload = renderImportPayload(session, { maxChars: settings.maxImportChars })
      const text = `${renderSessionHeader(session)}\n\n${renderTranscript(session, { limit, maxChars: settings.maxImportChars })}`

      if (agent && typeof agent.followup === 'function') {
        agent.followup(buildUserMessage(payload))
        trackImport(tracked, agent, session)
        return { kind: 'success', text: `已把 Codex 会话 ${session.id} 导入当前对话（${limit} 条消息）。` }
      }
      return { kind: 'success', text }
    },
  }
  ctx.effect(() => ctx.commands.register(definition))
}

/**
 * Register the HTTP routes used by the Web UI.
 *
 * @param {object} ctx
 * @param {CodexHistoryStore} store
 * @param {object} settings
 */
function registerRoutes(ctx, store, settings, tracked, dshStore) {
  const authenticate = (request, response) => {
    try {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection !== 'function') return true
      const rejection = connection.requestRejection(request)
      if (rejection === undefined) return true
      sendJson(response, rejection, { error: rejection === 401 ? '请先登录 DSH。' : '已拒绝不可信或跨站请求。' })
      return false
    } catch (error) {
      ctx.logger.warn(`codex-history: 认证检查失败：${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: async (request, response) => {
        if (!authenticate(request, response)) return
        const url = new URL(request.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(API_BASE.length).replace(/^\/+/u, '') || 'sessions'

        if (request.method === 'GET' && route === 'status') {
          sendJson(response, 200, {
            ok: true,
            version: VERSION,
            available: store.available,
            sessionsDir: store.sessionsDir,
            sessionCount: store.listSessions().length,
            lastError: store.lastError,
            autoImport: settings.autoImport.enabled,
            liveSync: settings.liveSync.enabled,
            share: {
              enabled: settings.share.enabled,
              dir: settings.share.dir,
              machineId: settings.share.machineId,
              label: settings.share.label,
              sources: store.sources.map((source) => ({
                id: source.id,
                label: source.label,
                sessionsDir: source.sessionsDir,
                isLocal: source.id === store.localSourceId,
              })),
              dshSessions: dshStore.listSummaries({ limit: 200 }).length,
            },
          })
          return
        }

        if (request.method === 'GET' && (route === 'sessions' || route === '')) {
          const sessions = store.listSummaries({
            query: url.searchParams.get('query') ?? '',
            cwd: url.searchParams.get('cwd') ?? '',
            since: url.searchParams.get('since') ?? '',
            until: url.searchParams.get('until') ?? '',
            limit: Number.parseInt(url.searchParams.get('limit') ?? '', 10) || settings.maxListResults,
          })
          sendJson(response, 200, { ok: true, available: store.available, sessionsDir: store.sessionsDir, sessions })
          return
        }

        if (request.method === 'GET' && route === 'worklog') {
          const id = url.searchParams.get('id') ?? ''
          const cwd = url.searchParams.get('cwd') ?? ''
          const since = url.searchParams.get('since') ?? ''
          const until = url.searchParams.get('until') ?? ''
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10) || 10
          const sessions = id
            ? [store.getSession(id)].filter(Boolean)
            : store
                .listSessions({ since, until })
                .filter((session) => !cwd || sameCwd(session.cwd, cwd))
                .slice(0, Math.max(1, Math.min(limit, 10)))
          if (sessions.length === 0) {
            sendJson(response, 404, { ok: false, error: 'session not found' })
            return
          }
          const text = sessions
            .map((session) => renderWorkLog(session, { maxChars: settings.maxTranscriptChars }))
            .join('\n\n---\n\n')
          sendJson(response, 200, {
            ok: true,
            text,
            sessions: sessions.map((session) => ({
              id: session.id,
              title: session.title,
              cwd: session.cwd,
              updatedAt: session.updatedAt,
              toolCallCount: session.toolCallCount ?? 0,
              failedToolCallCount: session.failedToolCallCount ?? 0,
            })),
          })
          return
        }

        if (request.method === 'GET' && route === 'session') {
          const session = store.getSession(url.searchParams.get('id') ?? '')
          if (!session) {
            sendJson(response, 404, { ok: false, error: 'session not found' })
            return
          }
          sendJson(response, 200, {
            ok: true,
            session: {
              id: session.id,
              title: session.title,
              cwd: session.cwd,
              updatedAt: session.updatedAt,
              startedAt: session.startedAt,
              messageCount: session.messageCount,
              filePath: session.filePath,
              messages: session.messages,
            },
          })
          return
        }

        if (request.method === 'POST' && route === 'import') {
          const body = await readJsonBody(request)
          const session = store.getSession(String(body?.id ?? ''))
          if (!session) {
            sendJson(response, 404, { ok: false, error: 'session not found' })
            return
          }
          const targetSessionId = String(body?.targetSessionId ?? '')
          const agent = targetSessionId ? ctx.get('agents')?.get(targetSessionId) : undefined
          if (!agent) {
            sendJson(response, 409, { ok: false, error: 'target session has no live agent' })
            return
          }
          const payload = renderImportPayload(session, { maxChars: settings.maxImportChars })
          const message = buildUserMessage(payload)
          if (typeof agent.followup === 'function') agent.followup(message)
          else if (typeof agent.inject === 'function') agent.inject(message)
          else {
            sendJson(response, 500, { ok: false, error: 'agent cannot accept injected context' })
            return
          }
          trackImport(tracked, agent, session)
          sendJson(response, 200, { ok: true, imported: true, sessionId: session.id, targetSessionId })
          return
        }

        if (request.method === 'GET' && route === 'dsh-sessions') {
          const sessions = dshStore.listSummaries({
            query: url.searchParams.get('query') ?? '',
            cwd: url.searchParams.get('cwd') ?? '',
            limit: Number.parseInt(url.searchParams.get('limit') ?? '', 10) || settings.maxListResults,
          })
          sendJson(response, 200, { ok: true, available: dshStore.available, sessions })
          return
        }

        if (request.method === 'GET' && route === 'dsh-session') {
          const session = dshStore.getSession(url.searchParams.get('id') ?? '')
          if (!session) {
            sendJson(response, 404, { ok: false, error: 'session not found' })
            return
          }
          sendJson(response, 200, {
            ok: true,
            session: {
              id: session.id,
              title: session.title,
              cwd: session.cwd,
              updatedAt: session.updatedAt,
              startedAt: session.startedAt,
              messageCount: session.messageCount,
              sourceId: session.sourceId,
              sourceLabel: session.sourceLabel,
              filePath: session.filePath,
              messages: session.messages,
            },
          })
          return
        }

        sendJson(response, 404, { ok: false, error: 'unknown route' })
      },
    }),
  )
}

/**
 * Teach every new agent about the Codex history, and optionally import the
 * matching Codex session into a fresh session.
 *
 * @param {object} ctx
 * @param {CodexHistoryStore} store
 * @param {object} settings
 */
function registerAgentHook(ctx, store, settings, tracked) {
  ctx.on('agent/created', ({ agent }) => {
    if (!agent || !agent.ctx) return
    try {
      agent.ctx.systemPrompt.section({
        name: 'codex-history',
        order: agent.ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
        text: () =>
          'Codex 历史：本地 Codex CLI 的会话记录会被自动读取（~/.codex/sessions）' +
          (settings.share.enabled
            ? `，共享目录 ${settings.share.dir} 里其他机器的会话也会一起读进来（列表里会标出来源机器）`
            : '') +
          '。当用户提到之前在 Codex 里做过的事、某个历史会话，或需要接着 Codex 的工作继续时，' +
          '用 codex_history 工具查找并读取对应会话；不要凭空猜测 Codex 会话的内容。' +
          (settings.share.enabled
            ? '其他机器上的 DSH 对话用 dsh_history 工具读取。'
            : ''),
      })
    } catch (error) {
      ctx.logger.warn(`codex-history: 注册系统提示词片段失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!settings.autoImport.enabled) return
    try {
      const agents = ctx.get('agents')
      const roots = agents?.roots?.() ?? []
      if (!roots.some((root) => root.id === agent.id)) return
      const cwd = agent.session?.header?.cwd ?? ''
      if (!cwd || !settings.autoImport.matchCwd) return
      const session = store.findLatestForCwd(cwd)
      if (!session) return
      const limited = {
        ...session,
        messages: session.messages.slice(-settings.autoImport.maxMessages),
      }
      const text = renderImportPayload(limited, { maxChars: settings.autoImport.maxChars })
      if (typeof agent.inject === 'function') {
        agent.inject(buildUserMessage(text))
        trackImport(tracked, agent, { ...limited, messages: session.messages })
        ctx.logger.info(`codex-history: 已为工作目录 ${cwd} 导入 Codex 会话 ${session.id}`)
      }
    } catch (error) {
      ctx.logger.warn(`codex-history: 自动导入 Codex 上下文失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * Plugin entry point.
 *
 * @param {object} ctx the plugin context
 * @param {object} [config] plugin configuration
 */
export function apply(ctx, config) {
  const settings = mergeSettings(config)
  const store = createStore(ctx, settings)
  const dshStore = new DshHistoryStore({ pollIntervalMs: 20000 })
  dshStore.start()
  ctx.effect(() => () => dshStore.stop())
  /** @type {Map<string, {sessionId: string, messageCount: number, updatedAt: string}>} */
  const tracked = new Map()
  registerTool(ctx, store, settings)
  registerCommand(ctx, store, settings, tracked)
  registerDshTool(ctx, dshStore, settings)
  registerDshCommand(ctx, dshStore, settings)
  registerRoutes(ctx, store, settings, tracked, dshStore)
  registerAgentHook(ctx, store, settings, tracked)
  registerLiveSync(ctx, store, tracked, settings)
  setupShare(ctx, settings, store, dshStore)
  ctx.logger.info(`codex-history: 已启用，监听 ${settings.sessionsDir}`)
}

export const inject = ['tools', 'commands', 'agents', 'webServer']

export const name = 'codex-history'
