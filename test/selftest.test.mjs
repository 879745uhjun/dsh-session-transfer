import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { runSelftest, selftestMarkdown } from '../lib/selftest.mjs'

const origin = 'http://127.0.0.1:1'
const okJson = (value) => ({ ok: true, json: async () => value })
const notFound = { ok: false, status: 404, json: async () => ({}) }

function deps(overrides = {}) {
  return {
    origin,
    fetchImpl: async (url) => {
      if (url.endsWith('/session-transfer/health')) return okJson({ ok: true, version: '1.3.0' })
      if (url.endsWith('/session-boxes')) return okJson({ ok: true, state: { boxes: [] } })
      return notFound
    },
    hasTool: () => true,
    writeProbe: async () => 'C:/Users/x/.dsh/session-packs',
    timeoutMs: 200,
    lang: 'zh',
    ...overrides,
  }
}

test('every check passes when the host answers, tools exist, and the probe writes', async () => {
  const result = await runSelftest(deps())
  assert.equal(result.ok, true)
  assert.deepEqual(result.summary, { pass: 4, fail: 0, warn: 0 })
  assert.deepEqual(result.items.map((row) => row.status), ['pass', 'pass', 'pass', 'pass'])
  assert.match(result.markdown, /^- \[x\] 健康检查 — 通过$/mu)
  assert.match(result.markdown, /导出目录可写 — 通过/u)
})

test('a missing tool fails only that item', async () => {
  const result = await runSelftest(deps({ hasTool: (name) => name !== 'pack_box' }))
  assert.equal(result.summary.fail, 1)
  assert.equal(result.items.find((row) => row.id === 'tools').status, 'fail')
  assert.match(result.items.find((row) => row.id === 'tools').detail, /pack_box/u)
  assert.equal(result.items.find((row) => row.id === 'health').status, 'pass')
  assert.equal(result.items.find((row) => row.id === 'writable').status, 'pass')
})

test('a 404 health endpoint fails and leaves the other checks alone', async () => {
  const result = await runSelftest(deps({
    fetchImpl: async (url) => url.endsWith('/session-transfer/health') ? notFound : okJson({ ok: true, state: { boxes: [] } }),
  }))
  assert.equal(result.items.find((row) => row.id === 'health').status, 'fail')
  assert.match(result.items.find((row) => row.id === 'health').detail, /404/u)
  assert.equal(result.items.find((row) => row.id === 'boxes').status, 'pass')
  assert.equal(result.summary.fail, 1)
})

test('the optional boxes probe only warns', async () => {
  const result = await runSelftest(deps({
    fetchImpl: async (url) => url.endsWith('/session-transfer/health')
      ? okJson({ ok: true, version: '1.3.0' })
      : notFound,
  }))
  assert.equal(result.ok, true)
  assert.equal(result.items.find((row) => row.id === 'boxes').status, 'warn')
  assert.match(result.items.find((row) => row.id === 'boxes').detail, /归盒功能不可用/u)
  assert.match(result.markdown, /归盒可用性 — 通过（提示：/u)
})

test('a hanging check times out without blocking the rest', async () => {
  const result = await runSelftest(deps({
    timeoutMs: 25,
    fetchImpl: async (url) => {
      if (url.endsWith('/session-transfer/health')) return new Promise(() => {})
      return okJson({ ok: true, state: { boxes: [] } })
    },
  }))
  const health = result.items.find((row) => row.id === 'health')
  assert.equal(health.status, 'fail')
  assert.match(health.detail, /超时/u)
  assert.equal(result.items.find((row) => row.id === 'tools').status, 'pass')
  assert.equal(result.items.find((row) => row.id === 'boxes').status, 'pass')
})

test('an unwritable export directory fails only that item', async () => {
  const result = await runSelftest(deps({ writeProbe: async () => { throw new Error('EPERM: access denied') } }))
  assert.equal(result.items.find((row) => row.id === 'writable').status, 'fail')
  assert.match(result.items.find((row) => row.id === 'writable').detail, /EPERM/u)
  assert.equal(result.summary.pass, 3)
})

