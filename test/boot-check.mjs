/**
 * Dev check: fetch the Web boot graph and the plugin's client bundle.
 *
 * Usage: node test/boot-check.mjs [baseUrl]
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

const call = async (target) => {
  const response = await fetch(new URL(target, baseUrl), { headers: { cookie } })
  return { status: response.status, body: await response.text() }
}

const home = await call('/')
console.log('GET / →', home.status, home.body.length, 'bytes')

const specs = [...home.body.matchAll(/plugins\/\?\?[^"'<>\s]+/gu)].map((m) => m[0])
const unique = [...new Set(specs)]
console.log('\nplugin client groups in the boot graph:')
for (const spec of unique) {
  const names = spec.replace(/^plugins\/\?\?/u, '').replace(/&rev=.*$/u, '').split(',')
  console.log(`  ${names.join(', ')}`)
}

console.log('\nfetching the codex-history client bundle:')
for (const spec of unique) {
  if (!spec.includes('codex-history')) continue
  const response = await call(spec)
  const first = response.body.split('\n').find((line) => line.includes('__ModuleLoader__')) ?? ''
  console.log(`  ${spec}\n    → ${response.status}, ${response.body.length} bytes`)
  console.log(`    ${first.trim().slice(0, 160)}`)
}
