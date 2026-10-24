# dsh-codex-history

> Seamlessly connect **DeepSeek Harness (DSH)** with your local Codex CLI chat history.
> The plugin automatically reads the Codex sessions stored in `~/.codex/sessions`, hands them to the
> DSH model, and syncs new Codex progress back into the running conversation.

[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0-5843b8)](https://github.com/chameleonn4/dsh-codex-history)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c8739)](https://nodejs.org)

中文文档：[README.md](./README.md)

---

## 1. What it solves

You spend a morning chatting with Codex CLI (or Codex Desktop) and build up a lot of context.
Switching to DSH, that context does **not** come along. `dsh-codex-history` turns Codex's local
session files into first-class DSH context:

| Capability | Description |
| --- | --- |
| **Auto-read** | Polls `~/.codex/sessions/**/rollout-*.jsonl` in the background and re-indexes only changed files (every 5 s by default) |
| **Model-facing** | Registers the `codex_history` tool so the model can list / search / read history on its own |
| **User-facing** | Registers the `/codex` slash command and a **“Codex 历史”** entry under the composer |
| **One-click handoff** | Import a whole Codex session into the current DSH conversation, or push it into the input box |
| **Auto-injection** | A new session whose working directory matches a Codex session starts with that context |
| **Live sync** | New messages appearing in an imported Codex session are streamed back as deltas (never triggers a turn on its own) |
| **Work log** | `worklog` condenses a long session into “what was asked / what was done / which files / what failed” |
| **Cross-machine** | Optional shared folder lets a desktop and a work laptop see each other’s Codex and DSH conversations |

The plugin has **zero runtime dependencies** (Node built-ins only) and **only reads** `~/.codex`.

---

## 2. UI

A small pill labeled **“Codex 历史”** appears under the composer, styled exactly like the other
bottom-bar entries (`activity`, `usage`). Clicking it opens a panel with:

```
本地 Codex 会话                                    关闭
[ search by title or cwd            ] [refresh]
[ from date ] [ to date ]
目录: C:\Users\you\.codex\sessions

昨天写的周报脚本 · D:\work\report
2026-10-23 00:22 · 21 条消息 · 3 次工具调用 · D:\skills
[import] [fill input] [work log]
```

- **Import** injects the transcript into the current conversation so the model can continue.
- **Fill input** puts the transcript into the composer box.
- **Work log** shows the structured summary.

---

## 3. Requirements

| Item | Requirement |
| --- | --- |
| DSH | **≥ 0.2.0** (developed and verified against **0.2.1-rc.2**; declared as `engines.dsh: ">=0.2.0"`) |
| Runtime | Node.js ≥ 20 (bundled with the DSH desktop app) |
| OS | Windows / macOS / Linux (all paths go through the `path` API) |
| Dependencies | **None at runtime** — Node built-ins only |
| Codex | Codex CLI / Codex Desktop must have written at least one session (`rollout-*.jsonl`) |

---

## 4. Installation

### 4.1 Plugin manager (recommended)

1. Open DSH → **Plugin Manager** → add a plugin.
2. Enter the GitHub URL:

   ```
   https://github.com/chameleonn4/dsh-codex-history
   ```

   (or `chameleonn4/dsh-codex-history`)
3. Confirm. The manager installs it as a bundle into the current profile and writes the patch row.
4. **Restart DSH** — the “Codex 历史” pill appears under the composer.

### 4.2 Clone and install from a local directory

```bash
git clone https://github.com/chameleonn4/dsh-codex-history.git
dsh plugin --profile <profile> install ./dsh-codex-history
```

### 4.3 Manual profile patch

Append to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: codex-history
      name: 'dsh-codex-history'
```

Then link the folder into the profile’s `node_modules` (`pnpm add link:D:/path/to/dsh-codex-history`)
and restart DSH.

### 4.4 Development

Link the repo into the profile, then re-enable the `codex-history` plugin entry after each change:
the Host half hot-reloads, the Client half needs a page refresh.

---

## 5. Configuration

Configuration lives in the profile patch file `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: codex-history
  config:
    sessionsDir: 'C:\Users\you\.codex\sessions'
    indexPath: 'C:\Users\you\.codex\session_index.jsonl'
    pollIntervalMs: 5000
    maxListResults: 50
    maxTranscriptChars: 20000
    maxImportChars: 12000
    autoImport:
      enabled: true
      matchCwd: true
      maxChars: 6000
      maxMessages: 40
    liveSync:
      enabled: true
      maxChars: 6000
    share:
      enabled: false
      dir: 'C:\Users\you\CodexShare'
      machineId: 'desktop'
      label: '台式机'
      mirrorCodex: true
      mirrorDsh: true
      intervalMs: 30000
      discoverIntervalMs: 15000
```

> `config` is **replaced wholesale**, not deep-merged — restate every field you want to keep.

| Key | Default | Meaning |
| --- | --- | --- |
| `sessionsDir` | `~/.codex/sessions` | Codex session folder |
| `indexPath` | `~/.codex/session_index.jsonl` | Codex session-title index |
| `pollIntervalMs` | `5000` | Folder polling interval (ms) |
| `maxListResults` | `50` | Max entries for list endpoints |
| `maxTranscriptChars` | `20000` | Transcript length cap |
| `maxImportChars` | `12000` | Context cap when importing into a conversation |
| `autoImport.enabled` | `true` | Auto-inject matching Codex context into new sessions |
| `autoImport.matchCwd` | `true` | Match by working directory |
| `autoImport.maxChars` | `6000` | Auto-injected char cap |
| `autoImport.maxMessages` | `40` | Auto-injected message cap (most recent N) |
| `liveSync.enabled` | `true` | Stream new Codex messages back into imported conversations |
| `liveSync.maxChars` | `6000` | Delta char cap |
| `share.enabled` | `false` | Enable the cross-machine shared folder |
| `share.dir` | `~/CodexShare` | Shared folder (point both machines at the same synced path) |
| `share.machineId` | hostname | This machine’s identifier |
| `share.label` | same as id | Display name shown in listings |
| `share.mirrorCodex` | `true` | Mirror local Codex records into the shared folder |
| `share.mirrorDsh` | `true` | Mirror local DSH session logs into the shared folder |
| `share.intervalMs` | `30000` | Mirror interval |
| `share.discoverIntervalMs` | `15000` | Peer-discovery interval |

---

## 6. Usage

### 6.1 Model tool `codex_history`

| Action | Parameters | Description |
| --- | --- | --- |
| `list` | `limit`, `since`, `until` | List recent Codex sessions |
| `read` | `session_id` | Read a full transcript |
| `search` | `query`, `limit` | Full-text search |
| `latest` | `cwd`, `since`, `until` | Most recent session for a working directory |
| `worklog` | `session_id` or `cwd` + range | Structured work summary |

`since` / `until` accept `YYYY-MM-DD` or ISO 8601; a bare date covers the whole UTC day.
Sessions match on **overlap** with the requested window.

### 6.2 Model tool `dsh_history`

Available when the shared folder is enabled: `list` / `read` / `search` over other machines’ DSH chats.

### 6.3 Slash commands

```
/codex                          list recent Codex sessions
/codex search <keyword>         full-text search
/codex worklog [from] [to]      work log inside a date window
/codex <session id> [count]     import that session into this conversation
/dsh                            list DSH sessions shared by other machines
/dsh search <keyword>           search those sessions
```

### 6.4 Web panel

Search, filter by date, import, fill the composer, and read work logs — all from the pill under the composer.

### 6.5 Auto-injection and live sync

- **Auto-injection** applies to root sessions only, when the Codex session’s `cwd` matches the current one.
- **Live sync** uses *inject* (queued for the next step), so it never starts a model turn by itself.

---

## 7. Shared folder across machines

Point both machines at the same synced directory and enable `share`:

```
<shared>/
  machines/<machineId>.json
  codex/<machineId>/sessions/…
  codex/<machineId>/session_index.jsonl
  dsh/<machineId>/sessions/…
```

Each machine only writes its own subtree, so no sync conflict resolution is needed.

---

## 8. HTTP API

All routes live under `/api/codex-history` and reuse DSH’s built-in auth / same-origin gate
(`401` when not signed in, `403` for untrusted or cross-site requests).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/codex-history/status` | Plugin status, version, folders, session count |
| `GET` | `/api/codex-history/sessions` | Session list (`query`, `cwd`, `since`, `until`, `limit`) |
| `GET` | `/api/codex-history/session?id=` | Full transcript of one session |
| `GET` | `/api/codex-history/worklog` | Work log (`id`, `cwd`, `since`, `until`, `limit`) |
| `POST` | `/api/codex-history/import` | `{"id": "<session id>", "targetSessionId": "<DSH session id>"}` |
| `GET` | `/api/codex-history/dsh-sessions` | DSH sessions shared by other machines |
| `GET` | `/api/codex-history/dsh-session?id=` | Transcript of a shared DSH session |

---

## 9. How Codex sessions are parsed

Codex writes one JSONL file per conversation:

```
~/.codex/sessions/2026/10/22/rollout-2026-10-22T23-12-43-<uuid>.jsonl
```

Each line is `{"timestamp":…,"type":…,"payload":…}`. The plugin reads:

| Record | Use |
| --- | --- |
| `session_meta` | Session id, cwd, CLI version, model provider |
| `response_item` / `message` | Main transcript source (`role` = `user` / `assistant`) |
| `event_msg` / `item_completed` | Fallback transcript source |
| `event_msg` / `task_complete` | `last_agent_message` fallback |
| `response_item` / `custom_tool_call`, `function_call` | Tool calls, used for the work log |
| `turn_context` | Per-turn model and sandbox settings |

Cleaning rules: drop `<environment_context>`, expand `<send_user_message_question_reply>`,
split `# Files mentioned by the user:` + `## My request:`, expand `# Response annotations:`,
and strip `:codex-annotation{index="N"}` markers.

DSH session logs are `session.v4.jsonl.zstd` — a container of concatenated zstd frames; the plugin
locates frame boundaries and inflates each frame, which is how shared DSH conversations are read.

---

## 10. Source layout

```
dsh-codex-history/
├── index.js                 Host entry: tools, commands, HTTP routes, background sync
├── lib/
│   ├── parse.js             Codex rollout parsing + cleaning
│   ├── store.js             Session index, time windows, incremental refresh
│   ├── format.js            Transcript / import / delta / work-log rendering
│   ├── share.js             Shared-folder mirroring and peer discovery
│   ├── dshstore.js          Index of peer DSH sessions
│   └── dshlog.js            DSH session log (multi-frame zstd) decoding
├── client/client.js         Web panel (React, `conversation.composer.dock` slot)
├── locale/{zh,en}.json      Plugin-manager metadata
├── cordis.patch.yml         Bundle patch that inserts the plugin
├── icon.svg
├── test/                    Self-test scripts
└── tools/asar.js            Dev helper: read app.asar
```

---

## 11. Development and tests

```bash
node --check index.js && node --check client/client.js
node test/parse-check.mjs      # parser + work-log assertions
node test/plugin-mock.mjs      # host side against a mock ctx
node test/live-sync.mjs        # end-to-end delta sync
node test/host-smoke.mjs       # parse the real ~/.codex/sessions
node test/share-check.mjs      # end-to-end cross-machine share chain
node test/http-check.mjs       # live HTTP request against a running DSH
```

---

## 12. FAQ

**Nothing in the panel?** Check that `~/.codex/sessions` contains `rollout-*.jsonl`, and open
`GET /api/codex-history/status` for `available` / `sessionCount`.

**The model seems unaware of Codex history?** It has to call `codex_history`; the plugin advertises
the tool in the system prompt, and you can also ask for it explicitly.

**Auto-injection did not fire?** It requires `autoImport.enabled`, a root session, and a matching `cwd`.

**Host changes not taking effect?** With a linked install, re-enable the plugin entry after editing files.

---

## 13. License

[MIT](./LICENSE) © chameleonn4
