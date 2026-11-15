/**
 * dsh-session-transfer — Host half.
 *
 * Moves whole sessions between DSH installations:
 *  - `GET  /session-transfer/export` streams one `.dshpack` (a ZIP holding the
 *    canonical session log, its subagent descendants, and every referenced
 *    attachment) built through the persistence, session-query, and attachment
 *    seams;
 *  - `POST /session-transfer/import` validates such an archive, imports its
 *    attachments by content address, restores every session through the
 *    persistence service, and attaches the root session to a target workspace
 *    whose path replaces the recorded source path;
 *  - `GET  /session-transfer/workspaces` supplies the import picker;
 *  - `pack_session` and `unpack_session` expose the same operations to agents.
 *
 * Nothing here adds model-visible prompt text; the two tools are the only new
 * model surface, and the routes are same-origin only.
 *
 * @module dsh-session-transfer
 */
import { open, rename, rm, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TransferError, SessionTransfer, MAX_PACK_BYTES, packFilename, contentDisposition, isInside, resolveDshHome } from './lib/transfer.mjs'
import { readFileSync } from 'node:fs'

/** Cordis plugin name. */
export const name = 'dsh-session-transfer'

/** Required Host services; routes additionally wait for `webServer`. */
export const inject = ['tools']

/** Plugin version reported in packs and logs. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Browser route prefixes. */
const ROUTE_EXPORT = '/session-transfer/export'
const ROUTE_IMPORT = '/session-transfer/import'
const ROUTE_WORKSPACES = '/session-transfer/workspaces'
const ROUTE_INSPECT = '/session-transfer/inspect'

/** How long one preflighted upload stays staged for its import. */
const STAGED_TTL_MS = 60 * 60 * 1000
/** At most this many preflighted uploads are retained. */
const MAX_STAGED = 8

/** Longest session id accepted from a request. */
const MAX_SESSION_ID_LENGTH = 200

/**
 * One warning sink that reports each distinct failure once, to the console and
 * to a small diagnostics file under the DSH home: the desktop build keeps no
 * attached terminal, so an import failure would otherwise be invisible.
 * @param file - optional diagnostics log path.
 * @returns the warn function.
 */
function createLogger(file) {
  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : `${message}: ${error?.code ?? error?.message ?? String(error)}`
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn(`[session-transfer] ${message}`, error)
    else console.warn(`[session-transfer] ${message}`)
    if (file === undefined) return
    try {
      const detail = error === undefined ? '' : `\n${error?.stack ?? String(error)}`
      appendFileSync(file, `${new Date().toISOString()} ${message}${detail}\n`)
    } catch {
      /* diagnostics must never break the operation */
    }
  }
}

/** Refuse a cross-site request; same-origin requests and plain HTTP clients pass. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Send one JSON response with no caching. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Translate a thrown value into a response without leaking internals. */
function sendFailure(response, error, log) {
  const known = error instanceof TransferError
  if (!known) log('request failed', error)
  const status = !known
    ? 500
    : error.code === 'TRANSFER_FORMAT_MISMATCH'
      ? 409
      : error.code === 'TRANSFER_TOO_LARGE'
        ? 413
        : error.code === 'TRANSFER_PACK_INVALID'
          ? 422
          : 400
  try {
    sendJson(response, status, {
      ok: false,
      code: known ? error.code : 'TRANSFER_INTERNAL',
      error: known ? error.message : '会话打包/导入失败，请查看 DSH 日志',
    })
  } catch {
    response.destroy()
  }
}

/** Parse one request URL and its query. */
function urlOf(request) {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  } catch {
    return undefined
  }
}

/** Read the request body into one file, enforcing the byte cap. */
async function receiveToFile(request, path, limit) {
  const handle = await open(path, 'w')
  let bytes = 0
  try {
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > limit) throw new TransferError(`会话包超过 ${limit} 字节上限`, { code: 'TRANSFER_TOO_LARGE' })
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
  return bytes
}

/** A path that does not exist yet, by appending a counter before the extension. */
async function uniquePath(directory, filename) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(directory, index === 1 ? filename : `${stem} (${index})${extension}`)
    const exists = await stat(candidate).then(() => true, () => false)
    if (!exists) return candidate
  }
  return join(directory, `${stem}-${Date.now()}${extension}`)
}

