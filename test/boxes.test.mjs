import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyBoxPlan, copyName, planBoxImport, unboxedPlan } from '../lib/boxes.mjs'

const descriptor = {
  name: '插件制作',
  color: 'blue',
  order: 1,
  collapsed: false,
  members: [
    { sessionId: 'session-a', index: 0 },
    { sessionId: 'session-b', index: 1 },
  ],
  pinned: ['session-b'],
}

function state(boxes = [], memberships = {}, pins = {}) {
  return { boxes, memberships, pins }
}

test('reuses a top-level box with the same name and never rewrites its attributes', () => {
  const plan = planBoxImport(state([{ id: 'box-1', name: '插件制作', parentId: null, color: 'red', order: 7 }]), descriptor)
  assert.equal(plan.mode, 'reuse')
  assert.equal(plan.parent.action, 'reuse')
  assert.equal(plan.parent.existingId, 'box-1')
  assert.equal(plan.counts.reuse, 1)
  assert.equal(plan.counts.create, 0)
  assert.equal(plan.counts.skip, 0)
  assert.equal(Object.hasOwn(plan.parent, 'color'), true)
  assert.equal(plan.parent.color, undefined, 'reuse must not carry color to write')
})

test('creates a box when no same-name top-level box exists', () => {
  const plan = planBoxImport(state([{ id: 'box-1', name: '别的盒', parentId: null }]), descriptor)
  assert.equal(plan.parent.action, 'create')
  assert.equal(plan.parent.name, '插件制作')
  assert.equal(plan.counts.create, 1)
})

test('copy mode never touches the original box and picks a unique suffix', () => {
  const existing = [{ id: 'box-1', name: '插件制作', parentId: null }, { id: 'box-2', name: '插件制作（导入）', parentId: null }]
  const plan = planBoxImport(state(existing), descriptor, 'copy')
  assert.equal(plan.parent.action, 'create')
  assert.equal(plan.parent.name, '插件制作（导入） 2')
  assert.equal(copyName(existing, '插件制作', null), '插件制作（导入） 2')
})

test('nested child boxes reuse under a reused parent, create under a new parent', () => {
  const withChild = {
    ...descriptor,
    children: [{ name: '子盒', color: 'green', order: 0, collapsed: false, members: [{ sessionId: 'session-a', index: 0 }] }],
  }
  const reused = planBoxImport(state([
    { id: 'box-1', name: '插件制作', parentId: null },
    { id: 'box-2', name: '子盒', parentId: 'box-1' },
  ]), withChild)
  assert.equal(reused.parent.action, 'reuse')
  assert.equal(reused.children[0].action, 'reuse')
  assert.equal(reused.children[0].existingId, 'box-2')

  const created = planBoxImport(state([{ id: 'box-1', name: '插件制作', parentId: null }]), withChild)
  assert.equal(created.children[0].action, 'create')
})

test('unboxed plan reports every member as skipped with a reason', () => {
  const plan = unboxedPlan(descriptor, '盒子服务不可达')
  assert.equal(plan.available, false)
  assert.equal(plan.counts.skip, 2)
  assert.equal(plan.reason, '盒子服务不可达')
})

test('apply creates the parent and assigns each imported id once, merging memberships', async () => {
  const calls = []
  const client = {
    state: async () => state([], { 'session-new-b': ['box-old'] }),
    create: async ({ name }) => {
      calls.push(['create', name])
      return name === '插件制作' ? 'box-new' : 'box-child'
    },
    assign: async (sessionId, boxIds) => {
      calls.push(['assign', sessionId, boxIds])
    },
  }
  const plan = {
    available: true,
    parent: { action: 'create', name: '插件制作', color: 'blue' },
    children: [],
  }
  const applied = await applyBoxPlan(client, plan, [{ sessionId: 'session-a' }, { sessionId: 'session-b' }], new Map([
    ['session-a', 'session-new-a'],
    ['session-b', 'session-new-b'],
  ]))
  assert.deepEqual(applied.results.map((row) => row.ok), [true, true])
  assert.deepEqual(calls, [
    ['create', '插件制作'],
    ['assign', 'session-new-a', ['box-new']],
    ['assign', 'session-new-b', ['box-old', 'box-new']],
  ])
})

test('a per-session assignment failure is reported without stopping the rest', async () => {
  const client = {
    state: async () => state([], {}),
    create: async () => 'box-new',
    assign: async (sessionId) => {
      if (sessionId === 'session-new-a') throw new Error('member cap')
    },
  }
  const applied = await applyBoxPlan(client, { available: true, parent: { action: 'create', name: '盒子' }, children: [] }, [
    { sessionId: 'session-a' },
    { sessionId: 'session-b' },
  ], new Map([['session-a', 'session-new-a'], ['session-b', 'session-new-b']]))
  assert.deepEqual(applied.results.map((row) => row.ok), [false, true])
  assert.equal(applied.results[0].error, 'member cap')
  assert.ok(applied.warnings.some((warning) => warning.includes('归盒失败')))
})

test('create falls back to a concurrently created same-name box', async () => {
  let created = false
  const client = {
    state: async () => state(created ? [{ id: 'box-race', name: '插件制作', parentId: null }] : []),
    create: async () => {
      created = true
      throw new Error('name already exists')
    },
    assign: async () => {},
  }
  const applied = await applyBoxPlan(client, { available: true, parent: { action: 'create', name: '插件制作' }, children: [] }, [
    { sessionId: 'session-a' },
  ], new Map([['session-a', 'session-new-a']]))
  assert.equal(applied.parentId, 'box-race')
  assert.ok(applied.warnings.some((warning) => warning.includes('复用它')))
})
