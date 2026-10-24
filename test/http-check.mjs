/**
 * Local verification helper: mint the DSH browser-session cookie from the
 * stored signing secret and call the plugin's HTTP routes.
 *
 * Usage: node test/http-check.mjs [baseUrl]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:58483'
const credentialsPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')

const text = fs.readFileSync(credentialsPath, 'utf8')
const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(text)
if (!match) throw new Error('browser-session secret not found')
const secret = Buffer.from(match[1].replace(/-/gu, '+').replace(/_/gu, '/'), 'base64')

const authority = new URL(baseUrl).host
const cookieName = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 29 * 24 * 60 * 60 * 1000 }
const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
const signature = createHmac('sha256', secret).update(body).digest('base64url')
const cookie = `${cookieName}=v1.${body}.${signature}`

const call = async (routePath, init = {}) => {
  const response = await fetch(new URL(routePath, baseUrl), {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  return { status: response.status, body: text }
}

const status = await call('/api/codex-history/status')
console.log('\nGET /api/codex-history/status →', status.status)
console.log(status.body)

const sessions = await call('/api/codex-history/sessions?limit=5')
console.log('GET /api/codex-history/sessions →', sessions.status)
console.log(sessions.body.slice(0, 1200))

const id = /"id":"([^"]+)"/u.exec(sessions.body)?.[1]
if (id) {
  const one = await call(`/api/codex-history/session?id=${encodeURIComponent(id)}`)
  console.log('\nGET /api/codex-history/session →', one.status, `(${one.body.length} bytes)`)
  console.log(one.body.slice(0, 400))

  const worklog = await call(`/api/codex-history/worklog?id=${encodeURIComponent(id)}`)
  console.log('\nGET /api/codex-history/worklog →', worklog.status, `(${worklog.body.length} bytes)`)
  console.log(worklog.body.slice(0, 900))
}

const windowed = await call('/api/codex-history/sessions?since=2026-10-22&until=2026-10-22')
console.log('\nGET /api/codex-history/sessions?since=2026-10-22&until=2026-10-22 →', windowed.status)
console.log(windowed.body.slice(0, 300))
