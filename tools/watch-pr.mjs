// Watch the marketplace listing PR until the gate reports a verdict.
// Usage: node tools/watch-pr.mjs <pr-number> [timeoutMinutes]
const PR = Number(process.argv[2] || 9052)
const LIMIT_MIN = Number(process.argv[3] || 20)
const TOKEN = process.env.GITHUB_TOKEN
const OWNER = 'awesome-dsh-plugin'
const REPO = 'awesome-dsh-plugin'

const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-codex-history-watch',
    },
  })
  if (!response.ok) throw new Error(`${path} → ${response.status}`)
  return response.json()
}

const deadline = Date.now() + LIMIT_MIN * 60_000
let last = ''
while (Date.now() < deadline) {
  const pr = await api(`/repos/${OWNER}/${REPO}/pulls/${PR}`)
  const head = pr.head.sha
  const checks = await api(`/repos/${OWNER}/${REPO}/commits/${head}/check-runs`)
  const line = checks.check_runs
    .map((r) => `${r.name}=${r.conclusion || r.status}`)
    .join(' | ')
  const snapshot = `${pr.state}/${pr.merged ? 'MERGED' : 'open'} :: ${line}`
  if (snapshot !== last) {
    console.log(new Date().toISOString(), snapshot)
    last = snapshot
  }
  const gate = checks.check_runs.find((r) => r.name === 'Submission gate')
  if (pr.merged || (gate && gate.conclusion && gate.conclusion !== 'failure')) {
    console.log('FINAL', JSON.stringify({ state: pr.state, merged: pr.merged, checks: line }))
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000))
}
console.log('TIMEOUT', last)
process.exit(2)
