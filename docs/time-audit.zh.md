# DSH 插件开发：时间去哪了，下次怎么提速

> 数据来源：一次真实的插件开发会话（会话 id 已省略），统计截至 2026-11-16 16:30。
> 复盘脚本：`docs/session-time-audit.mjs`（本仓库内），对任意 DSH 会话通用。
> 本文件是自包含的：附录 A 带脚本全文，只拿到这份 md 也能跑（见〈只拿到这份文档时〉）。

---

## 一句话结论

不是插件本身慢。44 小时的会话跨度里，**39 小时是人不在的空档**；真正干活的 5.2 小时中，
**模型往返占 3.6 小时、工具执行占 1.6 小时**。主要成本是：前期源码调研、每步都带超长上下文、
25 次 LLM 重试，以及插件重载和自动审查的反复往返。

---

## 本会话的账

| 项目 | 时长 | 说明 |
| --- | --- | --- |
| 会话跨度 | 2648 分钟（44.1 h） | 2026-11-14 20:26 起 |
| 其中空闲 | 2337 分钟（39.0 h） | 4 段 >10 分钟的间隔，等人回来 |
| 实际活跃 | 311 分钟（5.2 h） | 跨度 − 空闲 |
| ├ 模型与等待 | 213 分钟（3.6 h） | 生成、排队、重试 |
| └ 工具执行 | 98 分钟（1.6 h） | 299 次调用 |
| 规模 | 268 步 · 299 次工具调用 · 25 次 LLM 重试 | |

### 工具耗时排行

| 工具 | 次数 | 总耗时 | 最慢一次 |
| --- | --- | --- | --- |
| `ops_bash` | 229 | 58.4 min | 2.7 min（6 个仓库逐个 `git fetch`） |
| `plugin_manager` | 12 | 14.6 min | 5.0 min（安装/重载 + 自动审查） |
| `write` | 33 | 7.9 min | 0.7 min |
| `ask_user_question` | 1 | 7.5 min | 7.5 min（等你回话，不是机器慢） |
| `unpack_session` | 2 | 4.1 min | 2.3 min（真机导入） |
| `edit` | 17 | 4.1 min | 0.6 min |

### 分回合

| 回合 | 总时长 | 工具 | 模型/其余 | 内容 |
| --- | --- | --- | --- | --- |
| 1 | 163.2 min | 62.0 min | 101.2 min | 调研 asar/源码 + 首版实现 |
| 4 | 71.3 min | 26.6 min | 44.7 min | 第一批优化 + 真机验证 |
| 5–8 | 50.5 min | 7.4 min | 43.1 min | GitHub 自检；其中 6、7 回合 0 工具、纯等待 |
| 9 | 6.0 min | 1.1 min | 4.9 min | 时间复盘（本表数据来源） |

---

## 时间到底花在哪

1. **模型往返 213 分钟**：268 步摊下来，每步约 48 秒（不含工具）。turn 6/7 两轮「继续」各 13–15 分钟、
   零工具调用，就是纯生成/重试等待。日志里 25 次 `llm/retry` 是明显的放大器。
2. **调研一次性成本**：turn 1 的 101 分钟模型时间里，大半是解包 242 MB 的 `app.asar`、逐个读源码、
   扫描 38 个会话日志。这部分只做一次，但决定了首版能否一次成型。
3. **自动审查的隐形税**：本机 profile 开了 `dsh-experimental-auto-review`，`write`/`edit`/`plugin_manager`
   每次都要过一轮模型审查。50 次写操作 + 12 次插件操作，累计十几分钟。
4. **插件重载循环**：为了拿到真机错误，disable/enable 了三轮，每轮安装、应用、审查、等 pnpm。
   如果一次改完再重载，能省一半。
5. **重复劳动**：同一份日志反复解压分析、工作区条目清理两次、仓库同步检查逐个 fetch。

---

## 下次怎么做（清单）

### 开工前

- 把任务拆成 **调研 → 实现 → 验证** 三段；调研交给子代理，主会话只收「结论 + 文件清单 + 接口签名」。
- 先读 `docs/`、`.d.ts`、README，再决定要不要读实现；**不要整包解压** 200 MB 的 asar，
  用按需读取（只取需要的那几个文件）。
