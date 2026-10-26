import fs from 'node:fs'
import path from 'node:path'
import { CodexHistoryStore } from '../lib/store.js'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:54947'
const os = await import('node:os')
const { createHash, createHmac } = await import('node:crypto')
const credentialsPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const credentialsText = fs.readFileSync(credentialsPath, 'utf8')
const secretMatch = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(credentialsText)
const secret = Buffer.from(secretMatch[1].replace(/-/gu, '+').replace(/_/gu, '/'), 'base64')
const authority = new URL(baseUrl).host
const cookieName = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 29 * 24 * 60 * 60 * 1000 }
const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
const signature = createHmac('sha256', secret).update(body).digest('base64url')
const cookie = `${cookieName}=v1.${body}.${signature}`

const response = await fetch(new URL('/api/codex-history/status', baseUrl), { headers: { cookie } })
const status = await response.json()
const dir = status.sessionsDir
console.log('host path codes:', [...dir].map((c) => c.codePointAt(0)).join(','))
console.log('host path json :', JSON.stringify(dir))

try {
  console.log('readdir:', fs.readdirSync(dir).join(','))
} catch (error) {
  console.log('readdir ERROR', error.code, error.message)
}

const store = new CodexHistoryStore({ sessionsDir: dir, indexPath: path.join(dir, 'session_index.jsonl') })
await store.refresh(true)
console.log('files:', store.files.size, 'available:', store.available, 'lastError:', store.lastError)
