# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-10-26

### Fixed
- 窗口较矮时 Web 面板把「目录:」一行挤成半截、会话行被压扁的问题：面板里除会话列表外的
  每一项都固定为不收缩（`flexShrink: 0`），列表改为 `flex: 1 1 0%` 独占剩余空间并滚动。
- 「工作要点」弹层移入会话列表内部，随列表一起滚动，不再把面板撑出容器。

### Changed
- 面板最大高度由 `min(60vh, 520px)` 放宽到 `min(70vh, 560px)`，矮窗口下也能看到完整会话行。

## [1.3.1] - 2026-10-26

### Fixed
- 修复 Web 面板会话列表撑破面板、盖住「目录:」一行的问题（弹性子项缺少 `minHeight: 0`）。

### Added
- 商店截图：`screenshots.json` + `assets/screenshot-*.png`（面板 / 工作要点 / 下栏入口），README 顶部也放了面板图。
- `tools/build-release.mjs`：一条命令构建 npm 风格的发布 tarball 并挂到 GitHub Release。

## [1.3.0] - 2026-10-23

### Added
- 跨机共享目录（`share`）：把本机 Codex 记录与 DSH 会话日志镜像到同一个被同步的文件夹，
  两台机器互相看到对方的 Codex / DSH 会话，并标注来源机器。
- 新增 `dsh_history` 模型工具与 `/dsh` 斜杠命令，用于检索其他机器共享过来的 DSH 对话。
- 新增 `lib/dshlog.js`：解析 DSH 的 `session.v4.jsonl.zstd`（多帧 zstd 容器）。
- Web 面板新增「工作要点」按钮与日期区间筛选。

### Changed
- Web 面板下栏入口改为与 `activity` / `usage` 完全一致的胶囊样式（同字号、同色系）。
- 去掉会话行里的短 id 标签（视觉噪音）。
- 修复客户端热重载后多语言字典不更新导致的界面显示原始 key 的问题。
- 包名由 `@local/codex-history` 改为 `dsh-codex-history`，可直接通过 GitHub 地址安装。

### Fixed
- 修复请求 URL 拼接时丢失 query string 的问题。
- 客户端脚本被重复执行时不再抛出「duplicate factory registration」：重复执行会被安全跳过，
  热重载或残留的启动图行都不会影响面板。

## [1.2.0] - 2026-10-23

### Added
- `worklog` 动作：把长会话压缩成「用户提出的事项 / 助手的产出 / 工具活动 / 涉及文件 / 报错与失败」。
- 工具调用与触碰文件的采集（`toolCalls` / `touchedFiles` / `failedToolCallCount`）。
- 所有列表、检索接口支持时间窗口 `since` / `until`（按会话与时间的区间重叠筛选）。
- 清洗 `:codex-annotation{index="N"}` 界面标记。

## [1.1.0] - 2026-10-23

### Added
- 实时同步：已导入的会话在 Codex 侧出现新消息时，增量注入同一个 DSH 对话。
- `GET /api/codex-history/status` 状态接口。
- `liveSync` 配置项。

## [1.0.0] - 2026-10-23

### Added
- 首版：自动读取 `~/.codex/sessions`、解析 Codex rollout JSONL、`codex_history` 模型工具、
  `/codex` 斜杠命令、输入框下方的「Codex 历史」Web 面板、按工作目录自动带入上下文。

[1.3.1]: https://github.com/chameleonn4/dsh-codex-history/releases/tag/v1.3.1
[1.3.0]: https://github.com/chameleonn4/dsh-codex-history/releases/tag/v1.3.0
[1.2.0]: https://github.com/chameleonn4/dsh-codex-history/releases/tag/v1.2.0
[1.1.0]: https://github.com/chameleonn4/dsh-codex-history/releases/tag/v1.1.0
[1.0.0]: https://github.com/chameleonn4/dsh-codex-history/releases/tag/v1.0.0
