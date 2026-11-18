import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBoxManifest, buildManifest, normalizeManifest, sessionLogPath } from '../lib/pack.mjs'

const SHA = 'a'.repeat(64)

function sessionRow(id) {
  return {
    id,
    path: sessionLogPath(id),
    events: 1,
    sha256: SHA,
    createdAt: 1,
    cwd: 'D:\\work',
    delegationDepth: 0,
  }
}

function boxManifest() {
  return buildBoxManifest({
    toolVersion: '1.1.0',
    sessionFormatVersion: 4,
    roots: ['session-a', 'session-b'],
    title: '插件制作',
    box: {
      name: '插件制作',
      color: 'purple',
      order: 2,
      collapsed: false,
      header: { count: true },
      members: [
        { sessionId: 'session-a', index: 0 },
        { sessionId: 'session-b', index: 1 },
      ],
      pinned: ['session-b'],
      children: [
        {
          name: '子盒',
          color: 'green',
          order: 0,
          collapsed: true,
          members: [{ sessionId: 'session-a', index: 0 }],
        },
      ],
    },
    sessions: [sessionRow('session-a'), sessionRow('session-b')],
    attachments: [],
  })
}

test('a v2 box manifest round-trips roots, box, children, and pins', () => {
  const normalized = normalizeManifest(JSON.parse(JSON.stringify(boxManifest())))
  assert.equal(normalized.packVersion, 2)
  assert.deepEqual(normalized.roots, ['session-a', 'session-b'])
  assert.equal(normalized.root, 'session-a')
  assert.equal(normalized.box.name, '插件制作')
  assert.equal(normalized.box.color, 'purple')
  assert.deepEqual(normalized.box.members.map((row) => row.sessionId), ['session-a', 'session-b'])
  assert.deepEqual(normalized.box.pinned, ['session-b'])
  assert.equal(normalized.box.children[0].name, '子盒')
  assert.equal(normalized.box.header.count, true)
})

test('a v1 manifest still normalizes with roots = [root]', () => {
  const v1 = buildManifest({
    toolVersion: '1.0.2',
    sessionFormatVersion: 4,
    root: 'session-a',
    sessions: [sessionRow('session-a')],
    attachments: [],
  })
  const normalized = normalizeManifest(JSON.parse(JSON.stringify(v1)))
  assert.equal(normalized.packVersion, 1)
  assert.deepEqual(normalized.roots, ['session-a'])
  assert.equal(normalized.box, undefined)
})

test('a newer layout is refused before anything else is read', () => {
  const manifest = { ...boxManifest(), packVersion: 3 }
  assert.throws(() => normalizeManifest(manifest), /pack layout v3 is newer than this plugin reads \(v2\)/)
})

test('v1 must not carry a box descriptor', () => {
  const v1 = buildManifest({ toolVersion: '1', sessionFormatVersion: 4, root: 'session-a', sessions: [sessionRow('session-a')], attachments: [] })
  assert.throws(() => normalizeManifest({ ...v1, box: { name: 'x', members: [] } }), /v1 must not carry a box/)
})

test('v2 requires non-empty roots and known sessions', () => {
  const manifest = boxManifest()
  assert.throws(() => normalizeManifest({ ...manifest, roots: [] }), /lists no roots/)
  assert.throws(() => normalizeManifest({ ...manifest, roots: ['session-missing'] }), /unknown root/)
  assert.throws(() => normalizeManifest({ ...manifest, roots: ['session-a', 'session-a'] }), /root twice/)
})

test('box members must name packed sessions and boxes stay one level deep', () => {
  const manifest = boxManifest()
  const badMember = structuredClone(manifest)
  badMember.box.members[0].sessionId = 'session-missing'
  assert.throws(() => normalizeManifest(badMember), /unknown session/)

  const tooDeep = structuredClone(manifest)
  tooDeep.box.children[0].children = [{ name: '孙盒', members: [{ sessionId: 'session-a', index: 0 }] }]
  assert.throws(() => normalizeManifest(tooDeep), /nests boxes too deep/)
})
