import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ZipReader } from '../lib/zip.mjs'
import { MANIFEST_NAME, serializeSessionLog } from '../lib/pack.mjs'
import { SessionTransfer, TransferError } from '../lib/transfer.mjs'

const sha = (data) => createHash('sha256').update(data).digest('hex')

/** In-memory persistence with the surface SessionTransfer uses. */
class FakePersistence {
  constructor(options = {}) {
    this.sessions = new Map()
    this.currentVersion = options.currentVersion ?? 4
    this.generationFormat = { currentVersion: this.currentVersion }
  }

  seed(header, events) {
    this.sessions.set(header.id, { header: { ...header }, events: events.map((event) => structuredClone(event)) })
  }

  async open(id) {
    const record = this.sessions.get(id)
    if (record === undefined) throw notFound(id)
    return {
      header: { ...record.header },
      inheritedEventCount: 0,
      async read() {
        return { eventState: 'current', events: record.events.map((event) => structuredClone(event)) }
      },
      async close() {},
    }
  }

  async create(header) {
    if (Object.hasOwn(header, 'type')) {
      const error = new Error('format v4 header has unexpected field type')
      error.name = 'SessionFormatError'
      throw error
    }
    if (this.sessions.has(header.id)) {
      const error = new Error(`session "${header.id}" already exists`)
      error.name = 'SessionAlreadyExistsError'
      throw error
    }
    if (header.version !== this.currentVersion) {
      const error = new Error(`installed Session format is v${this.currentVersion}, got v${header.version}`)
      error.name = 'Error'
      throw error
    }
    const record = { header: { ...header }, events: [] }
    this.sessions.set(header.id, record)
    return {
      header: record.header,
      inheritedEventCount: 0,
      async read() {
        return { eventState: 'current', events: record.events.map((event) => structuredClone(event)) }
      },
      async append(events) {
        for (const event of events) {
          assert.equal(event.seq, record.events.length, 'append must stay contiguous')
          record.events.push(structuredClone(event))
        }
      },
      async flush() {},
      async close() {},
    }
  }

  async stat(id) {
    const record = this.sessions.get(id)
    if (record === undefined) throw notFound(id)
    return { id, cwd: record.header.cwd, version: record.header.version }
  }

  locate(meta) {
    return { kind: 'jsonl', path: `sessions/${meta.id}/session.v4.jsonl.zstd` }
  }
}


/** Fail when any nested value is explicitly undefined (tool outputs must be lossless JSON). */
function assertJsonClean(value, path = 'root') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((item, index) => assertJsonClean(item, `${path}[${index}]`)); return }
  for (const [key, nested] of Object.entries(value)) assertJsonClean(nested, `${path}.${key}`)
}

function notFound(id) {
  const error = new Error(`session "${id}" not found`)
  error.name = 'SessionPersistenceNotFoundError'
  return error
}

/** In-memory attachment store with a host-file-backed image root. */
class FakeAttachments {
  constructor(root) {
    this.root = root
    this.images = new Map()
    this.files = new Map()
  }

  seedImage(data, mediaType = 'image/png') {
    const digest = sha(data)
    const ref = { attachmentId: `sha256:${digest}`, mediaType, width: 2, height: 2, bytes: data.length, name: 'shot.png' }
    this.images.set(ref.attachmentId, data)
    return ref
  }

  seedFile(data, name) {
    const ref = { attachmentId: `sha256:${sha(data)}`, name, bytes: data.length }
    this.files.set(`${ref.attachmentId}\u0000${name}`, data)
    return ref
  }

  imageHostPath(ref) {
    const digest = String(ref.attachmentId).replace(/^sha256:/u, '')
    return join(this.root, 'objects', digest.slice(0, 2), digest)
  }

  async readImage(ref) {
    const data = this.images.get(ref.attachmentId)
    if (data === undefined) throw new Error(`missing image ${ref.attachmentId}`)
    return { ref, data }
  }

  async *readFileStream(ref) {
    const data = this.files.get(`${ref.attachmentId}\u0000${ref.name}`)
    if (data === undefined) throw new Error(`missing file ${ref.name}`)
    yield data
  }

  async saveFile(input) {
    const digest = sha(input.data)
    const ref = { attachmentId: `sha256:${digest}`, name: input.name, bytes: input.data.length }
    this.files.set(`${ref.attachmentId}\u0000${ref.name}`, input.data)
    return ref
  }
}

/** Descendants traced from the parentSession header field. */
function fakeSessionQuery(persistence) {
  return {
    async traceSession(rootId) {
      const children = [...persistence.sessions.values()].filter((record) => record.header.parentSession === rootId)
      return {
        ancestry: [],
        descendants: children.map((record) => ({
          session: { header: record.header },
          descendants: [],
        })),
      }
    },
  }
}

