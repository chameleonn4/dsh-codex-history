/**
 * Publish this plugin to a GitHub repository through the GitHub REST API.
 *
 * The API is used instead of `git push` because it needs only api.github.com
 * (plain git over https requires github.com, which is often blocked on campus
 * or corporate networks).
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node tools/publish-github.mjs [--repo owner/name] [--message "..."] [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is not set.')
  process.exit(1)
}

const repo = option('repo', 'chameleonn4/dsh-codex-history')
const [owner, name] = repo.split('/')
const message = option('message', 'chore: publish dsh-codex-history')
const dryRun = flag('dry-run')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const IGNORED_DIRS = new Set(['node_modules', '.git', '.extract', 'CodexShare', '.vscode', '.idea'])
const IGNORED_FILES = /^(tmp_.*\.mjs|tmp_probe.*\.json|.*\.log)$/u

const collect = (dir, prefix = '') => {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      files.push(...collect(path.join(dir, entry.name), `${prefix}${entry.name}/`))
      continue
    }
    if (!entry.isFile()) continue
    if (IGNORED_FILES.test(entry.name)) continue
    files.push({ path: `${prefix}${entry.name}`, absolute: path.join(dir, entry.name) })
  }
  return files
}

const files = collect(root)
if (dryRun) {
  console.log(files.map((file) => file.path).join('\n'))
  process.exit(0)
}

const api = async (method, endpoint, body) => {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-codex-history-publisher',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} → ${response.status} ${payload.message ?? text}`)
  }
  return payload
}

let repoInfo
try {
  repoInfo = await api('GET', `/repos/${owner}/${name}`)
} catch (error) {
  if (!/→ 404/u.test(String(error))) throw error
  console.log(`repository ${repo} does not exist yet — creating it`)
  repoInfo = await api('POST', '/user/repos', {
    name,
    description: option('description', 'DSH 插件：自动读取本地 Codex 会话历史，让 DeepSeek Harness 与 Codex 无缝衔接'),
    private: flag('private'),
    auto_init: true,
  })
}
console.log(`repository: ${repoInfo.full_name} (${repoInfo.private ? 'private' : 'public'})`)

const head = await api('GET', `/repos/${owner}/${name}/commits/${repoInfo.default_branch}`)
const baseTree = head.commit.tree.sha

const blobs = []
for (const file of files) {
  const content = fs.readFileSync(file.absolute).toString('base64')
  const blob = await api('POST', `/repos/${owner}/${name}/git/blobs`, { content, encoding: 'base64' })
  blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`blob ${file.path} ${blob.sha.slice(0, 7)}`)
}

const tree = await api('POST', `/repos/${owner}/${name}/git/trees`, {
  base_tree: baseTree,
  tree: blobs,
})
console.log(`tree ${tree.sha.slice(0, 7)} (${blobs.length} files)`)

const commit = await api('POST', `/repos/${owner}/${name}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [head.sha],
})
console.log(`commit ${commit.sha}`)

const ref = await api('PATCH', `/repos/${owner}/${name}/git/refs/heads/${repoInfo.default_branch}`, {
  sha: commit.sha,
  force: false,
})
console.log(`ref ${ref.ref} → ${ref.object.sha}`)
console.log(`https://github.com/${owner}/${name}`)