- 动笔前确认三件事：DSH 版本与插件接口、宿主服务名、日志/存储格式；这三样错了会返工。

### 进行中

- 独立的工具调用**合并并行**（3–5 个一批），别一个 `ls` 一步。
- 改动攒一批再重载插件；客户端改动用「刷新页面」验证，宿主改动能热加载就别 disable/enable。
- **机械步骤降推理档**（low/off），只有设计、排错、真机定位用 xhigh。
- 真机验证集中做 1–2 次，放在功能完成后；边写边全量导入最费时间。
- 重复的分析动作固化成脚本（本次的会话时长审计就是），下次直接跑。

### 收尾

- 全量单测 + 一次真机往返，再提交。
- 用审计脚本复盘「模型 / 工具 / 空闲」比例，写进交付说明。
- 把踩到的坑写进 CHANGELOG（例如：已存在附件的 rename EPERM、v4 头部不接受 `type`）。

---

## 其他插件会话能用这个方法吗

**能，而且不需要改脚本。** 所有 DSH 会话共用同一份事件日志格式：

- 位置：`<DSH_HOME>/sessions/<工作区编码>/<会话 id>/session.v4.jsonl.zstd`
- 事件：`tool/call`、`tool/result`、`turn/start`、`turn/end`、`llm/retry`、`step/start`，每条都有 `time`
- 脚本只依赖这些公共字段，与插件业务无关；换任何插件项目的会话都能直接算。

### 用法

```bash
# 最近更新的会话（通常就是当前这个）
node docs/session-time-audit.mjs

# 指定会话：id 或日志路径都行
node docs/session-time-audit.mjs --session <会话 id>

# 换一台机器 / 自定义 DSH_HOME
DSH_HOME=/path/to/.dsh node docs/session-time-audit.mjs --session <id>

# 调空闲阈值、慢调用条数、输出 JSON
node docs/session-time-audit.mjs --idle 5 --top 10
node docs/session-time-audit.mjs --json
```

会话 id 从哪来：DSH 侧边栏会话菜单里的「复制 Session ID」，或直接看日志目录名。

要求 Node 22+（`node:zlib` 的 zstd 支持）。脚本自己扫 zstd 多帧，不依赖 DSH 运行时，也不用装包。

### 只拿到这份文档时（自包含用法）

本文件附录 A 是脚本全文，按三步即可：

1. 把附录 A 的代码**原样**保存为 `session-time-audit.mjs`（注意不要带 Markdown 围栏）；
2. 校验内容没粘贴坏：
   - Windows PowerShell：`Get-FileHash .\session-time-audit.mjs -Algorithm SHA256`
   - macOS / Linux：`shasum -a 256 session-time-audit.mjs`
   - 应得到 `70ae5837a58ab29635fb6b8cddb9abe1039cada06bc6782522e0ab5a0b25570a`（约 287 行）；
3. 运行：`node session-time-audit.mjs --session <会话 id>`。

如果仓库里已经有脚本，不必重建：

```bash
node docs/session-time-audit.mjs
```

> 附录是某一时刻的快照；脚本文件存在时以文件为准，附录只在"只有 md"时使用。

### 局限

- 只统计本机 host 的时间戳；`ask_user_question` 的「工具耗时」其实是你在思考的时间。
- 空闲阈值默认 10 分钟，跨天会话请保持默认，否则会把午休算成模型时间。
- 旧格式（v3）或字段缺失的会话仍能算工具/空闲，但回合表可能不全；脚本对缺字段容错。
- 它回答「时间花在哪」，不回答「值不值」；一次 40 分钟的调研可能省掉两天返工。
- 远程/多机会话要在对应机器上跑，日志不会汇总。

---

## 把这份文档交给另一个会话（执行契约）

只把文件路径发给另一个会话，它**能自查、能给建议**，但不会自动"修好"——修复动作要么是改它接下来的工作方式，要么是改 profile 配置，后者必须经你确认。为了减少来回，把下面这段原样贴给它：

