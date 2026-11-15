/**
 * Pack layout, manifest schema, and the canonical session-log codec.
 *
 * A pack is one ZIP archive:
 *   dsh-session-pack.json          manifest (format version, sessions, attachments)
 *   sessions/<safe-session-id>.jsonl   canonical JSONL, header line then events
 *   attachments/images/<sha256>.<ext>  normalized image bytes as stored
 *   attachments/files/<sha256>/<name>  verbatim file bytes as stored
 *
 * The session log keeps the DSH physical format's logical form: the same header
 * keys the persistence backend accepts and the committed events in seq order.
 * Everything else about the source machine (workspace path, preset, id) is
 * rewritten on import; see `index.js`.
 *
 * @module dsh-session-transfer/pack
 */
import { createHash } from 'node:crypto'

/** Manifest file name at the archive root. */
export const MANIFEST_NAME = 'dsh-session-pack.json'
/** Manifest `kind` value identifying this pack family. */
export const PACK_KIND = 'dsh-session-pack'
/** Highest pack layout version this build reads and writes. */
export const PACK_VERSION = 1
/** Header keys the persistence backend accepts, exactly. */
const HEADER_REQUIRED_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
const HEADER_OPTIONAL_KEYS = ['cwd', 'parentSession', 'origin', 'agentPreset']
const HEADER_KEYS = new Set([...HEADER_REQUIRED_KEYS, ...HEADER_OPTIONAL_KEYS])
/** Accepted raster media types and their archive extension. */
export const MEDIA_TYPE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})
/** Longest session id accepted from a manifest. */
const MAX_ID_LENGTH = 200
/** Longest log line accepted while parsing a pack. */
const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Collapse an untrusted session id into one safe path segment. */
export function safeSessionSegment(id) {
  const text = String(id)
  if (text.length === 0) throw new Error('session id must not be empty')
  const safe = text.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe.length === 0 ? 'session' : safe.slice(0, 120)
}

/** Archive path of one session's canonical log. */
export function sessionLogPath(id) {
  return `sessions/${safeSessionSegment(id)}.jsonl`
}

/** Archive path of one normalized image object. */
export function imageEntryPath(hex, mediaType) {
  const extension = MEDIA_TYPE_EXTENSIONS[mediaType]
  if (extension === undefined) throw new Error(`unsupported image media type ${JSON.stringify(mediaType)}`)
  return `attachments/images/${hex}.${extension}`
}

/** Sanitize one display name into a safe, non-empty leaf name. */
export function fileLeafName(value) {
  const raw = typeof value === 'string' ? value : ''
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (clean === '' || clean === '.' || clean === '..') return 'file'
  return Array.from(clean).slice(0, 120).join('')
}

/** Archive path of one verbatim file object. */
export function fileEntryPath(hex, name) {
  return `attachments/files/${hex}/${fileLeafName(name)}`
}

/** SHA-256 hex digest of a buffer. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Parse one `sha256:<hex>` attachment id into its hex digest, or reject it. */
export function digestOfAttachmentId(value) {
  if (typeof value !== 'string') return undefined
  const match = /^sha256:([a-f0-9]{64})$/u.exec(value)
  return match?.[1]
}

/**
 * Serialize one session as canonical JSONL: the header line, then one line per
 * committed event, with a trailing newline.
 * @param header - session metadata from a persistence read handle.
 * @param events - committed events in seq order.
 * @returns the UTF-8 log text.
 */
export function serializeSessionLog(header, events) {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
      ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
      isSeeded: header.isSeeded === true,
      ...(header.origin !== undefined ? { origin: header.origin } : {}),
      delegationDepth: header.delegationDepth ?? 0,
      ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
    }),
  ]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Parse one canonical session log.
 * @param text - archive log text.
 * @param source - archive path used in diagnostics.
 * @returns the header and its committed events.
 * @throws when the header or the event envelope sequence is malformed.
 */
export function parseSessionLog(text, source) {
  if (typeof text !== 'string' || text.length === 0) throw new Error(`${source}: session log is empty`)
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error(`${source}: session log is empty`)
  if (lines[0].length > MAX_LINE_BYTES) throw new Error(`${source}: header line is too long`)
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw new Error(`${source}: header line is not valid JSON`)
  }
  header = normalizeHeader(header, source)
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length > MAX_LINE_BYTES) throw new Error(`${source}: event line ${index} is too long`)
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`${source}: event line ${index} is not valid JSON`)
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Error(`${source}: event line ${index} is not an object`)
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error(`${source}: event line ${index} has an invalid seq`)
    if (events.length > 0 && event.seq !== events.length) throw new Error(`${source}: event seq ${event.seq} at line ${index} is not contiguous`)
    events.push(event)
  }
  if (events.length > 0 && events[0].seq !== 0) throw new Error(`${source}: first event seq is ${events[0].seq}, expected 0`)
  return { header, events }
}

/**
 * Validate one manifest header and return only the keys persistence accepts.
 * @param value - parsed header line.
 * @param source - archive path used in diagnostics.
 * @returns the normalized header.
 */
