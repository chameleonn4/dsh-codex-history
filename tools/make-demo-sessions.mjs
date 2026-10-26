/**
 * Generate synthetic Codex rollout files for the marketplace screenshot.
 * The real ~/.codex/sessions content is private, so the card image is taken
 * against this demo directory instead.
 *
 * Usage: node tools/make-demo-sessions.mjs [outDir]
 */
import fs from 'node:fs'
import path from 'node:path'

const outDir = process.argv[2] ?? path.join(process.cwd(), 'demo-sessions')
fs.rmSync(outDir, { recursive: true, force: true })

const uuid = (n) => `${n.toString(16).padStart(12, '0')}-0000-4000-8000-000000000000`

const scenarios = [
  {
    id: '01a00001-8b79-7160-aca7-98c81467e7d4',
    day: '2026/10/24',
    stamp: '2026-10-24T09:12:03.412Z',
    cwd: 'D:\\workspace\\cli-toolkit',
    title: '为 CLI 增加 --json 输出开关',
    turns: [
      ['user', '给 cli-toolkit 加一个 --json 全局开关，让所有子命令都能输出机器可读的结果，不要影响现有的文本输出。'],
      ['assistant', '我先看一下现有的输出层是怎么做的，再决定在哪里统一拦截。'],
      ['tool', { name: 'exec', input: 'rg -n "format|output|print" src --type ts | head -40' }],
      ['assistant', '输出逻辑集中在 src/cli/print.ts，我在那里加一个全局的输出模式，文本输出保持原样。'],
      ['tool', { name: 'apply_patch', input: '*** Update File: src/cli/print.ts\n@@\n+export function emit(data: unknown, mode: OutputMode) {' }],
      ['assistant', '已经加上 --json 开关，cli-toolkit --json build 现在会输出结构化结果，文本输出没有任何变化。'],
    ],
  },
  {
    id: '01a00002-f085-7241-8949-d72f5f5d4891',
    day: '2026/10/25',
    stamp: '2026-10-25T14:03:44.901Z',
    cwd: 'D:\\workspace\\build-scripts',
    title: '修复打包脚本在 Windows 上的路径解析问题',
    turns: [
      ['user', '打包脚本在 Windows 上跑会拼出 D:\\workspace\\build-scripts/dist\\..\\dist 这样的路径，帮我修一下。'],
      ['assistant', '是 path.join 之后又手动拼了一次分隔符，我看看这段代码。'],
      ['tool', { name: 'exec', input: 'cat scripts/build.mjs | head -60' }],
      ['tool', { name: 'exec', input: 'node scripts/build.mjs --dry-run' }],
      ['assistant', '把两次路径拼接合并成一次 path.resolve，打包产物目录恢复正常。'],
    ],
  },
  {
    id: '01a00003-1234-4abc-8def-0123456789ab',
    day: '2026/10/26',
    stamp: '2026-10-26T02:41:18.207Z',
    cwd: 'D:\\workspace\\deploy-docs',
    title: '补充部署文档与回滚步骤',
    turns: [
      ['user', '部署文档里缺少回滚流程，帮我补一节，包含触发条件和具体命令。'],
      ['assistant', '我先读一下现有的部署文档结构，保持风格一致。'],
      ['tool', { name: 'exec', input: 'rg -n "^#" docs/deploy.md' }],
      ['assistant', '已经补上「回滚」一节，包含三个触发条件、两条回滚命令和一条验证命令。'],
    ],
  },
]

const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

const indexLines = []
for (const scenario of scenarios) {
  const file = path.join(outDir, scenario.day, `rollout-${scenario.stamp.replace(/:/gu, '-')}-${scenario.id}.jsonl`)
  const lines = []
  let t = new Date(scenario.stamp).getTime()
  const stamp = () => new Date((t += 1000)).toISOString()

  lines.push({
    timestamp: scenario.stamp,
    type: 'session_meta',
    payload: {
      id: scenario.id,
      session_id: scenario.id,
      timestamp: scenario.stamp,
      cwd: scenario.cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.163.0-alpha.11',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'custom',
    },
  })

  let ordinal = 0
  for (const [kind, payload] of scenario.turns) {
    ordinal += 1
    if (kind === 'user' || kind === 'assistant') {
      lines.push({
        timestamp: stamp(),
        ordinal,
        type: 'response_item',
        payload: {
          type: 'message',
          role: kind,
          content: [{ type: kind === 'user' ? 'input_text' : 'output_text', text: payload }],
        },
      })
      lines.push({
        timestamp: stamp(),
        ordinal,
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: kind === 'user' ? 'UserMessage' : 'AgentMessage', content: [{ type: 'text', text: payload }] } },
      })
    } else {
      lines.push({
        timestamp: stamp(),
        ordinal,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: `call_${ordinal}`,
          call_id: `call_${ordinal}`,
          status: 'completed',
          name: payload.name,
          input: payload.input,
        },
      })
      lines.push({
        timestamp: stamp(),
        ordinal,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: `call_${ordinal}`,
          output: 'ok',
        },
      })
    }
  }

  lines.push({
    timestamp: stamp(),
    ordinal,
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: scenario.turns.at(-1)[1] },
  })

  write(file, lines)
  indexLines.push({ id: scenario.id, thread_name: scenario.title, updated_at: scenario.stamp })
}

fs.writeFileSync(path.join(outDir, 'session_index.jsonl'), indexLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
console.log('demo sessions written to', outDir)
