/**
 * Plugin self-test for the plugin detail page.
 *
 * Four checks, each bounded by its own timeout:
 *  1. the health route answers 200;
 *  2. all three agent tools are registered;
 *  3. the optional boxes route answers (a miss only warns);
 *  4. the export directory accepts a zero-byte probe file, then the probe is removed.
 *
 * The route is read-only apart from the probe file it creates and deletes.
 *
 * @module dsh-session-transfer/selftest
 */
import { TransferError } from './transfer-error.mjs'

/** Per-check timeout. */
export const SELFTEST_TIMEOUT_MS = 2000

const LABELS = {
  zh: {
    health: '健康检查',
    tools: '工具注册',
    boxes: '归盒可用性',
    writable: '导出目录可写',
    pass: '通过',
    fail: '失败',
    warn: '提示',
  },
  en: {
    health: 'Health endpoint',
    tools: 'Agent tools',
    boxes: 'Boxes availability',
    writable: 'Export directory writable',
    pass: 'pass',
    fail: 'failed',
    warn: 'note',
  },
}

/** Resolve one label set. */
function labelsOf(lang) {
  return lang === 'en' ? LABELS.en : LABELS.zh
}

/**
 * Run one piece of work with a hard timeout and an abort signal.
 * @param ms - timeout in milliseconds.
 * @param work - receives the abort signal.
 * @returns the work result.
 */
async function within(ms, work) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TransferError(`超时（${ms}ms）`, { code: 'SELFTEST_TIMEOUT' }))
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** One item row. */
function item(id, label, status, detail) {
  return { id, label, status, ...(detail === undefined ? {} : { detail }) }
}

/**
 * Render the copyable Markdown report.
 * @param items - finished check rows.
 * @param labels - localized status words.
 * @returns the Markdown text.
 */
export function selftestMarkdown(items, lang = 'zh') {
  const labels = labelsOf(lang)
  const lines = items.map((row) => {
    if (row.status === 'pass') return `- [x] ${row.label} — ${labels.pass}`
    if (row.status === 'warn') return `- [x] ${row.label} — ${labels.pass}（${labels.warn}：${row.detail ?? ''}）`
    return `- [ ] ${row.label} — ${labels.fail}：${row.detail ?? ''}`
  })
  return lines.join('\n')
}

/**
 * Run every self-test check.
 * @param deps - origin, fetch, tool probe, write probe, timeout, and language.
 * @returns items, summary, and Markdown.
 */
export async function runSelftest(deps) {
  const labels = labelsOf(deps.lang)
  const timeoutMs = deps.timeoutMs ?? SELFTEST_TIMEOUT_MS
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const items = []

  // 1. Health route.
  try {
    const response = await within(timeoutMs, (signal) => fetchImpl(`${deps.origin}/session-transfer/health`, { signal }))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await within(timeoutMs, () => response.json())
    const version = typeof payload?.version === 'string' ? ` v${payload.version}` : ''
    items.push(item('health', labels.health, 'pass', `200${version}`))
  } catch (error) {
    items.push(item('health', labels.health, 'fail', error instanceof Error ? error.message : String(error)))
  }

  // 2. Agent tools.
  try {
    const names = ['pack_session', 'unpack_session', 'pack_box']
    const missing = []
    for (const name of names) {
      let registered = false
      try {
        registered = deps.hasTool(name) === true
      } catch {
        registered = false
      }
      if (!registered) missing.push(name)
    }
    if (missing.length === 0) items.push(item('tools', labels.tools, 'pass', `${names.length} 个工具已注册`))
    else items.push(item('tools', labels.tools, 'fail', `缺少：${missing.join('、')}`))
  } catch (error) {
    items.push(item('tools', labels.tools, 'fail', error instanceof Error ? error.message : String(error)))
  }

  // 3. Boxes (optional): a miss is a warning, never a failure.
  try {
    const response = await within(timeoutMs, (signal) => fetchImpl(`${deps.origin}/session-boxes`, { signal }))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await within(timeoutMs, () => response.json())
    if (payload?.ok !== true || payload.state === undefined) throw new Error('响应无效')
    items.push(item('boxes', labels.boxes, 'pass', '归盒可用'))
  } catch (error) {
    items.push(item('boxes', labels.boxes, 'warn', `归盒功能不可用：${error instanceof Error ? error.message : String(error)}`))
  }

  // 4. Export directory probe: create a zero-byte file, then remove it.
  try {
    const path = await within(timeoutMs, () => deps.writeProbe())
    items.push(item('writable', labels.writable, 'pass', typeof path === 'string' ? path : undefined))
  } catch (error) {
    items.push(item('writable', labels.writable, 'fail', error instanceof Error ? error.message : String(error)))
  }

  const summary = {
    pass: items.filter((row) => row.status === 'pass').length,
    fail: items.filter((row) => row.status === 'fail').length,
    warn: items.filter((row) => row.status === 'warn').length,
  }
  return {
    ok: summary.fail === 0,
    ranAt: Date.now(),
    items,
    summary,
    markdown: selftestMarkdown(items, deps.lang),
  }
}
