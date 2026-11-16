/**
 * Host-side pack export and import over the DSH service seams.
 *
 * Export reads one live or cold session, its subagent descendants, and every
 * attachment those logs reference, then writes one `.dshpack` ZIP through
 * {@link ZipWriter}. Import validates that archive, imports the attachments by
 * their content addresses, restores every session through the persistence
 * service, and attaches the root session to a target workspace whose path
 * replaces the recorded source path.
 *
 * The class takes its services from the Cordis context at call time so the
 * plugin can be mounted in deployments that omit some of them, and so tests can
 * pass plain fakes.
 *
 * @module dsh-session-transfer/transfer
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipReader, ZipWriter } from './zip.mjs'
import {
  MANIFEST_NAME,
  attachmentRefsInLog,
  buildManifest,
  digestOfAttachmentId,
  fileEntryPath,
  imageEntryPath,
  normalizeManifest,
  parseSessionLog,
  serializeSessionLog,
  sessionLogPath,
  sha256Hex,
  titleOfEvents,
} from './pack.mjs'

/** Hard cap on one imported archive; kept below the ZIP32 limit. */
export const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024
/** Events appended per durability batch during import. */
const APPEND_BATCH = 2000
/** Attachment-read concurrency during export. */
const READ_CONCURRENCY = 4
/** Attempts to observe a freshly imported header in the workspace registry. */
const ATTACH_ATTEMPTS = 20
/** Delay between attach attempts, in milliseconds. */
const ATTACH_RETRY_MS = 150

/** A failure whose message is meant for the user unchanged. */
export class TransferError extends Error {
  /**
   * @param message - user-facing explanation.
   * @param options - optional machine-readable code and cause.
   */
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'TransferError'
    this.code = options.code ?? 'TRANSFER_FAILED'
  }
}

/** The default DSH home, honoring the documented environment override. */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/** True when `child` is `parent` or below it after resolution. */
export function isInside(parent, child) {
  const relative = resolve(child).toLowerCase().startsWith(`${resolve(parent).toLowerCase()}`)
  if (!relative) return false
  const rest = resolve(child).slice(resolve(parent).length)
  return rest === '' || rest.startsWith('\\') || rest.startsWith('/')
}

