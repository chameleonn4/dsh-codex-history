/**
 * Host-side smoke test: index the real ~/.codex/sessions and print what the
 * tool and the command would see.
 */
import { CodexHistoryStore } from '../lib/store.js'
import { renderImportPayload, renderSessionHeader, renderTranscript } from '../lib/format.js'

const store = new CodexHistoryStore({ pollIntervalMs: 0 })
await store.refresh(true)

console.log('sessionsDir :', store.sessionsDir)
console.log('available   :', store.available, store.lastError)
console.log('sessions    :', store.listSessions().length)

const summaries = store.listSummaries({ limit: 5 })
for (const summary of summaries) {
  console.log('-', summary.updatedAt, '|', summary.messageCount, 'msgs |', summary.title, '|', summary.cwd, '|', summary.id)
}

const first = summaries[0]
if (first) {
  const session = store.getSession(first.id)
  console.log('\n=== header ===')
  console.log(renderSessionHeader(session))
  console.log('\n=== transcript (first 1500 chars) ===')
  console.log(renderTranscript(session, { maxChars: 1500 }))
  console.log('\n=== import payload (first 800 chars) ===')
  console.log(renderImportPayload(session, { maxChars: 800 }).slice(0, 800))
}

const hits = store.search('cordis', { limit: 3 })
console.log('\n=== search "cordis" ===')
for (const hit of hits) console.log('-', hit.sessionId.slice(0, 8), hit.role, hit.text.replace(/\s+/gu, ' ').slice(0, 120))
