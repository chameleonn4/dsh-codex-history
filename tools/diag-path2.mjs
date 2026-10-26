const response = await fetch('http://127.0.0.1:54947/api/codex-history/status')
const status = await response.json()
const dir = status.sessionsDir
console.log('raw:', JSON.stringify(dir))
console.log('codes:', [...dir].map((c) => c.codePointAt(0)).join(','))
console.log('exists:', await import('node:fs').then((fs) => {
  try { return fs.readdirSync(dir).join(',') } catch (e) { return 'ERR ' + e.code }
}))