```text
读这份文档：docs/time-audit.zh.md（本仓库）
然后按顺序做：
1) 用 dsh-session-audit/session-time-audit.mjs 审计你当前会话（不带 --session 默认就是最新会话）；
2) 汇报四个数：活跃/空闲分钟、模型与工具占比、Top 5 慢调用、回合表里异常的回合；
3) 对照文档的清单，给出 3 条最可能见效的改动，逐条标注"只改工作方式"还是"要改 profile 配置"；
4) 先只汇报，不要改任何配置、插件或模型设置，等我确认。
约束：数字以脚本输出为准，不要估算；只统计本机；不要删除任何日志或会话。
```

它做不到的事，提前说清：

- **不能回滚已花掉的时间**，审计的是已经发生的会话，只能影响后续做法；
- **不能自己判断该不该改全局配置**（关自动审查、降推理档、换模型都会影响所有会话），必须你点头；
- **看不到别的机器**的会话日志，跨机要各自跑；
- 如果它读不到这个路径（不同工作区/别的电脑），把整份 md 贴进对话即可——附录 A 自带脚本全文。

它拿到之后的标准产出应该长这样，便于你判断有没有真做事：

```text
数据：活跃 41.2 分钟（工具 9.8 / 模型 31.4），空闲 3.1 小时
Top：pwsh 扫描 10.0 分钟；job_output 等待 3.0 分钟；……
异常：第 2、5 回合 0 工具、各 12+ 分钟，疑似重试
建议：① 把 3 个独立 ls 合并成一次并行（改工作方式）
      ② 机械步骤降到 low 推理（改 profile，需确认）
      ③ 真机验证集中到收尾（改工作方式）
```

---

## 附：本会话最慢的 6 次调用

| 耗时 | 时间 | 调用 | 说明 |
| --- | --- | --- | --- |
| 7.5 min | 11-14 20:41 | `ask_user_question` | 等用户确认设计选项 |
| 5.0 min | 11-14 22:29 | `plugin_manager` | 安装插件 + 应用 + 审查 |
| 3.1 min | 11-14 22:35 | `plugin_manager` | 重载插件 |
| 2.7 min | 11-16 16:18 | `ops_bash` | 6 个仓库逐个 fetch 检查同步 |
| 2.3 min | 11-15 08:21 | `plugin_manager` | 禁用/启用触发审查 |
| 2.3 min | 11-15 08:48 | `unpack_session` | 真机导入 835 事件会话 |

最后一个虽然慢，但抓到了两个只在真实环境出现的 bug（Windows rename EPERM、v4 头部 `type`），
是整个会话里性价比最高的 2.3 分钟。

---

## 附录 A：session-time-audit.mjs 全文（287 行）

<details>
<summary>展开脚本源码（SHA-256 70ae5837a58ab29635fb6b8cddb9abe1039cada06bc6782522e0ab5a0b25570a）</summary>