export function normalizeHeader(value, source) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: header is not an object`)
  for (const key of Object.keys(value)) if (!HEADER_KEYS.has(key)) throw new Error(`${source}: header carries unsupported key ${JSON.stringify(key)}`)
  for (const key of HEADER_REQUIRED_KEYS) if (!(key in value)) throw new Error(`${source}: header is missing ${key}`)
  if (value.type !== 'session') throw new Error(`${source}: header type is not "session"`)
  if (!Number.isSafeInteger(value.version) || value.version < 0) throw new Error(`${source}: header version is invalid`)
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) throw new Error(`${source}: header id is invalid`)
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error(`${source}: header createdAt is invalid`)
  if (typeof value.isSeeded !== 'boolean') throw new Error(`${source}: header isSeeded is invalid`)
  if (!Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0) throw new Error(`${source}: header delegationDepth is invalid`)
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) throw new Error(`${source}: header cwd is invalid`)
  if (value.parentSession !== undefined && (typeof value.parentSession !== 'string' || value.parentSession.length === 0)) throw new Error(`${source}: header parentSession is invalid`)
  if (value.origin !== undefined && value.origin !== 'subagent') throw new Error(`${source}: header origin is invalid`)
  if (value.agentPreset !== undefined && (typeof value.agentPreset !== 'string' || value.agentPreset.length === 0)) throw new Error(`${source}: header agentPreset is invalid`)
  return {
    type: 'session',
    version: value.version,
    id: value.id,
    createdAt: value.createdAt,
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.parentSession !== undefined ? { parentSession: value.parentSession } : {}),
    isSeeded: value.isSeeded,
    ...(value.origin !== undefined ? { origin: value.origin } : {}),
    delegationDepth: value.delegationDepth,
    ...(value.agentPreset !== undefined ? { agentPreset: value.agentPreset } : {}),
  }
}

/** Collect direct attachment blocks from one declared content array. */
function collectContentRefs(content, images, files) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type === 'image' && block.attachment !== null && typeof block.attachment === 'object') {
      const ref = block.attachment
      if (typeof ref.attachmentId === 'string') images.set(String(ref.attachmentId), ref)
    }
    if (block.type === 'file' && block.attachment !== null && typeof block.attachment === 'object') {
      const ref = block.attachment
      if (typeof ref.attachmentId === 'string') files.set(`${String(ref.attachmentId)}\u0000${ref.name}`, ref)
    }
  }
}

/** Collect attachment references from the declared carriers of one event. */
function collectEventRefs(event, images, files) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return
  switch (event.type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      collectContentRefs(data.content, images, files)
      return
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      collectContentRefs(data.message?.content, images, files)
      return
    case 'agent/inbox/spliced':
      if (Array.isArray(data.inserted)) for (const message of data.inserted) collectContentRefs(message?.content, images, files)
      return
    case 'compaction/summary':
      collectContentRefs(data.summary, images, files)
      collectContentRefs(data.rawOutput, images, files)
      return
    case 'assistant/message':
      collectContentRefs(data.message?.content, images, files)
      break
    case 'assistant/attempt':
      break
    default:
      return
  }
  if (Array.isArray(data.stream)) {
    for (const record of data.stream) {
      if (record?.type === 'chunk' && record.chunk?.type === 'block-end') collectContentRefs([record.chunk.block], images, files)
    }
  }
}

/**
 * Distinct attachment references named by one session log.
 * @param text - canonical JSONL text.
 * @returns image and file reference maps keyed for dedupe.
 */
export function attachmentRefsInLog(text) {
  const images = new Map()
  const files = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'session') continue
    collectEventRefs(event, images, files)
  }
  return { images, files }
}

/**
 * Display title of one session log: the newest `session/title` event, else the
 * first user message's text prefix, else undefined.
 * @param events - committed events in seq order.
 * @returns the title text, or undefined when the log carries none.
 */
export function titleOfEvents(events) {
  let title
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      const value = event.data.title.trim()
      if (value !== '') title = value
    }
  }
  if (title !== undefined) return title
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim()
    if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text
  }
  return undefined
}

/** Normalize one untrusted attachment reference into a checked record. */
function normalizeAttachmentRef(kind, ref) {
  const digest = digestOfAttachmentId(ref.attachmentId)
  if (digest === undefined) throw new Error(`attachment ${String(ref.attachmentId)} is not a sha256 content address`)
  if (kind === 'image') {
    if (typeof ref.mediaType !== 'string' || MEDIA_TYPE_EXTENSIONS[ref.mediaType] === undefined) throw new Error(`image ${ref.attachmentId} has an unsupported media type`)
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error(`image ${ref.attachmentId} has an invalid byte count`)
    if (!Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height)) throw new Error(`image ${ref.attachmentId} has invalid dimensions`)
    if (typeof ref.name !== 'string' || ref.name === '') throw new Error(`image ${ref.attachmentId} has no display name`)
    return {
      kind,
      attachmentId: ref.attachmentId,
      digest,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
      name: ref.name,
    }
  }
  if (typeof ref.name !== 'string' || ref.name === '') throw new Error(`file ${ref.attachmentId} has no display name`)
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error(`file ${ref.attachmentId} has an invalid byte count`)
  return { kind, attachmentId: ref.attachmentId, digest, bytes: ref.bytes, name: ref.name }
}

/**
 * Validate one parsed manifest.
 * @param raw - parsed JSON value.
 * @returns the normalized manifest.
 * @throws when the manifest is foreign, newer, or malformed.
 */
export function normalizeManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pack manifest is not an object')
  if (raw.kind !== PACK_KIND) throw new Error('this file is not a DSH session pack')
  if (!Number.isSafeInteger(raw.packVersion) || raw.packVersion < 1) throw new Error('pack manifest has an invalid version')
  if (raw.packVersion > PACK_VERSION) throw new Error(`pack layout v${raw.packVersion} is newer than this plugin reads (v${PACK_VERSION})`)
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) throw new Error('pack manifest lists no sessions')
  if (raw.sessions.length > 512) throw new Error('pack lists more than 512 sessions')
  const sessions = raw.sessions.map((session, index) => {
    if (session === null || typeof session !== 'object' || Array.isArray(session)) throw new Error(`manifest session ${index} is not an object`)
    for (const key of ['id', 'path']) if (typeof session[key] !== 'string' || session[key] === '') throw new Error(`manifest session ${index} is missing ${key}`)
    if (session.id.length > MAX_ID_LENGTH) throw new Error(`manifest session ${index} has an oversized id`)
    if (session.path !== sessionLogPath(session.id)) throw new Error(`manifest session ${index} path does not match its id`)
    if (!Number.isSafeInteger(session.events) || session.events < 0) throw new Error(`manifest session ${index} has an invalid event count`)
    if (typeof session.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(session.sha256)) throw new Error(`manifest session ${index} has an invalid digest`)
    return {
      id: session.id,
      path: session.path,
      events: session.events,
      sha256: session.sha256,
      inheritedEventCount: Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount > 0 ? session.inheritedEventCount : 0,
      parentSession: typeof session.parentSession === 'string' ? session.parentSession : undefined,
      origin: session.origin === 'subagent' ? 'subagent' : undefined,
      delegationDepth: Number.isSafeInteger(session.delegationDepth) ? session.delegationDepth : 0,
      createdAt: Number.isSafeInteger(session.createdAt) ? session.createdAt : 0,
      cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
      agentPreset: typeof session.agentPreset === 'string' ? session.agentPreset : undefined,
    }
  })
  if (typeof raw.root !== 'string' || !sessions.some((session) => session.id === raw.root)) throw new Error('pack manifest does not name a root session in its list')
  const formatVersion = Number.isSafeInteger(raw.source?.sessionFormatVersion) ? raw.source.sessionFormatVersion : undefined
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`manifest attachment ${index} is not an object`)
    if (entry.kind !== 'image' && entry.kind !== 'file') throw new Error(`manifest attachment ${index} has an invalid kind`)
    if (typeof entry.path !== 'string' || entry.path === '') throw new Error(`manifest attachment ${index} is missing its path`)
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`manifest attachment ${index} has an invalid digest`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`manifest attachment ${index} has an invalid byte count`)
    const expected = entry.kind === 'image' ? imageEntryPath(entry.sha256, entry.mediaType) : fileEntryPath(entry.sha256, entry.name)
    if (entry.path !== expected) throw new Error(`manifest attachment ${index} path does not match its digest`)
    const normalized = normalizeAttachmentRef(entry.kind, entry)
    return { ...normalized, path: entry.path, sha256: entry.sha256 }
  }) : []
  if (attachments.length > 20000) throw new Error('pack lists more than 20000 attachments')
  return {
    kind: PACK_KIND,
    packVersion: raw.packVersion,
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
    source: {
      dshVersion: typeof raw.source?.dshVersion === 'string' ? raw.source.dshVersion : undefined,
      platform: typeof raw.source?.platform === 'string' ? raw.source.platform : undefined,
      sessionFormatVersion: formatVersion,
    },
    root: raw.root,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    sessions,
    attachments,
  }
}

/**
 * Build the manifest object for one exported pack.
 * @param input - root title, session rows, attachment rows, and source facts.
 * @returns the JSON-serializable manifest.
 */
export function buildManifest(input) {
  return {
    kind: PACK_KIND,
    packVersion: PACK_VERSION,
    createdAt: Date.now(),
    tool: { name: 'dsh-session-transfer', version: input.toolVersion ?? '0.0.0' },
    source: {
      ...(input.dshVersion !== undefined ? { dshVersion: input.dshVersion } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.sessionFormatVersion !== undefined ? { sessionFormatVersion: input.sessionFormatVersion } : {}),
    },
    root: input.root,
    ...(input.title !== undefined ? { title: input.title } : {}),
    sessions: input.sessions,
    attachments: input.attachments,
  }
}