/** Read the running DSH package version, best effort. */
export function readDshVersion() {
  const env = process.env.DSH_VERSION
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  const seen = new Set()
  const candidates = [process.argv[1], process.execPath]
  for (const start of candidates) {
    if (typeof start !== 'string') continue
    let directory = dirname(resolve(start))
    for (let depth = 0; depth < 12; depth += 1) {
      if (seen.has(directory)) break
      seen.add(directory)
      const candidate = join(directory, 'package.json')
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
        if (parsed?.name === '@deepseek-ai/dsh' || parsed?.name === 'dsh') {
          if (typeof parsed.version === 'string') return parsed.version
        }
      } catch {
        /* keep walking */
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return undefined
}

/**
 * Detect the mounted persistence backend's current session format version.
 * @param ctx - host context.
 * @param persistence - persistence service.
 * @param probeCwd - directory used to place a probe path on backends that locate by cwd.
 * @returns the format version, or undefined when this build does not expose it.
 */
export function detectFormatVersion(persistence, probeCwd) {
  const direct = persistence?.generationFormat?.currentVersion
  if (Number.isSafeInteger(direct)) return direct
  const locator = persistence?.locate
  if (typeof locator !== 'function') return undefined
  try {
    const located = locator.call(persistence, { id: 'session-probe', cwd: probeCwd })
    const match = /session\.v(\d+)(?:\.jsonl)?(?:\.zstd)?$/u.exec(String(located?.path ?? ''))
    if (match !== null) return Number(match[1])
  } catch {
    /* the backend does not locate by path */
  }
  return undefined
}

/** Parallel map with a small concurrency cap. */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Normalize one attachment source reference into a checked record. */
function imageRecord(ref) {
  const digest = digestOfAttachmentId(ref.attachmentId)
  if (digest === undefined) throw new TransferError(`附件 ${String(ref.attachmentId)} 不是内容寻址的 sha256 对象`)
  return { ref, digest }
}

/** One-line user-facing summary of a failure. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Largest archive path length accepted from a manifest. */
const MAX_PATH_LENGTH = 1024

/** The session-transfer engine. */
export class SessionTransfer {
  /**
   * @param options - host context, logger, and plugin version.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.log = options.log ?? (() => {})
    this.version = options.version ?? '0.0.0'
    this.dshHome = options.dshHome ?? resolveDshHome()
    this.packsDir = join(this.dshHome, 'session-packs')
    this.tmpDir = join(this.dshHome, 'tmp')
  }

  /** The persistence service, or a clear failure. */
  persistence() {
    const value = this.ctx.get('sessionPersistence')
    if (value === undefined) throw new TransferError('当前 DSH 没有挂载会话持久化服务，无法读写会话日志')
    return value
  }

  /** The attachment store, or a clear failure. */
  attachments() {
    const value = this.ctx.get('attachments')
    if (value === undefined) throw new TransferError('当前 DSH 没有挂载附件存储，无法打包或恢复图片和文件')
    return value
  }

  /** Flush a live session through the store's durability barrier. */
  async flushLive(sessionId) {
    const sessions = this.ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (session === undefined) return
    await sessions.flush(session)
  }

  /**
   * Read one stored session through a read handle.
   * @param sessionId - stored session id.
   * @returns header, events, and the inherited prefix length.
   */
  async readSession(sessionId) {
    const persistence = this.persistence()
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      if (String(error?.name) === 'SessionPersistenceNotFoundError') throw new TransferError(`会话 ${sessionId} 不存在，可能已被删除`, { code: 'TRANSFER_SESSION_NOT_FOUND' })
      throw error
    }
    try {
      const seen = await handle.read()
      return {
        header: handle.header,
        events: seen?.events ?? [],
        inheritedEventCount: Number.isSafeInteger(handle.inheritedEventCount) ? handle.inheritedEventCount : 0,
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * List the lineage of one session, root first.
   * @param sessionId - root session id.
   * @param includeDescendants - whether to walk subagent descendants.
   * @returns the ordered session ids.
   */
  async lineageOf(sessionId, includeDescendants) {
    const ids = [sessionId]
    if (!includeDescendants) return ids
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined) return ids
    let traced
    try {
      traced = await sessionQuery.traceSession(sessionId)
    } catch (error) {
      this.log('could not trace subagent descendants', error)
      return ids
    }
    const seen = new Set(ids)
    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return
      for (const node of nodes) {
        const id = node?.session?.header?.id
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
        walk(node?.descendants)
      }
    }
    walk(traced?.descendants)
    return ids
  }

  /**
   * Export one session tree into a `.dshpack` archive.
   * @param options - root session, descendant inclusion, and destination path.
   * @returns pack facts for callers and tools.
   */
  async exportPack(options) {
    const sessionId = options.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TransferError('sessionId 必须是会话 id')
    const destination = options.destination
    if (typeof destination !== 'string' || destination === '') throw new TransferError('导出路径不能为空')
    if (typeof options.ensureWritablePath === 'function') options.ensureWritablePath(destination)
    await mkdir(dirname(destination), { recursive: true })
    const partial = `${destination}.partial-${randomUUID()}`
    const attachments = this.attachments()

    await this.flushLive(sessionId)
    const root = await this.readSession(sessionId)
    const rootTitle = titleOfEvents(root.events)
    const formatVersion = root.header.version
    const ids = await this.lineageOf(sessionId, options.includeDescendants !== false)

    const logs = []
    const images = new Map()
    const files = new Map()
    let first = true
    for (const id of ids) {
      if (!first) await this.flushLive(id)
      const session = first ? root : await this.readSession(id)
      first = false
      const text = serializeSessionLog(session.header, session.events)
      const refs = attachmentRefsInLog(text)
      for (const [key, ref] of refs.images) images.set(key, ref)
      for (const [key, ref] of refs.files) files.set(key, ref)
      logs.push({
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        text,
        eventCount: session.events.length,
        bytes: Buffer.byteLength(text),
        sha256: sha256Hex(Buffer.from(text, 'utf8')),
      })
    }

    const imageRows = []
    for (const ref of images.values()) {
      const { digest } = imageRecord(ref)
      imageRows.push({ ref, digest })
    }
    const fileRows = []
    for (const ref of files.values()) {
      const digest = digestOfAttachmentId(ref.attachmentId)
      if (digest === undefined) throw new TransferError(`文件附件 ${String(ref.attachmentId)} 不是内容寻址的 sha256 对象`)
      if (typeof ref.name !== 'string' || ref.name === '') throw new TransferError(`文件附件 ${String(ref.attachmentId)} 缺少文件名`)
      fileRows.push({ ref, digest })
    }

    const writer = ZipWriter.open(partial)
    let totalBytes = 0
    try {
      const manifest = buildManifest({
        toolVersion: this.version,
        dshVersion: readDshVersion(),
        platform: process.platform,
        sessionFormatVersion: formatVersion,
        root: sessionId,
        ...(rootTitle === undefined ? {} : { title: rootTitle }),
        sessions: logs.map((log) => {
          const header = log.header
          return {
            id: header.id,
            path: sessionLogPath(header.id),
            events: log.eventCount,
            sha256: log.sha256,
            inheritedEventCount: log.inheritedEventCount,
            ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
            ...(header.origin !== undefined ? { origin: header.origin } : {}),
            delegationDepth: header.delegationDepth ?? 0,
            createdAt: header.createdAt,
            ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
            ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
          }
        }),
        attachments: [
          ...imageRows.map(({ ref, digest }) => ({
            kind: 'image',
            attachmentId: ref.attachmentId,
            ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
            ...(Number.isSafeInteger(ref.width) ? { width: ref.width } : {}),
            ...(Number.isSafeInteger(ref.height) ? { height: ref.height } : {}),
            bytes: ref.bytes,
            ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
            path: imageEntryPath(digest, ref.mediaType),
            sha256: digest,
          })),
          ...fileRows.map(({ ref, digest }) => ({
            kind: 'file',
            attachmentId: ref.attachmentId,
            bytes: ref.bytes,
            name: ref.name,
            path: fileEntryPath(digest, ref.name),
            sha256: digest,
          })),
        ],
      })
      writer.addText(MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`)
      for (const log of logs) writer.addText(sessionLogPath(log.header.id), log.text)
      const imageBytes = await mapLimit(imageRows, READ_CONCURRENCY, async ({ ref, digest }) => {
        const stored = await attachments.readImage(ref)
        const data = Buffer.from(stored.data)
        if (sha256Hex(data) !== digest) throw new TransferError(`图片附件 ${ref.attachmentId} 读取后校验失败`)
        return { path: imageEntryPath(digest, ref.mediaType), data }
      })
      for (const row of imageBytes) writer.add(row.path, row.data)
      for (const { ref, digest } of fileRows) {
        const chunks = []
        for await (const chunk of attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
        const data = Buffer.concat(chunks)
        if (sha256Hex(data) !== digest) throw new TransferError(`文件附件 ${ref.attachmentId} 读取后校验失败`)
        writer.add(fileEntryPath(digest, ref.name), data)
      }
      totalBytes = writer.close()
    } catch (error) {
      writer.abort()
      await rm(partial, { force: true }).catch(() => {})
      throw error
    }
    await rm(destination, { force: true }).catch(() => {})
    await rename(partial, destination)
    return {
      ok: true,
      path: destination,
      bytes: totalBytes,
      sessionId,
      title: rootTitle,
      sessions: logs.length,
      images: imageRows.length,
      files: fileRows.length,
      formatVersion,
      events: logs.reduce((sum, log) => sum + log.eventCount, 0),
    }
  }

  /** Workspaces visible to the import picker. */
  listWorkspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new TransferError('当前 DSH 没有挂载工作区服务，无法选择导入目标', { code: 'TRANSFER_WORKSPACE' })
    return registry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessions: typeof workspace.sessionIds?.length === 'number' ? workspace.sessionIds.length : 0,
    }))
  }

  /**
   * Resolve one workspace selector to a workspace entity.
   * @param selector - workspace id, exact canonical path, or exact title.
   * @returns the workspace, or a clear failure.
   */
  resolveWorkspace(selector) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new TransferError('当前 DSH 没有挂载工作区服务，无法选择导入目标', { code: 'TRANSFER_WORKSPACE' })
    const workspaces = registry.list()
    if (workspaces.length === 0) throw new TransferError('当前 DSH 还没有工作区；请先在 DSH 里添加一个工作区再导入', { code: 'TRANSFER_WORKSPACE' })
    if (selector === undefined || selector === null || selector === '') return workspaces[0]
    const text = String(selector)
    const byId = registry.get?.(text)
    if (byId !== undefined) return byId
    const exactPath = workspaces.find((workspace) => resolve(workspace.path) === resolve(text))
    if (exactPath !== undefined) return exactPath
    const byTitle = workspaces.filter((workspace) => workspace.title === text)
    if (byTitle.length === 1) return byTitle[0]
    if (byTitle.length > 1) throw new TransferError(`有多个同名工作区「${text}」，请改用工作区 id 或路径`, { code: 'TRANSFER_WORKSPACE' })
    throw new TransferError(`找不到工作区「${text}」；可用工作区：${workspaces.map((workspace) => workspace.title).join('、')}`, { code: 'TRANSFER_WORKSPACE' })
  }

  /** Write one content-addressed image object next to the attachment store. */
  async importImage(attachments, row, data) {
    const ref = {
      attachmentId: row.attachmentId,
      mediaType: row.mediaType,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      name: row.name,
    }
    if (sha256Hex(data) !== row.sha256) throw new TransferError(`图片附件 ${row.path} 校验失败`, { code: 'TRANSFER_ATTACHMENT' })
    if (data.length !== row.bytes) throw new TransferError(`图片附件 ${row.path} 大小与清单不符`, { code: 'TRANSFER_ATTACHMENT' })
    let hostPath
    try {
      hostPath = attachments.imageHostPath?.(ref)
    } catch (error) {
      throw new TransferError(`无法定位图片附件 ${row.attachmentId} 的存储路径：${messageOf(error)}`, { code: 'TRANSFER_ATTACHMENT' })
    }
    if (typeof hostPath !== 'string' || hostPath === '') throw new TransferError('目标机的附件存储不是文件存储，无法导入图片附件', { code: 'TRANSFER_ATTACHMENT' })
    await mkdir(dirname(hostPath), { recursive: true })
    // Content-addressed: an object with this digest is already the exact bytes,
    // and on Windows renaming over an existing object can fail with EPERM.
    const existing = await readFile(hostPath).catch(() => undefined)
    if (existing !== undefined) {
      if (sha256Hex(existing) !== row.sha256) {
        throw new TransferError(`图片对象 ${hostPath} 已存在但内容不符，无法安全覆盖`, { code: 'TRANSFER_ATTACHMENT' })
      }
      return
    }
    const partial = `${hostPath}.partial-${randomUUID()}`
    await writeFile(partial, data)
    try {
      await rename(partial, hostPath)
    } catch (error) {
      // A concurrent writer may have published the same object first.
      const raced = await readFile(hostPath).catch(() => undefined)
      if (raced !== undefined && sha256Hex(raced) === row.sha256) {
        await rm(partial, { force: true }).catch(() => {})
        return
      }
      await rm(partial, { force: true }).catch(() => {})
      throw new TransferError(`写入图片对象 ${hostPath} 失败：${messageOf(error)}`, { code: 'TRANSFER_ATTACHMENT', cause: error })
    }
  }

  /** Import one verbatim file object through the attachment store API. */
  async importFile(attachments, row, data) {
    if (sha256Hex(data) !== row.sha256) throw new TransferError(`文件附件 ${row.path} 校验失败`, { code: 'TRANSFER_ATTACHMENT' })
    if (data.length !== row.bytes) throw new TransferError(`文件附件 ${row.path} 大小与清单不符`, { code: 'TRANSFER_ATTACHMENT' })
    const ref = { attachmentId: row.attachmentId, name: row.name, bytes: row.bytes }
    const stored = await attachments.saveFile({ data, name: row.name })
    if (String(stored?.attachmentId) !== String(ref.attachmentId) || stored?.name !== ref.name) {
      throw new TransferError(`目标附件存储为 ${row.name} 计算出了不同的内容地址，无法保持会话引用`, { code: 'TRANSFER_ATTACHMENT' })
    }
  }

  /** Available preset ids and the current default, or empty when unmounted. */
  async presetFacts() {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { available: null, defaultId: undefined }
    try {
      const listed = await presets.list()
      const ids = Array.isArray(listed) ? listed.map((row) => row?.id).filter((id) => typeof id === 'string') : []
      const defaultId = typeof presets.defaultId === 'string' ? presets.defaultId : ids[0]
      return { available: new Set(ids), defaultId }
    } catch (error) {
      this.log('could not list agent presets', error)
      return { available: null, defaultId: undefined }
    }
  }

  /**
   * Import one `.dshpack` archive into one workspace.
   * @param options - archive path, workspace selector, and optional title override.
   * @returns the imported root session and its rewritten facts.
   */
  async importPack(options) {
    const packPath = options.path
    if (typeof packPath !== 'string' || packPath === '') throw new TransferError('导入路径不能为空', { code: 'TRANSFER_INPUT' })
    const info = await stat(packPath).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new TransferError(`找不到会话包文件：${packPath}`, { code: 'TRANSFER_INPUT' })
    if (info.size > MAX_PACK_BYTES) throw new TransferError(`会话包超过 ${MAX_PACK_BYTES} 字节上限`, { code: 'TRANSFER_INPUT' })
    const persistence = this.persistence()
    const attachments = this.attachments()
    const workspace = this.resolveWorkspace(options.workspace)
    const targetPath = workspace.path
    const warnings = []

    const archive = new ZipReader(packPath)
    try {
      if (!archive.has(MANIFEST_NAME)) throw new TransferError('这个 ZIP 不是 DSH 会话包：缺少清单文件', { code: 'TRANSFER_PACK_INVALID' })
      let manifest
      try {
        manifest = normalizeManifest(JSON.parse(archive.readText(MANIFEST_NAME)))
      } catch (error) {
        throw error instanceof TransferError ? error : new TransferError(`会话包清单无效：${messageOf(error)}`, { code: 'TRANSFER_PACK_INVALID' })
      }
      for (const row of manifest.sessions) {
        if (row.path.length > MAX_PATH_LENGTH || !archive.has(row.path)) throw new TransferError(`会话包缺少会话日志：${row.path}`, { code: 'TRANSFER_PACK_INVALID' })
      }
      for (const row of manifest.attachments) {
        if (row.path.length > MAX_PATH_LENGTH || !archive.has(row.path)) throw new TransferError(`会话包缺少附件：${row.path}`, { code: 'TRANSFER_PACK_INVALID' })
      }

      const currentTargetFormat = detectFormatVersion(persistence, targetPath)
      const packFormat = manifest.source.sessionFormatVersion
      if (Number.isSafeInteger(packFormat) && Number.isSafeInteger(currentTargetFormat) && packFormat !== currentTargetFormat) {
        throw new TransferError(
          `会话格式不兼容：这个包使用格式 v${packFormat} 导出，当前 DSH 使用 v${currentTargetFormat}。请在相同或更新版本的 DSH 上导入。`,
          { code: 'TRANSFER_FORMAT_MISMATCH' },
        )
      }

      // Verify and parse every member before any write happens.
      const parsed = []
      for (const row of manifest.sessions) {
        const data = archive.read(row.path)
        if (sha256Hex(data) !== row.sha256) throw new TransferError(`会话日志 ${row.path} 校验失败`, { code: 'TRANSFER_PACK_INVALID' })
        const text = data.toString('utf8')
        let log
        try {
          log = parseSessionLog(text, row.path)
        } catch (error) {
          throw new TransferError(`会话日志无法解析：${messageOf(error)}`, { code: 'TRANSFER_PACK_INVALID' })
        }
        if (log.header.id !== row.id) throw new TransferError(`会话日志 ${row.path} 的 id 与清单不符`, { code: 'TRANSFER_PACK_INVALID' })
        if (log.events.length !== row.events) throw new TransferError(`会话日志 ${row.path} 的事件数与清单不符`, { code: 'TRANSFER_PACK_INVALID' })
        const version = log.header.version
        if (Number.isSafeInteger(currentTargetFormat) && version !== currentTargetFormat) {
          throw new TransferError(`会话 ${row.id} 使用格式 v${version}，当前 DSH 使用 v${currentTargetFormat}，无法导入`, { code: 'TRANSFER_FORMAT_MISMATCH' })
        }
        parsed.push({ row, log, text })
      }

      const { available: presets, defaultId } = await this.presetFacts()
      const idMap = new Map()
      const taken = new Set()
      for (const { row } of parsed) {
        let id = row.id
        let existing = false
        try {
          existing = (await persistence.stat(id)) !== undefined
        } catch (error) {
          if (String(error?.name) !== 'SessionPersistenceNotFoundError') throw error
        }
        if (existing || taken.has(id)) {
          let minted = `session-${randomUUID()}`
          while (taken.has(minted)) minted = `session-${randomUUID()}`
          warnings.push(`会话 ${id} 在本机已存在，已作为副本导入为 ${minted}`)
          id = minted
        }
        taken.add(id)
        idMap.set(row.id, id)
      }

      for (const entry of parsed) {
        const header = entry.log.header
        if (typeof header.agentPreset === 'string' && presets !== null && !presets.has(header.agentPreset)) {
          const replacement = typeof defaultId === 'string' && presets.has(defaultId) ? defaultId : undefined
          if (replacement !== undefined) {
            warnings.push(`预设「${header.agentPreset}」在本机不存在，导入的会话改用「${replacement}」`)
            header.agentPreset = replacement
          } else {
            warnings.push(`预设「${header.agentPreset}」在本机不存在，导入的会话没有可用的替代预设`)
            delete header.agentPreset
          }
        }
      }

      // Attachments first: a session log that names a missing object would render broken.
      const attachmentRows = manifest.attachments
      if (options.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          sessionId: idMap.get(manifest.root) ?? manifest.root,
          ...(manifest.title === undefined ? {} : { title: manifest.title }),
          workspaceId: workspace.id,
          workspacePath: targetPath,
          sessions: parsed.map((entry) => ({
            id: idMap.get(entry.log.header.id) ?? entry.log.header.id,
            originalId: entry.log.header.id,
            events: entry.log.events.length,
          })),
          events: parsed.reduce((sum, entry) => sum + entry.log.events.length, 0),
          attachments: attachmentRows.length,
          source: {
            ...(typeof manifest.source.dshVersion === 'string' ? { dshVersion: manifest.source.dshVersion } : {}),
            ...(typeof manifest.source.platform === 'string' ? { platform: manifest.source.platform } : {}),
            ...(Number.isSafeInteger(manifest.source.sessionFormatVersion) ? { sessionFormatVersion: manifest.source.sessionFormatVersion } : {}),
          },
          packCreatedAt: manifest.createdAt,
          warnings,
        }
      }
      for (const row of attachmentRows) {
        const data = archive.read(row.path)
        if (row.kind === 'image') await this.importImage(attachments, row, data)
        else await this.importFile(attachments, row, data)
      }

      // Restore sessions in manifest order (the exporter writes root first, then descendants).
      const created = []
      for (const entry of parsed) {
        const oldId = entry.log.header.id
        const newId = idMap.get(oldId) ?? oldId
        const { type: _diskType, ...meta } = entry.log.header
        const header = {
          ...meta,
          id: newId,
          cwd: targetPath,
          ...(entry.log.header.parentSession !== undefined && idMap.has(entry.log.header.parentSession)
            ? { parentSession: idMap.get(entry.log.header.parentSession) }
            : {}),
        }
        const events = newId === oldId ? entry.log.events : remapEventIds(entry.log.events, oldId, newId)
        const handle = await persistence.create(header, { inheritedEventCount: entry.row.inheritedEventCount ?? 0 })
        try {
          for (let offset = 0; offset < events.length; offset += APPEND_BATCH) {
            await handle.append(events.slice(offset, offset + APPEND_BATCH))
          }
          await handle.flush()
        } catch (error) {
          throw new TransferError(`写入会话 ${newId} 失败：${messageOf(error)}`, { code: 'TRANSFER_WRITE' })
        } finally {
          await handle.close()
        }
        // Read the session back through a fresh handle before reporting success:
        // a silently truncated log would otherwise look imported but open empty.
        await verifyRestoredLog(this, {
          sessionId: newId,
          targetPath,
          expected: { header, events },
        })
        created.push({ oldId, newId, events: events.length })
      }

      const root = idMap.get(manifest.root) ?? manifest.root
      let attached = false
      for (let attempt = 0; attempt < ATTACH_ATTEMPTS && !attached; attempt += 1) {
        try {
          await workspace.attachSession(root)
          attached = true
        } catch (error) {
          if (attempt === ATTACH_ATTEMPTS - 1) {
            warnings.push(`会话已导入，但未能挂到工作区「${workspace.title}」：${messageOf(error)}`)
          } else {
            await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_MS))
          }
        }
      }

      return {
        ok: true,
        sessionId: root,
        ...(manifest.title === undefined ? {} : { title: manifest.title }),
        workspaceId: workspace.id,
        workspacePath: targetPath,
        sessions: created,
        attachments: attachmentRows.length,
        warnings,
      }
    } finally {
      archive.close()
    }
  }

  /**
   * Copy one completed pack file into the browser response.
   * @param path - pack path.
   * @param response - Node response owning the socket.
   */
  async sendFile(path, response) {
    await pipeline(createReadStream(path), response)
  }
}

/**
 * Read one freshly imported session back and compare it with what was written.
 * @param transfer - the engine owning the persistence service.
 * @param check - session id, expected target path, and the header/events written.
 * @throws {TransferError} when the stored log differs from the written one.
 */
async function verifyRestoredLog(transfer, check) {
  const expectedText = serializeSessionLog(check.expected.header, check.expected.events)
  const expectedSha = sha256Hex(Buffer.from(expectedText, 'utf8'))
  let restored
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      restored = await transfer.readSession(check.sessionId)
      break
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
  if (restored === undefined) {
    throw new TransferError(`会话 ${check.sessionId} 写入后无法读回：${messageOf(lastError)}`, { code: 'TRANSFER_WRITE' })
  }
  const actualText = serializeSessionLog(restored.header, restored.events)
  const actualSha = sha256Hex(Buffer.from(actualText, 'utf8'))
  if (restored.header.id !== check.sessionId || restored.header.cwd !== check.targetPath || actualSha !== expectedSha) {
    throw new TransferError(
      `会话 ${check.sessionId} 导入后读回校验失败：写入 ${check.expected.events.length} 条事件，读回 ${restored.events.length} 条`,
      { code: 'TRANSFER_WRITE' },
    )
  }
}

/** Rewrite only the bookkeeping fields that name the session itself. */
function remapEventIds(events, oldId, newId) {
  const out = []
  for (const event of events) {
    if (event?.type === 'session-log-deepseek/delivery-accepted' && event.data?.sessionId === oldId) {
      out.push({ ...event, data: { ...event.data, sessionId: newId } })
      continue
    }
    out.push(event)
  }
  return out
}

/** Compute a download filename for one pack. */
export function packFilename(title, sessionId) {
  const base = typeof title === 'string' && title.trim() !== ''
    ? title.trim().replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 60)
    : `session-${String(sessionId).replace(/^session-/u, '').slice(0, 8)}`
  return `${base === '' ? 'session' : base}.dshpack`
}

/** Content-Disposition header value with an ASCII and an RFC 5987 form. */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
