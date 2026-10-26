/**
 * Capture a real screenshot of the plugin's composer-dock panel from the
 * running DSH web UI, using a throwaway headless Edge profile.
 *
 * Usage: node tools/shoot-panel.mjs <baseUrl> [outFile]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:54947'
const outFile = process.argv[3] ?? path.join(process.cwd(), 'assets', 'raw-panel.png')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DEBUG_PORT = 9333
const profileDir = path.join(os.tmpdir(), 'dsh-shot-profile')

// 1. mint the browser-session cookie
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
const cookieValue = `v1.${body}.${signature}`

fs.rmSync(profileDir, { recursive: true, force: true })
fs.mkdirSync(profileDir, { recursive: true })

// 2. launch headless Edge with CDP
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (response.ok) return response.json()
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP did not come up')
}

const cdpVersion = await waitForCdp()
console.log('edge:', cdpVersion['Browser'])

const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
const target = await created.json()
console.log('target:', target.id)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId += 1
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) return `EXCEPTION: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`
  return result.result.value
}

await send('Page.enable')
await send('Network.enable')
await send('Runtime.enable')
await send('Network.setCookie', { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' })

console.log('navigating…')
await send('Page.navigate', { url: baseUrl })
await sleep(9000)

console.log('boot graph:', await evaluate(`(() => {
  const boot = window.__DSH_BOOT__;
  if (!boot) return 'no boot';
  const keys = Object.keys(boot);
  const mine = keys.filter((k) => k.includes('codex'));
  return JSON.stringify({ keys: keys.length, mine, entries: JSON.stringify(boot.entries ?? {}).slice(0, 400) });
})()`))

console.log('links:', await evaluate(`(() => {
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).slice(0, 12);
  return JSON.stringify(links);
})()`))

console.log('probe home:', await evaluate(`(() => {
  const pill = document.querySelector('.codex-history-pill');
  return JSON.stringify({ hasPill: !!pill, dock: !!document.querySelector('[class*="composer"]'), href: location.href });
})()`))

// enter a clean, empty conversation so the card image carries no private text
console.log('open session:', await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('div,span,a,button')].filter((el) => (el.textContent || '').trim() === '新建任务');
  if (nodes.length === 0) return 'no-new-task';
  const node = nodes[nodes.length - 1];
  node.click();
  return 'clicked-new-task';
})()`))
await sleep(6000)

console.log('probe conversation:', await evaluate(`(() => {
  const pill = document.querySelector('.codex-history-pill');
  return JSON.stringify({ hasPill: !!pill, pillText: pill && pill.textContent, href: location.href });
})()`))

if (!(await evaluate(`!!document.querySelector('.codex-history-pill')`))) {
  console.log('try clicking a sidebar session title…')
  await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 3);
    const item = nodes.find((el) => el.textContent.includes('文档'));
    if (item) { item.click(); return item.textContent.trim(); }
    return 'none';
  })()`)
  await sleep(4000)
}

console.log('open panel:', await evaluate(`(() => {
  const p = document.querySelector('.codex-history-pill');
  if (!p) return 'no-pill';
  p.click();
  return 'clicked';
})()`))
await sleep(3000)

const rect = await evaluate(`(() => {
  const el = document.querySelector('.codex-history-pill')?.closest('div');
  const panel = [...document.querySelectorAll('div')].find((d) => d.className && String(d.className).includes('codex-history'));
  const r = (panel ?? el)?.getBoundingClientRect();
  return JSON.stringify({ rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, body: document.body.innerText.slice(0, 200) });
})()`)
console.log('rect:', rect)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
console.log('saved', outFile, fs.statSync(outFile).size, 'bytes')

// second card image: the worklog popup of the first session
console.log('open worklog:', await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const target = buttons.find((b) => (b.textContent || '').trim() === '工作要点');
  if (!target) return 'no-worklog-button';
  target.click();
  return 'clicked';
})()`))
await sleep(2500)
const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const out2 = outFile.replace(/raw-panel\.png$/u, 'raw-worklog.png')
fs.writeFileSync(out2, Buffer.from(shot2.data, 'base64'))
console.log('saved', out2, fs.statSync(out2).size, 'bytes')

ws.close()
edge.kill()
process.exit(0)
