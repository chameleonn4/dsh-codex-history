/**
 * Build the npm-style release tarball and publish it as a GitHub release asset.
 *
 *   node tools/build-release.mjs --version 1.3.1
 *
 * The tarball keeps the npm convention (everything under `package/`) so that the
 * plugin market can install it with `pnpm add <tarball>` and the DSH Plugin
 * Manager can install it from the release URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const token = process.env.GITHUB_TOKEN ?? ''
if (!token) {
  console.error('GITHUB_TOKEN is not set.')
  process.exit(1)
}
const repo = option('repo', 'chameleonn4/dsh-codex-history')
const [owner, name] = repo.split('/')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = option('version', manifest.version)
const tag = option('tag', `v${version}`)
const dryRun = flag('dry-run')

const RUNTIME_ENTRIES = [
  'index.js',
  'lib',
  'client',
  'locale',
  'assets',
  'cordis.patch.yml',
  'icon.svg',
  'package.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'screenshots.json',
]

const stage = path.join(root, '.release')
fs.rmSync(stage, { recursive: true, force: true })
const pkgDir = path.join(stage, 'package')
fs.mkdirSync(pkgDir, { recursive: true })
for (const entry of RUNTIME_ENTRIES) {
  const source = path.join(root, entry)
  if (!fs.existsSync(source)) {
    console.warn(`skip missing ${entry}`)
    continue
  }
  fs.cpSync(source, path.join(pkgDir, entry), {
    recursive: true,
    // raw-*.png are un-cropped screenshots of the operator's machine — never ship them.
    filter: (from) => !/^raw-.*\.png$/u.test(path.basename(from)),
  })
}
const stagedManifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
stagedManifest.version = version
fs.writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)

const tarName = `dsh-codex-history-v${version}.tgz`
// Windows' bsdtar treats "D:\..." as a remote host spec, so run it inside the
// staging directory with relative paths only.
execFileSync('tar', ['-czf', tarName, 'package'], { cwd: stage, stdio: 'inherit' })
const tarPath = path.join(stage, tarName)
console.log(`built ${tarName} (${fs.statSync(tarPath).size} bytes)`)
if (dryRun) process.exit(0)

const api = async (method, endpoint, body, extraHeaders = {}) => {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-codex-history-publisher',
      ...extraHeaders,
    },
    body,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`${method} ${endpoint} → ${response.status} ${payload.message ?? text}`)
  return payload
}

let release
try {
  release = await api('GET', `/repos/${owner}/${name}/releases/tags/${tag}`)
} catch (error) {
  if (!/→ 404/u.test(String(error))) throw error
  release = await api('POST', `/repos/${owner}/${name}/releases`, JSON.stringify({
    tag_name: tag,
    name: tag,
    body: `dsh-codex-history ${version}\n\n安装：DSH 里说一句「帮我安装 dsh-codex-history 插件，地址是 github:${owner}/${name}」。`,
  }))
  console.log(`created release ${tag} (${release.id})`)
}

const assets = release.assets ?? []
for (const asset of assets) {
  if (asset.name === tarName) await api('DELETE', `/repos/${owner}/${name}/releases/assets/${asset.id}`)
}
// Release assets must be uploaded to uploads.github.com — api.github.com answers 404 for binary POSTs.
const uploaded = await (async () => {
  const response = await fetch(`https://uploads.github.com/repos/${owner}/${name}/releases/${release.id}/assets?name=${encodeURIComponent(tarName)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-codex-history-publisher',
      'content-type': 'application/gzip',
    },
    body: fs.readFileSync(tarPath),
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`POST uploads → ${response.status} ${payload.message ?? text}`)
  return payload
})()
console.log(`uploaded ${uploaded.name} → ${uploaded.browser_download_url}`)
