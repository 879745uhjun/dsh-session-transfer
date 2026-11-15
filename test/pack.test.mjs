import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PACK_KIND,
  attachmentRefsInLog,
  buildManifest,
  fileLeafName,
  normalizeManifest,
  parseSessionLog,
  serializeSessionLog,
  sessionLogPath,
  titleOfEvents,
} from '../lib/pack.mjs'

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-abc',
  createdAt: 1792485279825,
  cwd: 'D:\\work',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}

const EVENTS = [
  { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
  { type: 'session/title', seq: 1, time: 2, data: { title: '测试会话' } },
]

test('session logs round-trip through the canonical codec', () => {
  const text = serializeSessionLog(HEADER, EVENTS)
  assert.ok(text.endsWith('\n'))
  const parsed = parseSessionLog(text, 'x.jsonl')
  assert.deepEqual(parsed.header, HEADER)
  assert.deepEqual(parsed.events, EVENTS)
})

test('the codec keeps optional header keys only when present', () => {
  const text = serializeSessionLog({ ...HEADER, cwd: undefined, parentSession: 'parent', origin: 'subagent' }, [])
  const parsed = parseSessionLog(text, 'x.jsonl')
  assert.equal(parsed.header.cwd, undefined)
  assert.equal(parsed.header.parentSession, 'parent')
  assert.equal(parsed.header.origin, 'subagent')
})

test('the parser rejects a foreign key, a gap, and a bad first seq', () => {
  const withKey = JSON.stringify({ ...HEADER, secret: true })
  assert.throws(() => parseSessionLog(`${withKey}\n`, 'x'), /unsupported key/)
  const gap = `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'a', seq: 1 })}\n`
  assert.throws(() => parseSessionLog(gap, 'x'), /not contiguous|expected 0/)
  const badJson = `${JSON.stringify(HEADER)}\nnot json\n`
  assert.throws(() => parseSessionLog(badJson, 'x'), /not valid JSON/)
})

test('attachment references are collected only from declared carriers', () => {
  const image = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 2, height: 2, bytes: 4, name: 'x.png' }
  const file = { attachmentId: 'sha256:' + 'b'.repeat(64), name: 'notes.pdf', bytes: 9 }
  const log = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: image }, { type: 'file', attachment: file }] } },
    { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'image', attachment: image }] } } },
    { type: 'assistant/attempt', seq: 2, data: { stream: [{ type: 'chunk', chunk: { type: 'block-end', block: { type: 'image', attachment: { ...image, attachmentId: 'sha256:' + 'd'.repeat(64), name: 'y.png' } } } }] } },
    { type: 'unrelated', seq: 3, data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 1, name: 'z.png' } }] } },
  ].map((event) => JSON.stringify(event)).join('\n')
  const { images, files } = attachmentRefsInLog(log)
  assert.equal(images.size, 2)
  assert.equal(files.size, 1)
})

test('title prefers the newest title event and falls back to the first prompt', () => {
  assert.equal(titleOfEvents([{ type: 'session/title', data: { title: '一' } }, { type: 'session/title', data: { title: '二' } }]), '二')
  assert.equal(titleOfEvents([{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '你好世界' }] } } }]), '你好世界')
  assert.equal(titleOfEvents([]), undefined)
})

test('file names are sanitized into one leaf', () => {
  assert.equal(fileLeafName('C:\\a\\b\\报告 final.pdf'), '报告 final.pdf')
  assert.equal(fileLeafName('..'), 'file')
  assert.equal(fileLeafName('a<>b|c.txt'), 'a__b_c.txt')
})

test('manifest round-trips and refuses a foreign kind, newer layout, and bad root', () => {
  const manifest = buildManifest({
    toolVersion: '1.0.0',
    sessionFormatVersion: 4,
    root: 'session-abc',
    title: 't',
    sessions: [{ id: 'session-abc', path: sessionLogPath('session-abc'), events: 2, sha256: 'a'.repeat(64) }],
    attachments: [],
  })
  manifest.kind = PACK_KIND
  const normalized = normalizeManifest(JSON.parse(JSON.stringify(manifest)))
  assert.equal(normalized.root, 'session-abc')
  assert.equal(normalized.source.sessionFormatVersion, 4)
  assert.throws(() => normalizeManifest({ ...manifest, kind: 'other' }), /not a DSH session pack/)
  assert.throws(() => normalizeManifest({ ...manifest, packVersion: 99 }), /newer/)
  assert.throws(() => normalizeManifest({ ...manifest, root: 'session-missing' }), /root/)
  assert.throws(() => normalizeManifest({
    ...manifest,
    sessions: [{ ...manifest.sessions[0], path: 'sessions/other.jsonl' }],
  }), /does not match/)
})
