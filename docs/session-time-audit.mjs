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
