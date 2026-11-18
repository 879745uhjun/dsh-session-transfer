/**
 * Session-box bridge for whole-box packs.
 *
 * transfer never reads or writes `session-boxes.json`: the boxes plugin is the
 * only writer. This module talks to its public same-origin route
 * (`GET/POST /session-boxes`) over loopback, plans the import/export mapping,
 * and reports per-session outcomes so a failed box step never rolls back an
 * already-imported session.
 *
 * @module dsh-session-transfer/boxes
 */
import { TransferError } from './transfer-error.mjs'

/** Palette accepted by session-boxes. */
export const BOX_COLORS = Object.freeze(['blue', 'green', 'amber', 'red', 'purple', 'pink', 'cyan', 'gray'])
/** Suffix appended to a copied box name. */
export const COPY_SUFFIX = '（导入）'
/** Default loopback request timeout. */
const DEFAULT_TIMEOUT_MS = 4000

/** Formatting helper shared by the plan builders. */
function nameOf(box) {
  return typeof box?.name === 'string' ? box.name : ''
}

/** One loopback client for the boxes plugin's public route. */
export class BoxesClient {
  /**
   * @param options - base origin, fetch implementation, and timeout.
   */
  constructor(options) {
    this.origin = options.origin.replace(/\/+$/u, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** One JSON request against the boxes route. */
  async request(method, body) {
    const init = {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined,
    }
    let response
    try {
      response = await this.fetchImpl(`${this.origin}/session-boxes`, init)
    } catch (error) {
      throw new TransferError(`盒子服务不可达：${error instanceof Error ? error.message : String(error)}`, { code: 'TRANSFER_BOXES_UNAVAILABLE' })
    }
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json()
        if (typeof payload?.error === 'string') detail = `：${payload.error}`
      } catch {
        /* not a JSON failure */
      }
      throw new TransferError(`盒子服务返回 HTTP ${response.status}${detail}`, { code: 'TRANSFER_BOXES_UNAVAILABLE' })
    }
    return response.json()
  }

  /** Current boxes state. */
  async state() {
    const payload = await this.request('GET')
    if (payload?.ok !== true || payload.state === null || typeof payload.state !== 'object') {
      throw new TransferError('盒子服务返回了无效状态', { code: 'TRANSFER_BOXES_UNAVAILABLE' })
    }
    return {
      boxes: Array.isArray(payload.state.boxes) ? payload.state.boxes : [],
      memberships: payload.state.memberships !== null && typeof payload.state.memberships === 'object' ? payload.state.memberships : {},
      pins: payload.state.pins !== null && typeof payload.state.pins === 'object' ? payload.state.pins : {},
    }
  }

