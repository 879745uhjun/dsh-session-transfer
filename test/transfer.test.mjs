import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  persistence.seed({
    type: 'session',
    version: 4,
    id: 'session-boxmate',
    createdAt: 1792485281000,
    cwd: 'D:\\source work',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }, [
    { type: 'session/title', seq: 0, time: 5, data: { title: '盒友会话' } },
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

/** In-memory boxes bridge used by the whole-box tests. */
class FakeBoxes {
  constructor(state = { boxes: [], memberships: {}, pins: {} }) {
    this.current = structuredClone(state)
    this.created = []
    this.assigned = []
    this.sequence = 0
  }

  async state() {
    return structuredClone(this.current)
  }

  async create({ name, color, parentId, header }) {
    const id = `box-${++this.sequence}`
    this.current.boxes.push({ id, name, parentId: parentId ?? null, color: color ?? 'blue', order: 0, collapsed: false, ...(header === undefined ? {} : { header }) })
    this.created.push({ id, name, parentId: parentId ?? null })
    return id
  }

  async assign(sessionId, boxIds) {
    this.assigned.push({ sessionId, boxIds })
    this.current.memberships[sessionId] = [...boxIds]
  }
}

function makeBoxSource(temp) {
  const source = makeSource(temp)
  const workspaceRegistry = {
    list: () => [{ id: 'ws-source', title: 'source', path: 'D:\\source work', sessionIds: ['session-root', 'session-boxmate'] }],
    get: () => undefined,
  }
  const ctx = fakeCtx({
    sessionPersistence: source.persistence,
    attachments: source.attachments,
    sessionQuery: fakeSessionQuery(source.persistence),
    workspaceRegistry,
  })
  return { ...source, ctx }
}

function boxState() {
  return {
    boxes: [{ id: 'box-1', name: '插件制作', color: 'purple', order: 2, collapsed: false, parentId: null, header: { count: true } }],
    memberships: { 'session-root': ['box-1'], 'session-boxmate': ['box-1'] },
    pins: { 'box-1': ['session-boxmate'] },
  }
}

test('exports a whole box as a v2 pack with its descriptor', async () => {
  await withTempDir(async (temp) => {
    const source = makeBoxSource(temp)
    const exporter = new SessionTransfer({
      ctx: source.ctx,
      dshHome: join(temp, 'home-a'),
      version: '1.1.0',
      boxesClient: new FakeBoxes(boxState()),
    })
    const packPath = join(temp, 'box.dshpack')
    const exported = await exporter.exportBox({ box: 'box-1', destination: packPath, includeDescendants: true })
    assert.equal(exported.ok, true)
    assert.deepEqual(exported.roots, ['session-boxmate', 'session-root'])
    const archive = new ZipReader(packPath)
    const manifest = JSON.parse(archive.readText(MANIFEST_NAME))
    archive.close()
    assert.equal(manifest.packVersion, 2)
    assert.deepEqual(manifest.roots, ['session-boxmate', 'session-root'])
    assert.equal(manifest.box.name, '插件制作')
    assert.equal(manifest.box.color, 'purple')
    assert.deepEqual(manifest.box.pinned, ['session-boxmate'])
    assert.equal(manifest.sessions.length, 3)
  })
})

test('imports a v2 box pack, assigns every new id, and notes pins', async () => {
  await withTempDir(async (temp) => {
    const source = makeBoxSource(temp)
    const exporter = new SessionTransfer({
      ctx: source.ctx,
      dshHome: join(temp, 'home-a'),
      version: '1.1.0',
      boxesClient: new FakeBoxes(boxState()),
    })
    const packPath = join(temp, 'box.dshpack')
    await exporter.exportBox({ box: '插件制作', destination: packPath })

    const targetBoxes = new FakeBoxes()
    const targetPersistence = new FakePersistence()
    const workspace = fakeWorkspace('ws', 'target', 'D:\\target ws')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: targetPersistence,
        attachments: new FakeAttachments(join(temp, 'target-att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
      boxesClient: targetBoxes,
    })
    const imported = await importer.importPack({ path: packPath, workspace: 'ws', boxMode: 'reuse' })
    assert.equal(imported.ok, true)
    assert.equal(imported.roots.length, 2)
    assert.equal(workspace.sessionIds.length, 2)
    assert.equal(imported.box.available, true)
    assert.equal(imported.box.counts.create, 1)
    assert.equal(imported.boxResult.ok, true)
    assert.equal(imported.boxResult.results.length, 2)
    assert.ok(imported.boxResult.results.every((row) => row.ok))
    assert.ok(imported.warnings.includes('置顶顺序未迁移'))
    assert.deepEqual(targetBoxes.created.map((row) => row.name), ['插件制作'])
    assert.equal(targetBoxes.assigned.length, 2)
    assert.ok(targetBoxes.assigned.every((row) => row.boxIds[0] === 'box-1'))
  })
})

test('copy mode creates a suffixed box and leaves the original untouched', async () => {
  await withTempDir(async (temp) => {
    const source = makeBoxSource(temp)
    const exporter = new SessionTransfer({
      ctx: source.ctx,
      dshHome: join(temp, 'home-a'),
      version: '1.1.0',
      boxesClient: new FakeBoxes(boxState()),
    })
    const packPath = join(temp, 'box.dshpack')
    await exporter.exportBox({ box: 'box-1', destination: packPath })

    const targetBoxes = new FakeBoxes({
      boxes: [{ id: 'existing', name: '插件制作', color: 'red', order: 9, collapsed: true, parentId: null }],
      memberships: {},
      pins: {},
    })
    const workspace = fakeWorkspace('ws', 'target', 'D:\\target ws')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: new FakePersistence(),
        attachments: new FakeAttachments(join(temp, 'target-att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
      boxesClient: targetBoxes,
    })
    const imported = await importer.importPack({ path: packPath, workspace: 'ws', boxMode: 'copy' })
    assert.equal(imported.box.mode, 'copy')
    assert.deepEqual(targetBoxes.created.map((row) => row.name), ['插件制作（导入）'])
    const existing = targetBoxes.current.boxes.find((box) => box.id === 'existing')
    assert.equal(existing.color, 'red')
    assert.equal(existing.order, 9)
    assert.equal(existing.collapsed, true)
  })
})

test('a v2 pack still imports when the boxes bridge is unavailable', async () => {
  await withTempDir(async (temp) => {
    const source = makeBoxSource(temp)
    const exporter = new SessionTransfer({
      ctx: source.ctx,
      dshHome: join(temp, 'home-a'),
      version: '1.1.0',
      boxesClient: new FakeBoxes(boxState()),
    })
    const packPath = join(temp, 'box.dshpack')
    await exporter.exportBox({ box: 'box-1', destination: packPath })

    const workspace = fakeWorkspace('ws', 'target', 'D:\\target ws')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: new FakePersistence(),
        attachments: new FakeAttachments(join(temp, 'target-att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    const imported = await importer.importPack({ path: packPath, workspace: 'ws' })
    assert.equal(imported.ok, true)
    assert.equal(imported.box.available, false)
    assert.ok(imported.box.counts.skip >= 1)
    assert.ok(imported.warnings.some((warning) => warning.includes('未归盒')))
    assert.equal(workspace.sessionIds.length, 2)
  })
})

test('an ASCII fallback name replaces an all-CJK Content-Disposition name', async () => {
  const { asciiPackFilename, contentDisposition } = await import('../lib/transfer.mjs')
  assert.equal(asciiPackFilename('会话打包', 'session-abcdef12'), 'session-abcdef12.dshpack')
  assert.equal(asciiPackFilename('My Pack', 'session-abcdef12'), 'My Pack.dshpack')
  const header = contentDisposition('会话打包.dshpack', asciiPackFilename('会话打包', 'session-abcdef12'))
  assert.ok(header.includes('filename="session-abcdef12.dshpack"'))
  assert.ok(header.includes("filename*=UTF-8''"))
})

test('createWorkspace creates the directory and calls the registry', async () => {
  await withTempDir(async (temp) => {
    const created = []
    const registry = {
      create: async (path, title) => {
        created.push({ path, title })
        return { id: 'ws-new', title: title ?? 'new', path }
      },
    }
    const transfer = new SessionTransfer({ ctx: fakeCtx({ workspaceRegistry: registry }), dshHome: join(temp, 'home') })
    const target = join(temp, 'fresh workspace')
    const workspace = await transfer.createWorkspace(target, '测试工作区')
    assert.equal(workspace.id, 'ws-new')
    assert.equal((await stat(target)).isDirectory(), true)
    assert.deepEqual(created, [{ path: target, title: '测试工作区' }])
    await assert.rejects(() => transfer.createWorkspace('relative/path'), /绝对路径/)
  })
})

test('importPack reports attachment, session, and completion progress', async () => {
  await withTempDir(async (temp) => {
    const source = makeSource(temp)
    const packPath = join(temp, 'pack.dshpack')
    const exporter = new SessionTransfer({ ctx: source.ctx, dshHome: join(temp, 'home-a'), version: '1.2.0' })
    await exporter.exportPack({ sessionId: 'session-root', includeDescendants: true, destination: packPath })

    const workspace = fakeWorkspace('ws', 'target', 'D:\\target ws')
    const importer = new SessionTransfer({
      ctx: fakeCtx({
        sessionPersistence: new FakePersistence(),
        attachments: new FakeAttachments(join(temp, 'target-att')),
        workspaceRegistry: { list: () => [workspace], get: () => workspace },
      }),
      dshHome: join(temp, 'home-b'),
    })
    const phases = []
    const imported = await importer.importPack({ path: packPath, workspace: 'ws', onProgress: (snapshot) => phases.push(snapshot) })
    assert.equal(imported.ok, true)
    assert.ok(phases.some((row) => row.phase === 'attachments' && row.total >= 1))
    assert.ok(phases.some((row) => row.phase === 'sessions' && row.total === 2 && row.done === 2))
    assert.equal(phases.at(-1).phase, 'done')
  })
})