test('Markdown marks failures and notes in the spec shape', () => {
  const markdown = selftestMarkdown([
    { id: 'a', label: '健康检查', status: 'pass' },
    { id: 'b', label: '工具注册', status: 'fail', detail: '缺少：pack_box' },
    { id: 'c', label: '归盒可用性', status: 'warn', detail: '归盒功能不可用：HTTP 404' },
  ], 'zh')
  assert.equal(markdown, [
    '- [x] 健康检查 — 通过',
    '- [ ] 工具注册 — 失败：缺少：pack_box',
    '- [x] 归盒可用性 — 通过（提示：归盒功能不可用：HTTP 404）',
  ].join('\n'))
})

/** Load client.js in a VM with a stubbed module loader, then build the plugin object. */
function loadClientPlugin() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let loadedModule
  const window = { __ModuleLoader__: { load: (module) => { loadedModule = module } } }
  runInNewContext(source, { window })
  const fakeRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => ({}),
        Fragment: 'Fragment',
        useState: () => [null, () => {}],
        useRef: () => ({}),
        useEffect: () => {},
        useSyncExternalStore: () => null,
      }
    }
    throw new Error(`unexpected module ${id}`)
  }
  return loadedModule.factory(fakeRequire)
}

test('the self-test section recognises both detail-subject shapes', () => {
  const plugin = loadClientPlugin()
  assert.equal(plugin.selftest.subjectPluginName({ kind: 'bundle', pkg: { name: 'dsh-session-transfer' } }), 'dsh-session-transfer')
  assert.equal(plugin.selftest.subjectPluginName({ kind: 'item', id: 'dsh-session-transfer' }), 'dsh-session-transfer')
  assert.equal(plugin.selftest.subjectPluginName({ kind: 'item', id: 'include:dsh-session-transfer' }), 'dsh-session-transfer')
})

test('the self-test section ignores another plugin item subject', () => {
  const plugin = loadClientPlugin()
  assert.equal(plugin.selftest.subjectPluginName({ kind: 'item', id: 'include:dsh-session-todos' }), undefined)
  assert.equal(plugin.selftest.subjectPluginName({ kind: 'item', id: 'include:dsh-session-transfer-extra' }), undefined)
  assert.equal(plugin.selftest.subjectPluginName(undefined), undefined)
})

/** Build one isolated pack-toast store with a manual scheduler. */
function toastHarness() {
  const plugin = loadClientPlugin()
  let state = null
  const store = {
    get: () => state,
    set: (next) => {
      state = next
    },
    subscribe: () => () => {},
  }
  const timers = []
  const toast = plugin.selftest.createPackToast({
    createStore: () => store,
    schedule: (callback, ms) => {
      timers.push({ callback, ms })
      return timers.length
    },
  })
  return { toast, timers, read: () => state }
}

test('a failed pack toast clears itself after 6 seconds', () => {
  const { toast, timers, read } = toastHarness()
  toast.publish({ status: 'failed', error: '这个会话不在任何盒子里', code: 'BOX_NONE' }, 6000)
  assert.equal(read().status, 'failed')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 6000)
  timers[0].callback()
  assert.equal(read().status, 'idle')
})

test('manual dismiss clears the toast immediately and survives its timer', () => {
  const { toast, timers, read } = toastHarness()
  toast.publish({ status: 'failed', error: 'x', code: 'BOX_NONE' }, 6000)
  toast.dismiss()
  assert.equal(read().status, 'idle')
  timers[0].callback()
  assert.equal(read().status, 'idle')
})

test('a stale failure timer never clears a newer success', () => {
  const { toast, timers, read } = toastHarness()
  toast.publish({ status: 'failed', error: 'x', code: 'BOX_NONE' }, 6000)
  toast.publish({ status: 'done' }, 4000)
  assert.equal(read().status, 'done')
  assert.equal(timers[1].ms, 4000)
  timers[0].callback()
  assert.equal(read().status, 'done', 'old failure timer must not clear the success')
  timers[1].callback()
  assert.equal(read().status, 'idle')
})

test('the client registers the section with the required id and order', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /name: 'plugins\.detail\.section'/u)
  assert.match(source, /id: 'dsh-session-transfer\.selftest'/u)
  assert.match(source, /order: 90/u)
  assert.match(source, /'selftest\.title': '自检'/u)
  assert.match(source, /'selftest\.title': 'Self-test'/u)
})
