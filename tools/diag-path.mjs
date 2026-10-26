import fs from 'node:fs'
import path from 'node:path'
import { CodexHistoryStore } from '../lib/store.js'
import { isRolloutFile, parseRolloutFile } from '../lib/parse.js'

const dir = 'D:\\DSH插件构建\\读取Codex本地记录\\demo-sessions'

function walk(current, depth = 0, out = []) {
  if (depth > 6) return out
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1, out)
    else if (entry.isFile() && isRolloutFile(full)) out.push(full)
  }
  return out
}

const found = walk(dir)
console.log('walk found', found.length)
for (const file of found) {
  const parsed = parseRolloutFile(file)
  console.log(' ', path.basename(file), '→', parsed ? parsed.id : 'PARSE FAILED')
}

const store = new CodexHistoryStore({ sessionsDir: dir, indexPath: path.join(dir, 'session_index.jsonl') })
await store.refresh(true)
console.log('store files:', store.files.size, 'available:', store.available, 'lastError:', store.lastError)
console.log('summaries:', store.listSummaries({}).map((s) => s.title))