function fakeWorkspace(id, title, path) {
  return {
    id,
    title,
    path,
    sessionIds: [],
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
    },
  }
}

function fakeCtx(services) {
  return { get: (name) => services[name] }
}

function makeSource(temp) {
  const persistence = new FakePersistence()
  const attachments = new FakeAttachments(join(temp, 'source-attachments'))
  const image = attachments.seedImage(Buffer.from('PNGDATA-' + 'x'.repeat(64)))
  const file = attachments.seedFile(Buffer.from('%PDF-1.7 fake'), 'notes.pdf')
  const rootHeader = {
    type: 'session',
    version: 4,
    id: 'session-root',
    createdAt: 1792485279825,
    cwd: 'D:\\source work',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const childHeader = {
    type: 'session',
    version: 4,
    id: 'session-child',
    createdAt: 1792485280000,
    cwd: 'D:\\source work',
    parentSession: 'session-root',
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'standard',
  }
  persistence.seed(rootHeader, [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'session/title', seq: 1, time: 2, data: { title: '搬家的会话' } },
    {
      type: 'user/message',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        content: [
            { type: 'text', text: '看这两份附件' },
            { type: 'image', attachment: image },
          { type: 'file', attachment: file },
        ],
        role: 'user',
      },
    },
  ])
  persistence.seed(childHeader, [
    { type: 'session/title', seq: 0, time: 4, data: { title: '子会话' } },
  ])
  return {
    persistence,
    attachments,
    ctx: fakeCtx({ sessionPersistence: persistence, attachments, sessionQuery: fakeSessionQuery(persistence) }),
  }
}

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'dst-transfer-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('exports a session tree with its attachments and imports it into another workspace', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    const exported = await exporter.exportPack({ sessionId: 'session-root', includeDescendants: true, destination: packPath })
    assert.equal(exported.sessions, 2)
    assert.equal(exported.images, 1)
    assert.equal(exported.files, 1)
    assert.equal(exported.title, '搬家的会话')
    assertJsonClean(exported)

    const archive = new ZipReader(packPath)
    const manifest = JSON.parse(archive.readText(MANIFEST_NAME))
    assert.equal(manifest.kind, 'dsh-session-pack')
    assert.equal(manifest.root, 'session-root')
    assert.equal(manifest.source.sessionFormatVersion, 4)
    assert.deepEqual(archive.names().filter((name) => name.startsWith('sessions/')).length, 2)
    archive.close()

    const targetPersistence = new FakePersistence()
    const targetAttachments = new FakeAttachments(join(temp, 'target-attachments'))
    const workspace = fakeWorkspace('ws-target', 'target', 'D:\\target ws')
    const registry = { list: () => [workspace], get: (id) => (id === workspace.id ? workspace : undefined) }
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: targetPersistence,
        attachments: targetAttachments,
        workspaceRegistry: registry,
        agentPresets: {
          defaultId: 'ops-ptc',
          list: async () => [{ id: 'ops-ptc' }],
        },
      }),
      dshHome: join(temp, 'home-b'),
      version: '1.0.0',
    })

    const imported = await importer.importPack({ path: packPath, workspace: workspace.id })
    assert.equal(imported.sessionId, 'session-root')
    assert.equal(imported.workspacePath, 'D:\\target ws')
    assert.ok(imported.warnings.some((warning) => warning.includes('预设')))

    const root = targetPersistence.sessions.get('session-root')
    const child = targetPersistence.sessions.get('session-child')
    assert.equal(root.header.cwd, 'D:\\target ws')
    assert.equal(child.header.cwd, 'D:\\target ws')
    assert.equal(root.header.agentPreset, 'ops-ptc')
    const sourceRefs = source.persistence.sessions.get('session-root').events[2].data.content
    assert.equal(root.events[2].data.content[1].type, 'image')
    assert.equal(root.events[2].data.content[1].attachment.attachmentId, sourceRefs[1].attachment.attachmentId)
    assert.equal(root.events[2].data.content[2].attachment.attachmentId, sourceRefs[2].attachment.attachmentId)
    assert.equal(root.events[1].data.title, '搬家的会话')
    assert.deepEqual(workspace.sessionIds, ['session-root'])

    const imageBytes = await readFile(targetAttachments.imageHostPath(root.events[2].data.content[1].attachment))
    assert.ok(imageBytes.length > 0)
    assert.ok(targetAttachments.files.size === 1)
  })
})

