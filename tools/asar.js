#!/usr/bin/env node
// Minimal read-only Electron .asar reader (no deps).
// Usage:
//   node tools/asar.js list <asarPath> [prefix]
//   node tools/asar.js cat <asarPath> <innerPath>
import fs from 'node:fs'
import path from 'node:path'

function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const pickleSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(pickleSize)
  fs.readSync(fd, headerBuf, 0, pickleSize, 8)
  const stringLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.slice(8, 8 + stringLen).toString('utf8'))
  const dataStart = 8 + pickleSize
  return { fd, header, dataStart }
}

function walk(node, prefix = '') {
  const out = []
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) out.push(...walk(child, p))
    else out.push(p)
  }
  return out
}

function findNode(root, innerPath) {
  let node = root
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = node.files?.[part]
    if (!node) return null
  }
  return node
}

const [cmd, asarPath, ...rest] = process.argv.slice(2)
const { fd, header, dataStart } = openAsar(asarPath)

if (cmd === 'list') {
  const prefix = rest[0] ?? ''
  for (const p of walk(header).filter((p) => p.startsWith(prefix))) console.log(p)
} else if (cmd === 'cat') {
  const node = findNode(header, rest[0])
  if (!node) { console.error('not found:', rest[0]); process.exit(1) }
  const buf = Buffer.alloc(Number(node.size))
  fs.readSync(fd, buf, 0, Number(node.size), dataStart + Number(node.offset))
  process.stdout.write(buf)
} else {
  console.error('usage: asar.js list|cat <asar> [path]')
  process.exit(2)
}
fs.closeSync(fd)