/** The `pack_session` agent tool. */
function createPackTool(transfer, log) {
  return {
    name: 'pack_session',
    description: 'Package one DSH session (conversation, tool history, subagent sessions, and referenced images/files) into a portable .dshpack file that another DSH installation can import with unpack_session. Use this when the user wants to move, back up, or hand off a session to another computer. Omit sessionId to pack the calling session.',
    parameters: {
      sessionId: { type: 'string', description: 'Session id to pack. Defaults to the calling session.' },
      path: { type: 'string', description: 'Absolute destination .dshpack path. Defaults to a folder under the DSH home; must be inside the DSH home or a registered workspace.' },
      includeDescendants: { type: 'boolean', description: 'Include subagent sessions spawned by this session. Defaults to true.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : exec.agent?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, error: 'sessionId is required when no calling session exists' }
        if (sessionId.length > MAX_SESSION_ID_LENGTH) return { ok: false, error: `sessionId must be at most ${MAX_SESSION_ID_LENGTH} characters` }
        const explicit = typeof args?.path === 'string' && args.path.trim() !== '' ? resolve(args.path.trim()) : undefined
        const ensureWritablePath = (path) => {
          const home = transfer.dshHome
          const inHome = isInside(home, path)
          const inWorkspace = transfer.listWorkspaces().some((workspace) => isInside(workspace.path, path))
          if (!inHome && !inWorkspace) throw new TransferError('导出路径必须在 DSH 目录或已注册的工作区内', { code: 'TRANSFER_INPUT' })
        }
        const staging = join(transfer.packsDir, `.export-${randomUUID()}.dshpack`)
        const result = await transfer.exportPack({
          sessionId,
          includeDescendants: args?.includeDescendants !== false,
          destination: explicit ?? staging,
          ensureWritablePath,
        })
        if (explicit === undefined) {
          const finalPath = await uniquePath(transfer.packsDir, packFilename(result.title, sessionId))
          await rename(staging, finalPath)
          result.path = finalPath
        }
        return result
      } catch (error) {
        if (!(error instanceof TransferError)) log('pack_session failed', error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** The `unpack_session` agent tool. */
function createImportTool(transfer, log) {
  return {
    name: 'unpack_session',
    description: 'Import a .dshpack produced by pack_session into this DSH installation. Restores the session log, its subagent sessions, and referenced attachments, relocates the session into the chosen workspace, and attaches it so it appears in the sidebar. Use workspace to choose the target (id, path, or exact title); defaults to the first workspace.',
    parameters: {
      path: { type: 'string', description: 'Absolute path of the .dshpack file to import.' },
      workspace: { type: 'string', description: 'Target workspace id, path, or exact title. Defaults to the first workspace.' },
      dryRun: { type: 'boolean', description: 'Validate the pack and report the import plan without writing anything.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        if (typeof args?.path !== 'string' || args.path.trim() === '') return { ok: false, error: 'path is required' }
        return await transfer.importPack({
          path: resolve(args.path.trim()),
          workspace: typeof args?.workspace === 'string' ? args.workspace.trim() : undefined,
          dryRun: args?.dryRun === true,
        })
      } catch (error) {
        if (!(error instanceof TransferError)) log('unpack_session failed', error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * Register the transfer tools and browser routes.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const dshHome = resolveDshHome()
  const log = createLogger(join(dshHome, 'tmp', 'session-transfer.log'))
  const transfer = new SessionTransfer({ ctx, log, version: VERSION, dshHome })

  ctx.effect(() => ctx.tools.register(createPackTool(transfer, log)), 'session-transfer: pack tool')
  ctx.effect(() => ctx.tools.register(createImportTool(transfer, log)), 'session-transfer: import tool')

  // Deployments without a web server (TUI, headless) still get both tools.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const removeExport = scope.webServer.register({
        kind: 'exact',
        path: ROUTE_EXPORT,
        handler: async (request, response) => {
          try {
            if (!isAcceptableOrigin(request)) return sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            const url = urlOf(request)
            const sessionId = url?.searchParams.get('sessionId') ?? ''
            if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
              return sendJson(response, 400, { ok: false, error: 'sessionId is required' })
            }
            if (request.method === 'HEAD') {
              const persistence = ctx.get('sessionPersistence')
              if (persistence === undefined) return sendJson(response, 503, { ok: false, error: 'session persistence is not mounted' })
              try {
                await persistence.stat(sessionId)
                response.writeHead(204, { 'cache-control': 'no-store' })
                response.end()
              } catch {
                response.writeHead(404, { 'cache-control': 'no-store' })
                response.end()
              }
              return
            }
            const includeDescendants = url?.searchParams.get('descendants') !== '0'
            const staging = join(transfer.tmpDir, `export-${randomUUID()}.dshpack`)
            await transfer.exportPack({
              sessionId,
              includeDescendants,
              destination: staging,
            })
            let bytes
            try {
              bytes = (await stat(staging)).size
            } catch {
              bytes = undefined
            }
            const title = url?.searchParams.get('title') ?? undefined
            const filename = packFilename(title, sessionId)
            response.writeHead(200, {
              'content-type': 'application/zip',
              'content-disposition': contentDisposition(filename),
              'cache-control': 'no-store',
              ...(bytes === undefined ? {} : { 'content-length': bytes }),
            })
            try {
              await transfer.sendFile(staging, response)
            } finally {
              await rm(staging, { force: true }).catch(() => {})
            }
          } catch (error) {
            if (response.headersSent) {
              response.destroy()
              return
            }
            sendFailure(response, error, log)
          }
        },
      })
      const staged = new Map()

      /** Drop staged uploads whose import never arrived. */
      const sweepStaged = async () => {
        const cutoff = Date.now() - STAGED_TTL_MS
        for (const [token, row] of [...staged]) {
          if (row.createdAt >= cutoff) continue
          staged.delete(token)
          await rm(row.path, { force: true }).catch(() => {})
        }
      }

      /** Forget every staged upload (plugin teardown). */
      const clearStaged = async () => {
        const rows = [...staged.values()]
        staged.clear()
        for (const row of rows) await rm(row.path, { force: true }).catch(() => {})
      }

      const removeInspect = scope.webServer.register({
        kind: 'exact',
        path: ROUTE_INSPECT,
        handler: async (request, response) => {
          let staging
          try {
            if (!isAcceptableOrigin(request)) return sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            const url = urlOf(request)
            const workspaceId = url?.searchParams.get('workspaceId') ?? undefined
            await sweepStaged()
            const token = randomUUID()
            staging = join(transfer.tmpDir, `inspect-${token}.dshpack`)
            const bytes = await receiveToFile(request, staging, MAX_PACK_BYTES)
            if (bytes === 0) throw new TransferError('上传的会话包是空的', { code: 'TRANSFER_INPUT' })
            const plan = await transfer.importPack({ path: staging, workspace: workspaceId, dryRun: true })
            staged.set(token, { path: staging, createdAt: Date.now() })
            while (staged.size > MAX_STAGED) {
              const [oldestToken, oldest] = [...staged].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]
              staged.delete(oldestToken)
              await rm(oldest.path, { force: true }).catch(() => {})
            }
            sendJson(response, 200, { ok: true, token, plan })
            staging = undefined
          } catch (error) {
            if (!(error instanceof TransferError)) log('inspect route failed', error)
            if (!response.headersSent) sendFailure(response, error, log)
            else response.destroy()
          } finally {
            if (staging !== undefined) await rm(staging, { force: true }).catch(() => {})
          }
        },
      })
      const removeImport = scope.webServer.register({
        kind: 'exact',
        path: ROUTE_IMPORT,
        handler: async (request, response) => {
          let staging
          try {
            if (!isAcceptableOrigin(request)) return sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            const url = urlOf(request)
            const workspaceId = url?.searchParams.get('workspaceId') ?? undefined
            const token = url?.searchParams.get('token') ?? undefined
            if (token !== undefined) {
              const row = staged.get(token)
              if (row === undefined) throw new TransferError('预检已过期，请重新选择会话包', { code: 'TRANSFER_INPUT' })
              staged.delete(token)
              staging = row.path
            } else {
              staging = join(transfer.tmpDir, `import-${randomUUID()}.dshpack`)
              const bytes = await receiveToFile(request, staging, MAX_PACK_BYTES)
              if (bytes === 0) throw new TransferError('上传的会话包是空的', { code: 'TRANSFER_INPUT' })
            }
            const result = await transfer.importPack({ path: staging, workspace: workspaceId })
            sendJson(response, 200, result)
          } catch (error) {
            if (!(error instanceof TransferError)) log('import route failed', error)
            if (!response.headersSent) sendFailure(response, error, log)
            else response.destroy()
          } finally {
            if (staging !== undefined) await rm(staging, { force: true }).catch(() => {})
          }
        },
      })
      const removeWorkspaces = scope.webServer.register({
        kind: 'exact',
        path: ROUTE_WORKSPACES,
        handler: (request, response) => {
          try {
            if (!isAcceptableOrigin(request)) return sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            sendJson(response, 200, { ok: true, workspaces: transfer.listWorkspaces() })
          } catch (error) {
            sendFailure(response, error, log)
          }
        },
      })
      return () => {
        removeWorkspaces()
        removeImport()
        removeInspect()
        removeExport()
        void clearStaged()
      }
    }, 'session-transfer: browser routes')
  })
}