test('re-importing the same pack mints new ids and remaps parentSession', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: true, destination: packPath })

    const targetPersistence = new FakePersistence()
    const targetAttachments = new FakeAttachments(join(temp, 'target-attachments'))
    const first = fakeWorkspace('ws-1', 'one', 'D:\\ws one')
    const second = fakeWorkspace('ws-2', 'two', 'D:\\ws two')
    const registry = { list: () => [first, second], get: (id) => [first, second].find((workspace) => workspace.id === id) }
    const importer = new SessionTransfer({
      ctx: fakeCtx({ sessionPersistence: targetPersistence, attachments: targetAttachments, workspaceRegistry: registry }),
      dshHome: join(temp, 'home-b'),
      version: '1.0.0',
    })
    const importedFirst = await importer.importPack({ path: packPath, workspace: 'ws-1' })
    const importedSecond = await importer.importPack({ path: packPath, workspace: 'ws-2' })
    assert.equal(importedSecond.sessionId === importedFirst.sessionId, false)
    assert.ok(importedSecond.warnings.some((warning) => warning.includes('副本')))
    const restored = targetPersistence.sessions.get(importedSecond.sessionId)
    assert.ok(restored)
    const child = [...targetPersistence.sessions.values()].find((record) => record.header.parentSession === importedSecond.sessionId)
    assert.ok(child, 'child session parentSession must follow the new root id')
    assert.deepEqual(second.sessionIds, [importedSecond.sessionId])
    assert.deepEqual(first.sessionIds, [importedFirst.sessionId])
  })
})

test('dryRun validates and plans without writing', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: true, destination: packPath })
    const targetPersistence = new FakePersistence()
    const workspace = fakeWorkspace('ws', 'w', 'D:\\w')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: targetPersistence,
        attachments: new FakeAttachments(join(temp, 'att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    const planned = await importer.importPack({ path: packPath, workspace: 'ws', dryRun: true })
    assert.equal(planned.dryRun, true)
    assertJsonClean(planned)
    assert.equal(planned.sessions.length, 2)
    assert.equal(targetPersistence.sessions.size, 0)
    assert.deepEqual(workspace.sessionIds, [])
  })
})

test('refuses a pack from another session format generation', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', destination: packPath })
    const targetPersistence = new FakePersistence({ currentVersion: 3 })
    const workspace = fakeWorkspace('ws', 'w', 'D:\\w')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: targetPersistence,
        attachments: new FakeAttachments(join(temp, 'att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    await assert.rejects(
      () => importer.importPack({ path: packPath, workspace: 'ws' }),
      (error) => error instanceof TransferError && error.code === 'TRANSFER_FORMAT_MISMATCH',
    )
    assert.equal(targetPersistence.sessions.size, 0)
  })
})

test('a session log keeps its events verbatim across the round trip', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: false, destination: packPath })
    const archive = new ZipReader(packPath)
    const text = archive.readText('sessions/session-root.jsonl')
    archive.close()
    const original = source.persistence.sessions.get('session-root')
    assert.equal(text, serializeSessionLog(original.header, original.events))
  })
})

test('reuses an image object that already exists with the same content', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: false, destination: packPath })
    const archive = new ZipReader(packPath)
    const manifest = JSON.parse(archive.readText(MANIFEST_NAME))
    const imageRow = manifest.attachments.find((row) => row.kind === 'image')
    assert.ok(imageRow)
    const bytes = archive.read(imageRow.path)
    archive.close()

    const targetAttachments = new FakeAttachments(join(temp, 'target-attachments'))
    const hostPath = targetAttachments.imageHostPath({ attachmentId: imageRow.attachmentId })
    await mkdir(dirname(hostPath), { recursive: true })
    await writeFile(hostPath, bytes)

    const workspace = fakeWorkspace('ws', 'w', 'D:\\w')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: new FakePersistence(),
        attachments: targetAttachments,
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    const imported = await importer.importPack({ path: packPath, workspace: 'ws' })
    assert.equal(imported.ok, true)
  })
})

test('refuses to overwrite an image object whose content differs from its digest', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.0.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: false, destination: packPath })
    const archive = new ZipReader(packPath)
    const manifest = JSON.parse(archive.readText(MANIFEST_NAME))
    const imageRow = manifest.attachments.find((row) => row.kind === 'image')
    archive.close()

    const targetAttachments = new FakeAttachments(join(temp, 'target-attachments'))
    const hostPath = targetAttachments.imageHostPath({ attachmentId: imageRow.attachmentId })
    await mkdir(dirname(hostPath), { recursive: true })
    await writeFile(hostPath, Buffer.from('not the stored object'))

    const workspace = fakeWorkspace('ws', 'w', 'D:\\w')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: new FakePersistence(),
        attachments: targetAttachments,
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    await assert.rejects(
      () => importer.importPack({ path: packPath, workspace: 'ws' }),
      (error) => error instanceof TransferError && error.code === 'TRANSFER_ATTACHMENT',
    )
  })
})