```js
#!/usr/bin/env node
/**
 * session-time-audit.mjs — 把一个 DSH 会话的墙钟时间拆开：工具、模型/等待、空闲。
 *
 * DSH 会把每个会话写成 `<DSH_HOME>/sessions/<项目>/<会话>/session.v4.jsonl.zstd`，
 * 每行一个事件，带毫秒时间戳。本脚本直接读这份日志，不依赖 DSH 运行时，
 * 因此可用于任意会话（包括别的插件项目的会话）。
 *
 * 用法：
 *   node session-time-audit.mjs                     # 分析最近更新的会话
 *   node session-time-audit.mjs --session <id|path> # 指定会话 id 或日志路径
 *   node session-time-audit.mjs --idle 5 --top 8    # 空闲阈值（分钟）、慢调用条数
 *   node session-time-audit.mjs --json              # 输出机器可读 JSON
 *
 * 要求 Node 22+（node:zlib 的 zstd 支持）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** 逐帧扫描 zstd 容器（日志是多个独立帧拼接，Node 只能解第一帧）。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === ZSTD_MAGIC) {
    let cursor = offset + 4
    const descriptor = buffer[cursor]
    cursor += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) cursor += 1
    if (dictFlag !== 0) cursor += [0, 1, 2, 4][dictFlag]
    cursor += [0, 1, 2, 4][contentSizeFlag]
    let end = -1
    for (;;) {
      if (cursor + 3 > buffer.length) break
      const blockHeader = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
      cursor += 3
      const last = blockHeader & 1
      const type = (blockHeader >> 1) & 3
      const size = blockHeader >>> 3
      cursor += type === 1 ? 1 : size
      if (cursor > buffer.length) break
      if (last) {
        end = cursor + (checksum ? 4 : 0)
        break
      }
    }
    if (end < 0 || end > buffer.length) break
    frames.push({ start: offset, end })
    offset = end
  }
  return frames
}

function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? resolve(configured.trim()) : join(homedir(), '.dsh')
}

function sessionRoot() {
  return join(dshHome(), 'sessions')
}

/** 所有已存会话的日志路径与 mtime。 */
function listSessionLogs(root) {
  const rows = []
  let projects
  try {
    projects = readdirSync(root)
  } catch {
    return rows
  }
  for (const project of projects) {
    const projectDir = join(root, project)
    let names
    try {
      names = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(projectDir, name)
      let files
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      const log = files.find((file) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(file))
      if (log === undefined) continue
      const path = join(dir, log)
      try {
        rows.push({ id: name, project, path, mtime: statSync(path).mtimeMs })
      } catch {
        /* vanished between listing and stat */
      }
    }
  }
  return rows
}

function resolveSession(target) {
  if (target !== undefined) {
    const asPath = resolve(target)
    try {
      if (statSync(asPath).isFile()) return { id: 'custom', project: '', path: asPath, mtime: 0 }
    } catch {
      /* not a path */
    }
    const match = listSessionLogs(sessionRoot()).find((row) => row.id === target || row.path.includes(target))
    if (match !== undefined) return match
    throw new Error(`找不到会话：${target}`)
  }
  const rows = listSessionLogs(sessionRoot()).sort((left, right) => right.mtime - left.mtime)
  if (rows.length === 0) throw new Error(`没有在 ${sessionRoot()} 找到任何会话日志`)
  return rows[0]
}

function readEvents(path) {
  const raw = readFileSync(path)
  const frames = scanZstdFrames(raw)
  if (frames.length === 0) throw new Error('日志不是可识别的 zstd 多帧格式')
  const text = frames.map((frame) => zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8')).join('')
  const lines = text.split('\n').filter((line) => line !== '')
  const header = JSON.parse(lines[0])
  const events = []
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line)
      if (event !== null && typeof event === 'object' && Number.isFinite(event.time)) events.push(event)
    } catch {
      /* 损坏行跳过，不影响整体统计 */
    }
  }
  events.sort((left, right) => left.time - right.time)
  return { header, events }
}

function minutes(ms) {
  return (ms / 60000).toFixed(1)
}

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function analyze(target, options) {
  const session = resolveSession(target)
  const { header, events } = readEvents(session.path)
  const idleThreshold = (options.idle ?? 10) * 60000

  // 工具调用与结果按 callId 配对。
  const pending = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') pending.set(event.data.callId, { name: event.data.name, start: event.time, args: event.data.arguments })
  }
  const tools = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? event.data?.toolCallId
    const call = pending.get(callId)
    if (call === undefined) continue
    let description = ''
    try {
      description = JSON.parse(call.args ?? '{}')?.description ?? ''
    } catch {
      /* arguments 不是 JSON */
    }
    tools.push({ name: call.name, start: call.start, ms: event.time - call.start, description })
  }

  const byName = new Map()
  for (const tool of tools) {
    const row = byName.get(tool.name) ?? { count: 0, ms: 0, max: 0 }
    row.count += 1
    row.ms += tool.ms
    row.max = Math.max(row.max, tool.ms)
    byName.set(tool.name, row)
  }
  const toolTotal = tools.reduce((sum, tool) => sum + tool.ms, 0)

  // 相邻事件间隔；超过阈值视为用户/空闲。
  const gaps = []
  for (let index = 1; index < events.length; index += 1) {
    gaps.push({ ms: events[index].time - events[index - 1].time, at: events[index].time, previous: events[index - 1].type, next: events[index].type })
  }
  const idle = gaps.filter((gap) => gap.ms > idleThreshold)
  const idleTotal = idle.reduce((sum, gap) => sum + gap.ms, 0)

  // 回合窗口。
  const turns = []
  for (const event of events) {
    if (event.type === 'turn/start') turns.push({ turn: event.data?.turn, start: event.time, end: null })
    if (event.type === 'turn/end' && turns.length > 0 && turns.at(-1).end === null) turns.at(-1).end = event.time
  }
  for (const turn of turns) {
    const inside = tools.filter((tool) => tool.start >= turn.start && (turn.end === null || tool.start <= turn.end))
    turn.toolMs = inside.reduce((sum, tool) => sum + tool.ms, 0)
    turn.wallMs = turn.end === null ? null : turn.end - turn.start
  }

  const spanMs = events.length > 1 ? events.at(-1).time - events[0].time : 0
  const result = {
    session: { id: header.id ?? session.id, project: session.project, path: session.path, createdAt: header.createdAt ?? null, cwd: header.cwd ?? null },
    spanMs,
    idleMs: idleTotal,
    activeMs: Math.max(0, spanMs - idleTotal),
    toolMs: toolTotal,
    modelMs: Math.max(0, spanMs - idleTotal - toolTotal),
    idleGaps: idle.sort((left, right) => right.ms - left.ms).slice(0, 10),
    tools: [...byName].map(([name, row]) => ({ name, ...row })).sort((left, right) => right.ms - left.ms),
    slowest: [...tools].sort((left, right) => right.ms - left.ms).slice(0, options.top ?? 8),
    turns,
    retries: events.filter((event) => event.type === 'llm/retry').length,
    steps: events.filter((event) => event.type === 'step/start').length,
    toolCalls: tools.length,
  }
  return result
}

function printReport(report) {
  const line = '─'.repeat(64)
  console.log(line)
  console.log(`会话  ${report.session.id}`)
  console.log(`时间  ${new Date(report.spanMs > 0 ? report.session.createdAt ?? Date.now() - report.spanMs : Date.now()).toLocaleString()} 起，跨度 ${minutes(report.spanMs)} 分钟`)
  if (report.session.cwd !== null) console.log(`目录  ${report.session.cwd}`)
  console.log(line)
  console.log(`活跃  ${minutes(report.activeMs)} 分钟   （工具 ${minutes(report.toolMs)} / 模型与等待 ${minutes(report.modelMs)}）`)
  console.log(`空闲  ${minutes(report.idleMs)} 分钟   （>10 分钟的间隔，通常是人不在这儿）`)
  console.log(`规模  ${report.steps} 步 · ${report.toolCalls} 次工具调用 · ${report.retries} 次 LLM 重试`)
  console.log(line)
  console.log('工具耗时')
  for (const row of report.tools) {
    console.log(`  ${pad(row.name, 20)}${pad(row.count, 4)} 次  ${pad(minutes(row.ms), 8)} 分钟  最慢 ${minutes(row.max)} 分钟`)
  }
  console.log(line)
  console.log('最慢的调用')
  for (const tool of report.slowest) {
    const description = tool.description === '' ? '' : `  ${tool.description.slice(0, 46)}`
    console.log(`  ${pad(minutes(tool.ms), 8)} 分钟  ${new Date(tool.start).toLocaleString()}  ${tool.name}${description}`)
  }
  console.log(line)
  console.log('回合')
  for (const turn of report.turns) {
    const wall = turn.wallMs === null ? '未结束' : `${minutes(turn.wallMs)} 分钟`
    console.log(`  第 ${pad(turn.turn ?? '?', 3)} 回合  ${pad(wall, 12)}  工具 ${pad(minutes(turn.toolMs), 8)} 分钟`)
  }
  console.log(line)
  console.log('空闲间隔')
  for (const gap of report.idleGaps) {
    console.log(`  ${pad(minutes(gap.ms), 8)} 分钟  ${new Date(gap.at).toLocaleString()}  ${gap.previous} -> ${gap.next}`)
  }
  console.log(line)
}

const argv = process.argv.slice(2)
const options = { idle: 10, top: 8 }
let target
let asJson = false
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--json') asJson = true
  else if (argument === '--session') target = argv[++index]
  else if (argument === '--idle') options.idle = Number(argv[++index]) || 10
  else if (argument === '--top') options.top = Number(argv[++index]) || 8
  else if (argument === '--help' || argument === '-h') {
    console.log('用法: node session-time-audit.mjs [--session <id|path>] [--idle 分钟] [--top N] [--json]')
    process.exit(0)
  } else if (!argument.startsWith('--')) target = argument
}

try {
  const report = analyze(target, options)
  if (asJson) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
} catch (error) {
  console.error(`审计失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
```

</details>