  /** Create one box and return its id. */
  async create({ name, color, parentId, header }) {
    const payload = await this.request('POST', {
      action: 'create',
      name,
      ...(color === undefined ? {} : { color }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(header === undefined ? {} : { header }),
    })
    if (payload?.ok !== true || typeof payload.boxId !== 'string') {
      throw new TransferError(`创建盒子「${name}」失败${payload?.error === undefined ? '' : `：${payload.error}`}`, { code: 'TRANSFER_BOX_WRITE' })
    }
    return payload.boxId
  }

  /** Replace one session's complete box membership list. */
  async assign(sessionId, boxIds) {
    const payload = await this.request('POST', { action: 'assign', sessionId, boxIds })
    if (payload?.ok !== true) {
      throw new TransferError(`会话 ${sessionId} 归盒失败${payload?.error === undefined ? '' : `：${payload.error}`}`, { code: 'TRANSFER_BOX_WRITE' })
    }
    return payload
  }
}

/**
 * Resolve the loopback boxes client from the host context, or undefined when
 * the web server has not bound a port (headless/TUI deployments).
 * @param ctx - host context.
 * @param fetchImpl - optional fetch override for tests.
 * @returns the client, or undefined.
 */
export function createBoxesClient(ctx, fetchImpl) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.getOrigin !== 'function') return undefined
  try {
    const origin = webServer.getOrigin()
    if (typeof origin !== 'string' || origin === '') return undefined
    return new BoxesClient({ origin, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  } catch {
    return undefined
  }
}

/** Stable unique name for a copy, avoiding collisions with existing names. */
export function copyName(boxes, wanted, parentId) {
  const taken = new Set(boxes.filter((box) => (box.parentId ?? null) === (parentId ?? null)).map(nameOf))
  let candidate = `${wanted}${COPY_SUFFIX}`
  let index = 2
  while (taken.has(candidate)) {
    candidate = `${wanted}${COPY_SUFFIX} ${index}`
    index += 1
  }
  return candidate
}

/**
 * Plan one box import against a boxes state snapshot.
 * @param state - current boxes state (`boxes`, `memberships`, `pins`).
 * @param descriptor - manifest box descriptor.
 * @param mode - `reuse` (default) or `copy`.
 * @returns the plan shown by preflight and consumed by the assignment step.
 */
export function planBoxImport(state, descriptor, mode = 'reuse') {
  const boxes = Array.isArray(state?.boxes) ? state.boxes : []
  const byName = (name, parentId) => boxes.find((box) => nameOf(box) === name && (box.parentId ?? null) === (parentId ?? null))
  const copy = mode === 'copy'
  const existingParent = copy ? undefined : byName(descriptor.name, null)
  const parentName = existingParent === undefined
    ? (copy ? copyName(boxes, descriptor.name, null) : descriptor.name)
    : descriptor.name
  const parent = existingParent === undefined
    ? { action: 'create', name: parentName, existingId: undefined, color: descriptor.color, header: descriptor.header }
    : { action: 'reuse', name: existingParent.name, existingId: existingParent.id, color: undefined, header: undefined }
  const children = (Array.isArray(descriptor.children) ? descriptor.children : []).map((child) => {
    const existingChild = parent.action === 'reuse' ? byName(child.name, parent.existingId) : undefined
    return existingChild === undefined
      ? { action: 'create', name: child.name, existingId: undefined, color: child.color, header: child.header, members: child.members }
      : { action: 'reuse', name: existingChild.name, existingId: existingChild.id, color: undefined, header: undefined, members: child.members }
  })
  const reuse = [parent, ...children].filter((node) => node.action === 'reuse').length
  const create = [parent, ...children].filter((node) => node.action === 'create').length
  const memberCount = (Array.isArray(descriptor.members) ? descriptor.members.length : 0)
    + children.reduce((sum, child) => sum + child.members.length, 0)
  return {
    available: true,
    mode: copy ? 'copy' : 'reuse',
    name: parentName,
    originalName: descriptor.name,
    parent,
    children,
    counts: { reuse, create, skip: 0 },
    members: memberCount,
    pinned: Array.isArray(descriptor.pinned) ? descriptor.pinned.length : 0,
    note: Array.isArray(descriptor.pinned) && descriptor.pinned.length > 0 ? '置顶顺序未迁移' : undefined,
  }
}

/** The plan used when the boxes route is not reachable. */
export function unboxedPlan(descriptor, reason) {
  const members = Array.isArray(descriptor?.members) ? descriptor.members.length : 0
  return {
    available: false,
    mode: 'skip',
    name: descriptor?.name ?? '',
    originalName: descriptor?.name ?? '',
    counts: { reuse: 0, create: 0, skip: members },
    members,
    pinned: Array.isArray(descriptor?.pinned) ? descriptor.pinned.length : 0,
    reason,
  }
}

/**
 * Execute one planned import: create/reuse boxes, then assign each imported
 * session. A per-session failure is reported and never aborts the rest.
 * @param client - loopback boxes client.
 * @param plan - plan from {@link planBoxImport}.
 * @param members - member descriptors with old ids and their target box slot.
 * @param idMap - old session id to imported session id.
 * @returns per-session results and warnings.
 */
export async function applyBoxPlan(client, plan, members, idMap) {
  const results = []
  const warnings = []
  let parentId
  if (plan.parent.action === 'reuse') {
    parentId = plan.parent.existingId
  } else {
    parentId = await createWithReuse(client, plan.parent, null, warnings)
  }
  const childIds = new Map()
  for (const child of plan.children) {
    childIds.set(child.name, child.action === 'reuse' ? child.existingId : await createWithReuse(client, child, parentId, warnings))
  }

  // Merge against a fresh snapshot so memberships added meanwhile are kept.
  let state
  try {
    state = await client.state()
  } catch (error) {
    warnings.push(`盒子已就绪，但读取当前成员失败，按空成员继续：${error instanceof Error ? error.message : String(error)}`)
    state = { boxes: [], memberships: {}, pins: {} }
  }
  for (const member of members) {
    const sessionId = idMap.get(member.sessionId) ?? member.sessionId
    const targetId = member.childName === undefined ? parentId : childIds.get(member.childName)
    const base = Array.isArray(state.memberships?.[sessionId]) ? state.memberships[sessionId] : []
    const boxIds = [...new Set([...base, targetId])]
    try {
      await client.assign(sessionId, boxIds)
      results.push({ sessionId, boxId: targetId, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ sessionId, boxId: targetId, ok: false, error: message })
      warnings.push(`会话 ${sessionId} 归盒失败：${message}`)
    }
  }
  return { parentId, childIds, results, warnings }
}

/** Create one box, falling back to a same-name box created concurrently. */
async function createWithReuse(client, node, parentId, warnings) {
  try {
    return await client.create({ name: node.name, color: node.color, parentId: parentId === null ? undefined : parentId, header: node.header })
  } catch (error) {
    try {
      const state = await client.state()
      const existing = state.boxes.find((box) => box.name === node.name && (box.parentId ?? null) === (parentId ?? null))
      if (existing !== undefined) {
        warnings.push(`盒子「${node.name}」在导入过程中已被创建，复用它`)
        return existing.id
      }
    } catch {
      /* fall through to the original failure */
    }
    throw error
  }
}
