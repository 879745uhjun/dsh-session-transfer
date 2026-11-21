/**
 * dsh-session-transfer — browser half.
 *
 * Adds the two user-facing doors to the host's pack routes:
 *  - every session row menu gets a `打包会话` item that builds the `.dshpack`
 *    and saves it through the browser download manager, with a progress card
 *    that reports packing, download, and failures;
 *  - the sidebar footer gets an `导入会话包` button that opens one dialog:
 *    choose the target workspace and the `.dshpack`, review a preflight card
 *    (what the pack contains and what import will rewrite), confirm, then open
 *    the restored session.
 *
 * Copy comes from the Client locale service; styling uses theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-transfer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'session-transfer'
    const ROUTE_EXPORT = '/session-transfer/export'
    const ROUTE_IMPORT = '/session-transfer/import'
    const ROUTE_INSPECT = '/session-transfer/inspect'
    const ROUTE_WORKSPACES = '/session-transfer/workspaces'
    const ROUTE_WORKSPACE = '/session-transfer/workspace'
    const ROUTE_PROGRESS = '/session-transfer/progress'

    const EN = {
      'menu.pack': 'Pack session…',
      'selftest.title': 'Self-test',
      'selftest.run': 'Run self-test',
      'selftest.rerun': 'Run again',
      'selftest.copy': 'Copy result',
      'selftest.copied': 'Copied',
      'selftest.summary': '{pass} passed · {fail} failed · {warn} notes',
      'selftest.idle': 'Not run',
      'selftest.running': 'Running',
      'selftest.pass': 'Pass',
      'selftest.fail': 'Fail',
      'selftest.warn': 'Note',
      'selftest.error': 'Could not run the self-test: {error}',
      'selftest.lang': 'en',
      'selftest.item.health': 'Health endpoint',
      'selftest.item.tools': 'Agent tools',
      'selftest.item.boxes': 'Boxes availability',
      'selftest.item.writable': 'Export directory writable',
      'menu.packBox': 'Pack its box…',
      'box.pick.title': 'Pack the whole box',
      'box.pick.hint': 'This session sits in several boxes. Pick one to pack every session in it, including its sub-boxes.',
      'box.pick.cancel': 'Cancel',
      'box.none': 'This session is not in any box.',
      'box.loadFailed': 'Could not read boxes',
      'plan.box': 'Box',
      'plan.boxUnavailable': 'Sessions will import without a box: {reason}',
      'plan.boxCounts': '{reuse} reused / {create} new / {skip} skipped',
      'plan.boxMode': 'Same-name box',
      'plan.boxReuse': 'Reuse it',
      'plan.boxCopy': 'New copy',
      'plan.boxCopyName': 'Will create 「{name}」',
      'result.box': 'Assigned to the box: {ok}/{total} sessions',
      'result.boxFailed': 'Box assignment failed (sessions were kept): {error}',
      'footer.import': 'Import session pack',
      'footer.import.short': 'Import',
      'dialog.title': 'Import a session pack',
      'dialog.hint': 'A .dshpack carries one session, its subagent sessions, and every referenced image or file. Pick the workspace the session should belong to on this computer.',
      'dialog.workspace': 'Target workspace',
      'dialog.workspace.empty': 'No workspace yet. Add one in DSH first.',
      'dialog.workspace.new': 'New workspace…',
      'dialog.workspace.path': 'Absolute directory for the new workspace',
      'dialog.workspace.create': 'Create and use',
      'dialog.workspace.creating': 'Creating…',
      'progress.starting': 'Preparing…',
      'progress.attachments': 'Restoring attachments {done}/{total}',
      'progress.sessions': 'Restoring sessions {done}/{total}',
      'progress.boxes': 'Assigning boxes…',
      'progress.finishing': 'Finishing…',
      'dialog.file': 'Session pack',
      'dialog.choose': 'Choose a .dshpack file',
      'dialog.drop': 'or drop it here',
      'dialog.replace': 'Choose another file',
      'dialog.inspecting': 'Checking the pack…',
      'dialog.import': 'Import',
      'dialog.confirm': 'Import',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.working': 'Importing…',
      'dialog.workingHint': 'Restoring session logs and attachments. Do not close this page.',
      'dialog.success.title': 'Session imported',
      'dialog.success.hint': 'It was attached to 「{workspace}」 and should appear in the sidebar.',
      'dialog.open': 'Open session',
      'dialog.done': 'Done',
      'dialog.failed': 'Import failed',
      'dialog.retry': 'Try again',
      'dialog.badFile': 'Choose a .dshpack file produced by Pack session.',
      'plan.emptyTitle': 'Untitled session',
      'plan.sessions': 'Sessions',
      'plan.copies': '{count} as copies',
      'plan.events': 'Events',
      'plan.attachments': 'Attachments',
      'plan.target': 'Import into',
      'plan.source': 'Source',
      'error.format.title': 'Incompatible DSH version',
      'error.format.hint': 'The pack was exported by a DSH with a different session format. Update both installations to the same release and try again.',
      'error.corrupt.title': 'Pack is damaged or incomplete',
      'error.corrupt.hint': 'The copy may be truncated. Re-copy the file or pack the session again.',
      'error.tooLarge.title': 'File is too large',
      'error.tooLarge.hint': 'A pack may be at most 2 GB.',
      'error.workspace.title': 'Workspace unavailable',
      'error.workspace.hint': 'Check that the workspace directory still exists on this computer.',
      'error.attachment.title': 'Could not restore attachments',
      'error.attachment.hint': 'The attachment store may be read-only or full.',
      'error.write.title': 'Could not write the session',
      'error.write.hint': 'Nothing was attached. Check the DSH log for the storage failure.',
      'error.input.title': 'Could not read the pack',
      'error.input.hint': 'The preflight may have expired; choose the file again.',
      'error.notFound.title': 'Session no longer exists',
      'error.notFound.hint': 'It may have been deleted. Close this dialog, refresh the sidebar, and pick another session.',
      'error.host.title': 'The host plugin is not answering',
      'error.host.hint': 'Restart DSH or check that dsh-session-transfer is enabled in Plugins.',
      'error.generic.title': 'Import failed',
      'pack.card.title': 'Packing session',
      'pack.card.preparing': 'Building the archive…',
      'pack.card.downloading': 'Downloading {percent}%',
      'pack.card.saving': 'Saving the file…',
      'pack.card.done': 'Session pack saved.',
      'pack.card.failed': 'Could not pack the session',
      'pack.card.missing': 'The session may have been deleted; the sidebar was refreshed. Pick another session.',
      'pack.card.host': 'The host half is not answering. Restart DSH or check that the plugin is enabled.',
      'pack.card.cancel': 'Cancel',
      'error.workspaces': 'Could not read the workspace list',
      'error.http': 'The host answered HTTP {status}',
      'warn.title': 'Notes',
    }

    const ZH = {
      'menu.pack': '打包会话…',
      'selftest.title': '自检',
      'selftest.run': '运行自检',
      'selftest.rerun': '重新运行',
      'selftest.copy': '复制结果',
      'selftest.copied': '已复制',
      'selftest.summary': '{pass} 通过 · {fail} 失败 · {warn} 提示',
      'selftest.idle': '未运行',
      'selftest.running': '运行中',
      'selftest.pass': '通过',
      'selftest.fail': '失败',
      'selftest.warn': '提示',
      'selftest.error': '无法运行自检：{error}',
      'selftest.lang': 'zh',
      'selftest.item.health': '健康检查',
      'selftest.item.tools': '工具注册',
      'selftest.item.boxes': '归盒可用性',
      'selftest.item.writable': '导出目录可写',
      'menu.packBox': '打包所在盒子…',
      'box.pick.title': '打包整个盒子',
      'box.pick.hint': '这个会话在多个盒子里，选一个盒子打包（含盒内所有会话和直接子盒）。',
      'box.pick.cancel': '取消',
      'box.none': '这个会话不在任何盒子里',
      'box.loadFailed': '读取盒子失败',
      'plan.box': '盒子',
      'plan.boxUnavailable': '将导入但不归盒：{reason}',
      'plan.boxCounts': '复用 {reuse} 个 / 新建 {create} 个 / 跳过 {skip} 个',
      'plan.boxMode': '同名盒处理',
      'plan.boxReuse': '复用同名盒',
      'plan.boxCopy': '新建副本',
      'plan.boxCopyName': '将新建「{name}」',
      'result.box': '已归入盒子：{ok}/{total} 个会话成功',
      'result.boxFailed': '归盒失败（会话已导入）：{error}',
      'footer.import': '导入会话包',
      'footer.import.short': '导入',
      'dialog.title': '导入会话包',
      'dialog.hint': '一个 .dshpack 包含一个会话、它的子会话，以及引用到的图片和文件。选择这个会话在本机应归属的工作区。',
      'dialog.workspace': '目标工作区',
      'dialog.workspace.empty': '还没有工作区，请先在 DSH 里添加一个。',
      'dialog.workspace.new': '新建工作区…',
      'dialog.workspace.path': '新工作区的绝对路径',
      'dialog.workspace.create': '创建并使用',
      'dialog.workspace.creating': '正在创建…',
      'progress.starting': '正在准备…',
      'progress.attachments': '正在恢复附件 {done}/{total}',
      'progress.sessions': '正在恢复会话 {done}/{total}',
      'progress.boxes': '正在归盒…',
      'progress.finishing': '正在收尾…',
      'dialog.file': '会话包',
      'dialog.choose': '选择 .dshpack 文件',
      'dialog.drop': '也可以拖到这里',
      'dialog.replace': '换一个文件',
      'dialog.inspecting': '正在检查会话包…',
      'dialog.import': '导入',
      'dialog.confirm': '确认导入',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.working': '正在导入…',
      'dialog.workingHint': '正在恢复会话日志和附件，请不要关闭页面。',
      'dialog.success.title': '会话已导入',
      'dialog.success.hint': '已挂到「{workspace}」，它应该会出现在侧边栏里。',
      'dialog.open': '打开会话',
      'dialog.done': '完成',
      'dialog.failed': '导入失败',
      'dialog.retry': '重试',
      'dialog.badFile': '请选择由「打包会话」生成的 .dshpack 文件。',
      'plan.emptyTitle': '未命名会话',
      'plan.sessions': '会话',
      'plan.copies': '{count} 个作为副本',
      'plan.events': '事件',
      'plan.attachments': '附件',
      'plan.target': '导入到',
      'plan.source': '来源',
      'error.format.title': '版本不兼容',
      'error.format.hint': '两台电脑的 DSH 会话格式不同。请把两边更新到同一版本后再导入。',
      'error.corrupt.title': '会话包损坏或不完整',
      'error.corrupt.hint': '文件可能在拷贝时被截断，请重新拷贝或重新打包。',
      'error.tooLarge.title': '文件太大',
      'error.tooLarge.hint': '单个会话包上限为 2 GB。',
      'error.workspace.title': '工作区不可用',
      'error.workspace.hint': '请确认这个工作区的目录在本机仍然存在。',
      'error.attachment.title': '附件恢复失败',
      'error.attachment.hint': '目标机的附件目录可能没有写权限或空间不足。',
      'error.write.title': '写入会话失败',
      'error.write.hint': '尚未挂到工作区，请查看 DSH 日志里的存储错误。',
      'error.input.title': '无法读取会话包',
      'error.input.hint': '预检可能已过期，请重新选择文件。',
      'error.notFound.title': '会话不存在',
      'error.notFound.hint': '它可能已被删除。关闭对话框、刷新侧边栏后重新选择会话。',
      'error.host.title': '插件宿主没有响应',
      'error.host.hint': '请重启 DSH，或在「插件」设置里确认 dsh-session-transfer 已启用。',
      'error.generic.title': '导入失败',
      'pack.card.title': '正在打包会话',
      'pack.card.preparing': '正在生成压缩包…',
      'pack.card.downloading': '下载中 {percent}%',
      'pack.card.saving': '正在保存文件…',
      'pack.card.done': '会话包已保存。',
      'pack.card.failed': '会话打包失败',
      'pack.card.missing': '这个会话可能已被删除；已刷新侧边栏，请重新选择会话。',
      'pack.card.host': '插件宿主没有响应：请重启 DSH，或在设置里确认插件已启用。',
      'pack.card.cancel': '取消',
      'error.workspaces': '无法读取工作区列表',
      'error.http': '宿主返回 HTTP {status}',
      'warn.title': '提示',
    }

    /* ------------------------------------------------------------------ *
     * Tiny external stores (one for the import dialog, one for pack progress)
     * ------------------------------------------------------------------ */

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(next) {
          state = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    const EMPTY_DIALOG = {
      open: false,
      file: null,
      workspaces: null,
      workspaceId: '',
      phase: 'idle', // idle | inspecting | planned | uploading | done | failed
      boxMode: 'reuse',
      plan: null,
      token: null,
      error: null, // { code, message }
      result: null,
      workspacesFailed: false,
      workspaceMessage: null,
      newWorkspace: false,
      workspacePath: '',
      workspaceBusy: false,
      workspaceError: null,
      progress: null,
    }

    const EMPTY_BOX_PICK = { open: false, sessionId: '', title: '', boxes: [] }
    const dialogStore = createStore(EMPTY_DIALOG)
    const boxPickStore = createStore(EMPTY_BOX_PICK)
    const packStore = createStore({ status: 'idle', title: '', sessionId: '', received: 0, total: 0, error: null })

    const abortable = { current: null }
    let inspectSequence = 0
    let clientCtx = null

    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** One classified failure from the pack route, keeping its stable code. */
    async function packFailure(response) {
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      const error = new Error(typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `HTTP ${response.status}`)
      error.code = typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`
      return error
    }

    async function readError(response, t) {
      try {
        const payload = await response.json()
        if (typeof payload?.error === 'string' && payload.error !== '') return payload.error
      } catch {
        /* not a JSON failure */
      }
      return t('error.http', { status: String(response.status) })
    }

    /** One host failure carrying its stable code for classification. */
    async function failureOf(response, t) {
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      const error = new Error(typeof payload?.error === 'string' && payload.error !== '' ? payload.error : t('error.http', { status: String(response.status) }))
      error.code = typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`
      return error
    }

    /** Classified failure for an HTTP-200 body that still reports `ok: false`. */
    function payloadFailure(payload, t) {
      const error = new Error(typeof payload?.error === 'string' && payload.error !== '' ? payload.error : t('dialog.failed'))
      error.code = typeof payload?.code === 'string' ? payload.code : 'UNKNOWN'
      return error
    }

    /** Stable error code -> localized title/hint keys. */
    const ERROR_KEYS = {
      TRANSFER_FORMAT_MISMATCH: ['error.format.title', 'error.format.hint'],
      TRANSFER_PACK_INVALID: ['error.corrupt.title', 'error.corrupt.hint'],
      TRANSFER_TOO_LARGE: ['error.tooLarge.title', 'error.tooLarge.hint'],
      HTTP_413: ['error.tooLarge.title', 'error.tooLarge.hint'],
      TRANSFER_WORKSPACE: ['error.workspace.title', 'error.workspace.hint'],
      TRANSFER_ATTACHMENT: ['error.attachment.title', 'error.attachment.hint'],
      TRANSFER_WRITE: ['error.write.title', 'error.write.hint'],
      TRANSFER_INPUT: ['error.input.title', 'error.input.hint'],
      TRANSFER_SESSION_NOT_FOUND: ['error.notFound.title', 'error.notFound.hint'],
      HTTP_404: ['error.host.title', 'error.host.hint'],
      BAD_FILE: ['error.input.title', null],
      HTTP_WORKSPACES: ['error.workspace.title', 'error.workspace.hint'],
    }

    function errorView(state, t) {
      const pair = ERROR_KEYS[state.error?.code] ?? ['error.generic.title', null]
      return {
        title: t(pair[0]),
        hint: pair[1] === null ? null : t(pair[1]),
        message: state.error?.message ?? '',
      }
    }

    /** One-line description of the current import phase. */
    function progressLabel(progress, t) {
      if (progress === null || progress === undefined) return t('dialog.working')
      const done = String(progress.done ?? 0)
      const total = String(progress.total ?? 0)
      switch (progress.phase) {
        case 'attachments':
          return t('progress.attachments', { done, total })
        case 'sessions':
          return t('progress.sessions', { done, total })
        case 'boxes':
          return t('progress.boxes')
        case 'done':
          return t('progress.finishing')
        default:
          return t('progress.starting')
      }
    }

    /* ------------------------------------------------------------------ *
     * Pack download: fetch the streamed ZIP, then hand it to the browser
     * ------------------------------------------------------------------ */

    async function packSession(target, title) {
      const boxId = target !== null && typeof target === 'object' && typeof target.boxId === 'string' ? target.boxId : undefined
      const sessionId = boxId === undefined ? (typeof target === 'string' ? target : target?.sessionId) : undefined
      if (boxId === undefined && (typeof sessionId !== 'string' || sessionId === '')) return
      abortable.current?.abort()
      const controller = new AbortController()
      abortable.current = controller
      packStore.set({ status: 'preparing', title: title ?? '', sessionId, received: 0, total: 0, error: null })
      try {
        const query = boxId === undefined ? new URLSearchParams({ sessionId }) : new URLSearchParams({ boxId })
        if (boxId === undefined && typeof title === 'string' && title.trim() !== '') query.set('title', title.trim())
        const response = await fetch(`${ROUTE_EXPORT}?${query.toString()}`, { signal: controller.signal })
        if (!response.ok) throw await packFailure(response)
        const total = Number(response.headers.get('content-length') ?? 0)
        const filename = filenameOf(response, sessionId ?? boxId ?? 'pack', title)
        const chunks = []
        let received = 0
        if (response.body !== null && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            received += value.byteLength
            packStore.set({ status: 'downloading', title: title ?? '', sessionId, received, total, error: null })
          }
        } else {
          const buffer = new Uint8Array(await response.arrayBuffer())
          chunks.push(buffer)
          received = buffer.byteLength
        }
        const blob = new Blob(chunks, { type: 'application/zip' })
        packStore.set({ status: 'saving', title: title ?? '', sessionId, received, total, error: null })
        const outcome = await saveBlob(blob, filename)
        if (outcome === 'cancelled') {
          packStore.set({ status: 'idle', title: '', sessionId: '', received: 0, total: 0, error: null })
          return
        }
        packStore.set({ status: 'done', title: title ?? '', sessionId, received, total, error: null })
        setTimeout(() => {
          if (packStore.get().status === 'done') packStore.set({ status: 'idle', title: '', sessionId: '', received: 0, total: 0, error: null })
        }, 4000)
      } catch (error) {
        if (controller.signal.aborted) {
          packStore.set({ status: 'idle', title: '', sessionId: '', received: 0, total: 0, error: null })
          return
        }
        if (error?.code === 'TRANSFER_SESSION_NOT_FOUND') {
          try {
            clientCtx?.get('sessions')?.refresh?.()
          } catch {
            /* the next focus refresh repairs the list anyway */
          }
        }
        packStore.set({ status: 'failed', title: title ?? '', sessionId, received: 0, total: 0, error: messageOf(error), code: error?.code ?? null })
      } finally {
        if (abortable.current === controller) abortable.current = null
      }
    }

    /**
     * Save one archive through the browser picker when available, falling back
     * to the download manager. A cancelled picker is not a failure.
     * @param blob - archive bytes.
     * @param filename - suggested name.
     * @returns `saved`, `downloaded`, or `cancelled`.
     */
    async function saveBlob(blob, filename) {
      const picker = globalThis.showSaveFilePicker
      if (typeof picker === 'function') {
        try {
          const handle = await picker({
            suggestedName: filename,
            types: [{ description: 'DSH session pack', accept: { 'application/zip': ['.dshpack'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          return 'saved'
        } catch (error) {
          if (error?.name === 'AbortError') return 'cancelled'
          /* fall back to the download manager */
        }
      }
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return 'downloaded'
    }

    function filenameOf(response, sessionId, title) {
      const disposition = response.headers.get('content-disposition') ?? ''
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)
      if (encoded !== null) {
        try {
          return decodeURIComponent(encoded[1])
        } catch {
          /* fall through */
        }
      }
      const plain = /filename="([^"]+)"/u.exec(disposition)
      if (plain !== null) return plain[1]
      const base = typeof title === 'string' && title.trim() !== '' ? title.trim().replace(/[\\/:*?"<>|]/gu, '_') : `session-${sessionId.replace(/^session-/u, '').slice(0, 8)}`
      return `${base}.dshpack`
    }

    /** Boxes containing one session, read from the boxes plugin's public route. */
    async function boxesForSession(sessionId) {
      const response = await fetch('/session-boxes', { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const state = payload?.state
      const boxIds = Array.isArray(state?.memberships?.[sessionId]) ? state.memberships[sessionId] : []
      return (Array.isArray(state?.boxes) ? state.boxes : []).filter((box) => boxIds.includes(box.id))
    }

    /** Pack the whole box this session belongs to (picker when it sits in several). */
    async function packBoxForSession(sessionId, displayTitle) {
      try {
        const boxes = await boxesForSession(sessionId)
        if (boxes.length === 0) {
          packStore.set({ status: 'failed', title: displayTitle ?? '', sessionId, received: 0, total: 0, error: '这个会话不在任何盒子里', code: 'BOX_NONE' })
          return
        }
        if (boxes.length === 1) {
          await packSession({ boxId: boxes[0].id }, boxes[0].name)
          return
        }
        boxPickStore.set({ open: true, sessionId, title: displayTitle ?? '', boxes })
      } catch (error) {
        packStore.set({ status: 'failed', title: displayTitle ?? '', sessionId, received: 0, total: 0, error: `读取盒子失败：${messageOf(error)}`, code: 'BOX_ERROR' })
      }
    }

    /* ------------------------------------------------------------------ *
     * Import dialog: preflight, confirm, import
     * ------------------------------------------------------------------ */

    function openDialog() {
      dialogStore.set({ ...EMPTY_DIALOG, open: true })
    }

    function closeDialog() {
      const current = dialogStore.get()
      if (current.phase === 'uploading') return
      dialogStore.set(EMPTY_DIALOG)
    }

    /** Reset the preflight whenever the file or target workspace changes. */
    function resetPlan(patch) {
      inspectSequence += 1
      dialogStore.set({
        ...dialogStore.get(),
        plan: null,
        token: null,
        result: null,
        error: null,
        phase: 'idle',
        ...patch,
      })
    }

    async function inspectPack(ctx, t) {
      const state = dialogStore.get()
      const file = state.file
      if (file === null || file === undefined || state.workspaceId === '') return
      const sequence = ++inspectSequence
      dialogStore.set({ ...state, phase: 'inspecting', error: null, result: null })
      try {
        const inspectQuery = new URLSearchParams({ workspaceId: state.workspaceId, boxMode: state.boxMode })
        const response = await fetch(`${ROUTE_INSPECT}?${inspectQuery.toString()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        })
        if (!response.ok) throw await failureOf(response, t)
        const payload = await response.json()
        if (payload?.ok !== true) throw payloadFailure(payload, t)
        if (sequence !== inspectSequence) return
        dialogStore.set({ ...dialogStore.get(), phase: 'planned', plan: payload.plan, token: payload.token })
      } catch (error) {
        if (sequence !== inspectSequence) return
        dialogStore.set({ ...dialogStore.get(), phase: 'failed', error: { code: error?.code, message: messageOf(error) } })
      }
    }

    /** Create a workspace from the dialog and select it as the import target. */
    async function createWorkspaceNow(t) {
      const state = dialogStore.get()
      const path = state.workspacePath.trim()
      if (path === '') return
      dialogStore.set({ ...state, workspaceBusy: true, workspaceError: null })
      try {
        const response = await fetch(ROUTE_WORKSPACE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        })
        if (!response.ok) throw await failureOf(response, t)
        const payload = await response.json()
        if (payload?.ok !== true) throw payloadFailure(payload, t)
        const workspace = payload.workspace
        const current = dialogStore.get()
        const others = (current.workspaces ?? []).filter((row) => row.id !== workspace.id)
        dialogStore.set({
          ...current,
          workspaces: [...others, workspace],
          workspaceId: workspace.id,
          newWorkspace: false,
          workspaceBusy: false,
          workspacePath: '',
          workspaceError: null,
        })
      } catch (error) {
        dialogStore.set({ ...dialogStore.get(), workspaceBusy: false, workspaceError: messageOf(error) })
      }
    }

    async function runImport(ctx, t) {
      const state = dialogStore.get()
      if (state.token === null || state.phase !== 'planned') return
      const progressToken = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `p-${Date.now()}`
      let source
      if (typeof EventSource === 'function') {
        source = new EventSource(`${ROUTE_PROGRESS}?token=${encodeURIComponent(progressToken)}`)
        source.onmessage = (event) => {
          try {
            const snapshot = JSON.parse(event.data)
            dialogStore.set({ ...dialogStore.get(), progress: snapshot })
          } catch {
            /* a malformed frame is ignored */
          }
        }
      }
      dialogStore.set({ ...state, phase: 'uploading', progress: { phase: 'starting', done: 0, total: 0 }, error: null })
      try {
        const query = new URLSearchParams({ token: state.token, boxMode: state.boxMode, progressToken })
        if (state.workspaceId !== '') query.set('workspaceId', state.workspaceId)
        const response = await fetch(`${ROUTE_IMPORT}?${query.toString()}`, { method: 'POST' })
        if (!response.ok) throw await failureOf(response, t)
        const result = await response.json()
        if (result?.ok !== true) throw payloadFailure(result, t)
        const workspace = dialogStore.get().workspaces?.find((row) => row.id === result.workspaceId)
        dialogStore.set({
          ...dialogStore.get(),
          phase: 'done',
          token: null,
          result: { ...result, workspaceTitle: workspace?.title ?? result.workspaceId },
        })
        try {
          ctx.get('sessions')?.refresh?.()
        } catch {
          /* the list refreshes on the next focus anyway */
        }
      } catch (error) {
        dialogStore.set({ ...dialogStore.get(), phase: 'failed', token: null, progress: null, error: { code: error?.code, message: messageOf(error) } })
      } finally {
        source?.close()
      }
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function BoxIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 5.2 8 2l5.5 3.2v5.6L8 14l-5.5-3.2V5.2Z', stroke: 'currentColor', strokeWidth: '1.2', strokeLinejoin: 'round' }),
        h('path', { d: 'M2.7 5.3 8 8.3l5.3-3', stroke: 'currentColor', strokeWidth: '1.2', strokeLinejoin: 'round' }),
        h('path', { d: 'M8 8.3V14', stroke: 'currentColor', strokeWidth: '1.2' }),
      )
    }

    function ImportIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M8 2v7', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
        h('path', { d: 'M5 6.5 8 9.5l3-3', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M2.5 10.5v1.8c0 .7.5 1.2 1.2 1.2h8.6c.7 0 1.2-.5 1.2-1.2v-1.8', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
      )
    }

    /** Menu item: pack one session and close the menu. */
    function SessionPackMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const useMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState : () => [false, () => {}]
      const [, setMenuOpen] = useMenu()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dst-menuItem',
        onClick: () => {
          setMenuOpen(false)
          packSession(sessionId, displayTitle)
        },
      },
        h('span', { className: 'dst-menuItem__icon' }, h(BoxIcon, {})),
        h('span', { className: 'dst-menuItem__label' }, t('menu.pack')),
      )
    }

    /** Menu item: pack the whole box this session belongs to. */
    function SessionPackBoxMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const useMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState : () => [false, () => {}]
      const [, setMenuOpen] = useMenu()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dst-menuItem',
        onClick: () => {
          setMenuOpen(false)
          void packBoxForSession(sessionId, displayTitle)
        },
      },
        h('span', { className: 'dst-menuItem__icon' }, h(BoxIcon, {})),
        h('span', { className: 'dst-menuItem__label' }, t('menu.packBox')),
      )
    }

    /** Dialog shown when the session sits in more than one box. */
    function BoxPicker({ t }) {
      const state = useStore(boxPickStore)
      if (!state.open) return null
      const close = () => boxPickStore.set(EMPTY_BOX_PICK)
      return h('div', {
        className: 'dst-backdrop',
        role: 'presentation',
        onClick: (event) => {
          if (event.target === event.currentTarget) close()
        },
      },
        h('div', { className: 'dst-dialog dst-boxPick', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('box.pick.title') },
          h('div', { className: 'dst-dialog__head' },
            h('span', { className: 'dst-dialog__title' }, t('box.pick.title')),
            h('button', { type: 'button', className: 'dst-close', title: t('dialog.close'), 'aria-label': t('dialog.close'), onClick: close }, '×'),
          ),
          h('p', { className: 'dst-dialog__hint' }, t('box.pick.hint')),
          h('div', { className: 'dst-boxPickList' }, state.boxes.map((box) => h('button', {
            key: box.id,
            type: 'button',
            className: 'dst-boxPickItem',
            onClick: () => {
              close()
              void packSession({ boxId: box.id }, box.name)
            },
          },
            h('span', { className: `dst-boxDot is-${box.color ?? 'blue'}` }),
            h('span', { className: 'dst-boxPickName' }, box.name),
          ))),
          h('div', { className: 'dst-dialog__actions' },
            h('button', { type: 'button', className: 'dst-button is-ghost', onClick: close }, t('box.pick.cancel')),
          ),
        ),
      )
    }

    /** Sidebar footer: open the import dialog. */
    function ImportFooterAction({ wide, openImport, t }) {
      return h('button', {
        type: 'button',
        className: wide ? 'dst-footerButton' : 'dst-footerButton is-compact',
        title: t('footer.import'),
        'aria-label': t('footer.import'),
        onClick: openImport,
      },
        h(ImportIcon, { size: 16 }),
        wide && h('span', { className: 'dst-footerButton__label' }, t('footer.import.short')),
      )
    }

    /** Progress card for the pack download, mounted in the shell overlay. */
    function PackProgressCard({ t }) {
      const state = useStore(packStore)
      if (state.status === 'idle') return null
      const percent = state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : 0
      const description = state.status === 'failed'
        ? state.error ?? t('pack.card.failed')
        : state.status === 'done'
          ? t('pack.card.done')
          : state.status === 'saving'
            ? t('pack.card.saving')
            : state.status === 'downloading'
              ? t('pack.card.downloading', { percent: String(percent) })
              : t('pack.card.preparing')
      return h('div', { className: 'dst-toast is-card', role: 'status' },
        h('div', { className: 'dst-toast__head' },
          h('span', { className: state.status === 'failed' ? 'dst-dot is-error' : state.status === 'done' ? 'dst-dot is-ok' : 'dst-dot is-busy' }),
          h('span', { className: 'dst-toast__title' }, state.title === '' ? t('pack.card.title') : state.title),
        ),
        h('div', { className: 'dst-toast__text' }, description),
        state.status === 'failed' && state.code === 'TRANSFER_SESSION_NOT_FOUND' && h('div', { className: 'dst-toast__hint' }, t('pack.card.missing')),
        state.status === 'failed' && state.code === 'HTTP_404' && h('div', { className: 'dst-toast__hint' }, t('pack.card.host')),
        state.status !== 'failed' && state.status !== 'done' && h('div', { className: 'dst-progress' },
          h('div', { className: 'dst-progress__bar', style: { width: `${state.total > 0 ? percent : 15}%` } }),
        ),
        (state.status === 'preparing' || state.status === 'downloading') && h('button', {
          type: 'button',
          className: 'dst-link',
          onClick: () => abortable.current?.abort(),
        }, t('pack.card.cancel')),
      )
    }

    function PlanRow({ label, value }) {
      return h('div', { className: 'dst-plan__row' },
        h('span', { className: 'dst-plan__key' }, label),
        h('span', { className: 'dst-plan__value' }, value),
      )
    }

    /** Summary of what the preflight found, shown before any write happens. */
    function PlanCard({ plan, boxMode, onBoxMode, t }) {
      const sessions = Array.isArray(plan?.sessions) ? plan.sessions : []
      const box = plan?.box
      const copies = sessions.filter((row) => row.id !== row.originalId).length
      const source = plan?.source ?? {}
      const sourceParts = []
      if (typeof source.dshVersion === 'string' && source.dshVersion !== '') sourceParts.push(`DSH ${source.dshVersion}`)
      if (Number.isSafeInteger(source.sessionFormatVersion)) sourceParts.push(`v${source.sessionFormatVersion}`)
      if (Number.isSafeInteger(plan?.packCreatedAt) && plan.packCreatedAt > 0) sourceParts.push(new Date(plan.packCreatedAt).toLocaleString())
      return h('div', { className: 'dst-plan' },
        h('div', { className: 'dst-plan__title' }, typeof plan?.title === 'string' && plan.title !== '' ? plan.title : t('plan.emptyTitle')),
        h('div', { className: 'dst-plan__rows' },
          h(PlanRow, { label: t('plan.sessions'), value: `${sessions.length}${copies > 0 ? ` · ${t('plan.copies', { count: String(copies) })}` : ''}` }),
          h(PlanRow, { label: t('plan.events'), value: String(plan?.events ?? 0) }),
          h(PlanRow, { label: t('plan.attachments'), value: String(plan?.attachments ?? 0) }),
          h(PlanRow, { label: t('plan.target'), value: String(plan?.workspacePath ?? '') }),
          sourceParts.length > 0 && h(PlanRow, { label: t('plan.source'), value: sourceParts.join(' · ') }),
        ),
        box !== undefined && h('div', { className: 'dst-planBox' },
          h('div', { className: 'dst-planBox__head' }, `${t('plan.box')} · ${box.name === '' ? '—' : box.name}`),
          box.available === false
            ? h('div', { className: 'dst-planBox__note' }, t('plan.boxUnavailable', { reason: box.reason ?? '' }))
            : h('div', { className: 'dst-planBox__note' }, t('plan.boxCounts', {
              reuse: String(box.counts?.reuse ?? 0),
              create: String(box.counts?.create ?? 0),
              skip: String(box.counts?.skip ?? 0),
            })),
          box.available !== false && h('div', { className: 'dst-planBox__mode' },
            h('span', { className: 'dst-planBox__modeLabel' }, t('plan.boxMode')),
            h('button', {
              type: 'button',
              className: boxMode === 'reuse' ? 'dst-chip is-on' : 'dst-chip',
              'aria-pressed': boxMode === 'reuse',
              onClick: () => onBoxMode('reuse'),
            }, t('plan.boxReuse')),
            h('button', {
              type: 'button',
              className: boxMode === 'copy' ? 'dst-chip is-on' : 'dst-chip',
              'aria-pressed': boxMode === 'copy',
              onClick: () => onBoxMode('copy'),
            }, t('plan.boxCopy')),
          ),
          box.available !== false && boxMode === 'copy' && h('div', { className: 'dst-planBox__note' },
            t('plan.boxCopyName', { name: `${box.name}（导入）` }),
          ),
        ),
        Array.isArray(plan?.warnings) && plan.warnings.length > 0 && h('div', { className: 'dst-warnings' },
          h('div', { className: 'dst-warnings__title' }, t('warn.title')),
          h('ul', {}, plan.warnings.map((warning, index) => h('li', { key: index }, warning))),
        ),
      )
    }

    /** The import dialog, mounted in the shell overlay. */
    function ImportDialog({ t, hostCtx }) {
      const state = useStore(dialogStore)
      const [dragOver, setDragOver] = useState(false)
      const inputRef = useRef(null)
      const primaryRef = useRef(null)
      const dialogRef = useRef(null)
      const loadingRef = useRef(false)
      const busy = state.phase === 'uploading'
      const inspecting = state.phase === 'inspecting'
      const done = state.phase === 'done'
      const failed = state.phase === 'failed'
      const progressTotal = Number.isFinite(state.progress?.total) ? state.progress.total : 0
      const progressDone = Number.isFinite(state.progress?.done) ? state.progress.done : 0
      const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 12
      const planned = state.phase === 'planned'
      const file = state.file
      const view = failed ? errorView(state, t) : null

      // Load the workspace picker once per opening; retry after a failed load.
      useEffect(() => {
        if (!state.open || state.workspaces !== null || loadingRef.current) return
        loadingRef.current = true
        fetch(ROUTE_WORKSPACES, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(t('error.http', { status: String(response.status) }))
            const payload = await response.json()
            const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : []
            const current = dialogStore.get()
            dialogStore.set({
              ...current,
              workspaces,
              workspaceId: workspaces[0]?.id ?? '',
              newWorkspace: workspaces.length === 0,
              error: current.workspacesFailed ? null : current.error,
              workspacesFailed: false,
            })
          })
          .catch((error) => {
            const current = dialogStore.get()
            dialogStore.set({ ...current, workspaces: [], workspacesFailed: true, workspaceMessage: `${t('error.workspaces')}：${messageOf(error)}` })
          })
          .finally(() => {
            loadingRef.current = false
          })
      }, [state.open, state.workspaces, t])

      // Preflight automatically once a file and a workspace are both present.
      useEffect(() => {
        if (!state.open || state.phase !== 'idle' || file === null || state.workspaceId === '') return
        void inspectPack(hostCtx, t)
      }, [state.open, state.phase, file, state.workspaceId, hostCtx, t])

      // Focus the confirm button as soon as the plan is ready.
      useEffect(() => {
        if (planned) primaryRef.current?.focus({ preventScroll: true })
      }, [planned])

      // Keyboard: Esc closes, Enter confirms, Tab stays inside the dialog.
      useEffect(() => {
        if (!state.open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeDialog()
            return
          }
          if (event.key === 'Enter' && dialogStore.get().phase === 'planned') {
            const tag = event.target?.tagName
            if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return
            event.preventDefault()
            void runImport(hostCtx, t)
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])')]
            .filter((element) => element.getClientRects().length > 0)
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [state.open, hostCtx, t])

      // Restore focus to the control that opened the dialog.
      useEffect(() => {
        if (!state.open) return undefined
        const previous = document.activeElement
        return () => {
          try {
            previous?.focus?.({ preventScroll: true })
          } catch {
            /* the opener went away */
          }
        }
      }, [state.open])

      if (!state.open) return null

      function pickFile(picked) {
        if (!picked) return
        const name = String(picked.name ?? '')
        if (!/\.(dshpack|zip)$/iu.test(name)) {
          dialogStore.set({ ...dialogStore.get(), phase: 'failed', error: { code: 'BAD_FILE', message: t('dialog.badFile') } })
          return
        }
        resetPlan({ file: picked })
      }

      function openImportedSession(sessionId) {
        try {
          hostCtx?.get('uiWorkspace')?.openSession?.(sessionId)
        } catch {
          /* navigation is best effort; the sidebar row still opens it */
        }
        closeDialog()
      }

      return h('div', {
        className: 'dst-backdrop',
        role: 'presentation',
        onClick: (event) => {
          if (event.target === event.currentTarget && !busy) closeDialog()
        },
      },
        h('div', {
          ref: dialogRef,
          className: 'dst-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dialog.title'),
        },
          h('div', { className: 'dst-dialog__head' },
            h('span', { className: 'dst-dialog__title' }, t('dialog.title')),
            h('button', {
              type: 'button',
              className: 'dst-close',
              title: t('dialog.close'),
              'aria-label': t('dialog.close'),
              disabled: busy,
              onClick: closeDialog,
            }, '×'),
          ),
          h('p', { className: 'dst-dialog__hint' }, t('dialog.hint')),

          done
            ? h('div', { className: 'dst-result' },
              h('div', { className: 'dst-result__title' }, `✓ ${t('dialog.success.title')}`),
              state.result?.title ? h('div', { className: 'dst-result__session' }, state.result.title) : null,
              h('div', { className: 'dst-result__text' }, t('dialog.success.hint', { workspace: state.result?.workspaceTitle ?? '' })),
              state.result?.boxResult?.ok === true && h('div', { className: 'dst-result__text' },
                t('result.box', {
                  ok: String(state.result.boxResult.results.filter((row) => row.ok).length),
                  total: String(state.result.boxResult.results.length),
                }),
              ),
              state.result?.boxResult?.ok === false && h('div', { className: 'dst-result__text is-warn' },
                t('result.boxFailed', { error: state.result.boxResult.error ?? '' }),
              ),
              Array.isArray(state.result?.warnings) && state.result.warnings.length > 0 && h('div', { className: 'dst-warnings' },
                h('div', { className: 'dst-warnings__title' }, t('warn.title')),
                h('ul', {}, state.result.warnings.map((warning, index) => h('li', { key: index }, warning))),
              ),
              h('div', { className: 'dst-dialog__actions' },
                h('button', { type: 'button', className: 'dst-button is-ghost', onClick: closeDialog }, t('dialog.done')),
                h('button', {
                  type: 'button',
                  className: 'dst-button is-primary',
                  onClick: () => openImportedSession(state.result?.sessionId),
                }, t('dialog.open')),
              ),
            )
            : h(React.Fragment, null,
              h('label', { className: 'dst-field' },
                h('span', { className: 'dst-field__label' }, t('dialog.workspace')),
                state.workspaces === null
                  ? h('span', { className: 'dst-field__value' }, '…')
                  : state.workspacesFailed
                    ? h('div', { className: 'dst-field__error' },
                      h('span', {}, state.workspaceMessage ?? t('error.workspaces')),
                      h('button', {
                        type: 'button',
                        className: 'dst-link',
                        onClick: () => dialogStore.set({ ...dialogStore.get(), workspaces: null, workspacesFailed: false, workspaceMessage: null }),
                      }, t('dialog.retry')),
                    )
                    : h(React.Fragment, null,
                      h('select', {
                        className: 'dst-select',
                        value: state.newWorkspace ? '__new__' : state.workspaceId,
                        disabled: busy || inspecting || state.workspaceBusy,
                        onChange: (event) => {
                          if (event.target.value === '__new__') {
                            dialogStore.set({ ...dialogStore.get(), newWorkspace: true, workspaceError: null })
                          } else {
                            resetPlan({ workspaceId: event.target.value, newWorkspace: false })
                          }
                        },
                      },
                        state.workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, `${workspace.title} — ${workspace.path}`)),
                        h('option', { value: '__new__' }, t('dialog.workspace.new')),
                      ),
                      state.newWorkspace && h('div', { className: 'dst-newWs' },
                        h('input', {
                          className: 'dst-input',
                          type: 'text',
                          value: state.workspacePath,
                          placeholder: t('dialog.workspace.path'),
                          disabled: state.workspaceBusy,
                          onChange: (event) => dialogStore.set({ ...dialogStore.get(), workspacePath: event.target.value }),
                        }),
                        h('div', { className: 'dst-newWs__actions' },
                          h('button', {
                            type: 'button',
                            className: 'dst-button is-primary',
                            disabled: state.workspaceBusy || state.workspacePath.trim() === '',
                            onClick: () => void createWorkspaceNow(t),
                          }, state.workspaceBusy ? t('dialog.workspace.creating') : t('dialog.workspace.create')),
                          h('button', {
                            type: 'button',
                            className: 'dst-button is-ghost',
                            disabled: state.workspaceBusy,
                            onClick: () => dialogStore.set({ ...dialogStore.get(), newWorkspace: false, workspaceError: null }),
                          }, t('dialog.cancel')),
                        ),
                        state.workspaceError !== null && h('div', { className: 'dst-field__error' }, state.workspaceError),
                      ),
                    ),
              ),
              h('div', {
                className: dragOver ? 'dst-drop is-over' : 'dst-drop',
                onDragOver: (event) => {
                  event.preventDefault()
                  setDragOver(true)
                },
                onDragLeave: () => setDragOver(false),
                onDrop: (event) => {
                  event.preventDefault()
                  setDragOver(false)
                  pickFile(event.dataTransfer?.files?.[0])
                },
              },
                h('input', {
                  ref: inputRef,
                  type: 'file',
                  accept: '.dshpack,.zip,application/zip',
                  className: 'dst-fileInput',
                  disabled: busy || inspecting,
                  onChange: (event) => pickFile(event.target.files?.[0]),
                }),
                file === null
                  ? h(React.Fragment, null,
                    h('button', {
                      type: 'button',
                      className: 'dst-drop__pick',
                      disabled: busy || inspecting,
                      onClick: () => inputRef.current?.click(),
                    }, h(ImportIcon, { size: 18 }), h('span', {}, t('dialog.choose'))),
                    h('span', { className: 'dst-drop__hint' }, t('dialog.drop')),
                  )
                  : h(React.Fragment, null,
                    h('span', { className: 'dst-drop__name' }, file.name),
                    h('span', { className: 'dst-drop__hint' }, formatSize(file.size)),
                    h('button', {
                      type: 'button',
                      className: 'dst-link',
                      disabled: busy || inspecting,
                      onClick: () => inputRef.current?.click(),
                    }, t('dialog.replace')),
                  ),
              ),
              inspecting && h('div', { className: 'dst-working' },
                h('span', { className: 'dst-spinner' }),
                h('span', {}, t('dialog.inspecting')),
              ),
              planned && h(PlanCard, {
                plan: state.plan,
                boxMode: state.boxMode,
                onBoxMode: (mode) => dialogStore.set({ ...dialogStore.get(), boxMode: mode }),
                t,
              }),
              busy && state.progress !== null && h('div', { className: 'dst-working' },
                h('div', { className: 'dst-progress is-wide' },
                  h('div', {
                    className: 'dst-progress__bar',
                    style: { width: `${progressPercent}%` },
                  }),
                ),
                h('span', {}, progressLabel(state.progress, t)),
                h('span', { className: 'dst-working__hint' }, t('dialog.workingHint')),
              ),
              busy && state.progress === null && h('div', { className: 'dst-working' },
                h('span', { className: 'dst-spinner' }),
                h('span', {}, t('dialog.working')),
                h('span', { className: 'dst-working__hint' }, t('dialog.workingHint')),
              ),
              !busy && failed && view !== null && h('div', { className: 'dst-error' },
                h('div', { className: 'dst-error__title' }, view.title),
                h('div', { className: 'dst-error__text' }, view.message),
                view.hint !== null && h('div', { className: 'dst-error__hint' }, view.hint),
              ),
              !busy && !done && h('div', { className: 'dst-dialog__actions' },
                h('button', { type: 'button', className: 'dst-button is-ghost', onClick: closeDialog }, t('dialog.cancel')),
                failed && file !== null
                  ? h('button', {
                    type: 'button',
                    className: 'dst-button is-primary',
                    onClick: () => resetPlan({}),
                  }, t('dialog.retry'))
                  : h('button', {
                    ref: primaryRef,
                    type: 'button',
                    className: 'dst-button is-primary',
                    disabled: !planned,
                    onClick: () => runImport(hostCtx, t),
                  }, t('dialog.confirm')),
              ),
            ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dst-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}',
      '.dst-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dst-menuItem__icon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary)}',
      '.dst-footerButton{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,6px);',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dst-footerButton:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dst-footerButton.is-compact{width:30px;justify-content:center;padding:0}',
      '.dst-footerButton__label{white-space:nowrap}',
      '.dst-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;',
      'background:color-mix(in srgb, #000 32%, transparent);padding:24px}',
      '.dst-dialog{width:min(540px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;padding:18px 18px 14px;',
      'border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 18px 48px color-mix(in srgb, #000 28%, transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dst-dialog__head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dst-dialog__title{font-size:15px;font-weight:600}',
      '.dst-close{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font-size:18px;line-height:1;cursor:pointer}',
      '.dst-close:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dst-dialog__hint{margin:8px 0 14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dst-field{display:block;margin-bottom:12px}',
      '.dst-field__label{display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dst-field__value{display:block;font-size:12px}',
      '.dst-field__value.is-muted{color:var(--dsw-alias-state-warn-primary)}',
      '.dst-field__error{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '.dst-select{width:100%;height:32px;padding:0 8px;box-sizing:border-box;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dst-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:96px;padding:12px;',
      'border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);text-align:center}',
      '.dst-drop.is-over{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}',
      '.dst-fileInput{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
      '.dst-drop__pick{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dst-drop__pick:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.dst-drop__name{font-size:12px;font-weight:600;word-break:break-all}',
      '.dst-drop__hint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-link{padding:2px 4px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dst-link:hover{text-decoration:underline}',
      '.dst-working{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12px}',
      '.dst-working__hint{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-spinner{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);',
      'border-radius:50%;animation:dst-spin .8s linear infinite}',
      '@keyframes dst-spin{to{transform:rotate(360deg)}}',
      '.dst-plan{margin-top:14px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dst-plan__title{font-size:13px;font-weight:600;word-break:break-word}',
      '.dst-plan__rows{margin-top:8px;display:flex;flex-direction:column;gap:4px}',
      '.dst-plan__row{display:flex;gap:10px;font-size:12px;line-height:1.45}',
      '.dst-plan__key{flex:none;width:64px;color:var(--dsw-alias-label-secondary)}',
      '.dst-plan__value{flex:1;min-width:0;word-break:break-word}',
      '.dst-newWs{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.dst-newWs__actions{display:flex;gap:6px}',
      '.dst-input{width:100%;height:30px;padding:0 8px;box-sizing:border-box;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dst-progress.is-wide{width:100%;height:5px;margin-top:4px}',
      '.dst-planBox{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dst-planBox__head{font-size:12px;font-weight:600}',
      '.dst-planBox__note{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dst-planBox__mode{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}',
      '.dst-planBox__modeLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-chip{height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}',
      '.dst-chip.is-on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);',
      'color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dst-selfTest{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2);margin-top:16px}',
      '.dst-selfTest__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dst-selfTest__title{font-size:13px;font-weight:600}',
      '.dst-selfTest__summary{flex:1;min-width:120px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dst-selfTest__items{display:flex;flex-direction:column;gap:6px}',
      '.dst-selfTest__row{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;font-size:12px}',
      '.dst-selfTest__label{color:var(--dsw-alias-label-primary)}',
      '.dst-selfTest__detail{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dst-selfTest__badge{justify-self:end;padding:1px 8px;border-radius:999px;font-size:11px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.dst-selfTest__badge.is-pass{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.dst-selfTest__badge.is-fail{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.dst-selfTest__badge.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.dst-selfTest__badge.is-running{color:var(--dsw-alias-brand-primary);border-color:currentColor}',
      '.dst-selfTest__error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dst-boxPickList{display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto}',
      '.dst-boxPickItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left}',
      '.dst-boxPickItem:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.dst-boxPickName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dst-boxDot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}',
      '.dst-boxDot.is-blue{background:#4C8DFF}.dst-boxDot.is-green{background:#3FB950}.dst-boxDot.is-amber{background:#D29922}',
      '.dst-boxDot.is-red{background:#F85149}.dst-boxDot.is-purple{background:#A371F7}.dst-boxDot.is-pink{background:#DB61A2}',
      '.dst-boxDot.is-cyan{background:#39C5CF}.dst-boxDot.is-gray{background:#8B949E}',
      '.dst-result__text.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dst-error{margin-top:12px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}',
      '.dst-error__title{font-size:12px;font-weight:600;color:var(--dsw-alias-state-error-primary)}',
      '.dst-error__text{margin-top:2px;font-size:12px;white-space:pre-wrap;word-break:break-word}',
      '.dst-error__hint{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-dialog__actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.dst-button{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dst-button.is-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dst-button:disabled{opacity:.5;cursor:default}',
      '.dst-button.is-ghost{color:var(--dsw-alias-label-secondary)}',
      '.dst-button:hover:not(:disabled){filter:brightness(1.05)}',
      '.dst-result__title{font-size:14px;font-weight:600;color:var(--dsw-alias-state-success-primary)}',
      '.dst-result__session{margin-top:6px;font-size:13px;font-weight:600;word-break:break-word}',
      '.dst-result__text{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dst-warnings{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dst-warnings__title{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary)}',
      '.dst-warnings ul{margin:4px 0 0;padding-left:18px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;display:flex;flex-direction:column;gap:6px;',
      'min-width:260px;max-width:min(420px,calc(100vw - 32px));padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px color-mix(in srgb, #000 24%, transparent);',
      'font-size:12px;line-height:1.4}',
      '.dst-toast__head{display:flex;align-items:center;gap:8px}',
      '.dst-toast__title{font-weight:600;word-break:break-word}',
      '.dst-toast__text{color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dst-toast__hint{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dst-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none}',
      '.dst-dot.is-ok{background:var(--dsw-alias-state-success-primary)}',
      '.dst-dot.is-error{background:var(--dsw-alias-state-error-primary)}',
      '.dst-dot.is-busy{background:var(--dsw-alias-brand-primary);animation:dst-pulse 1.2s ease-in-out infinite}',
      '@keyframes dst-pulse{50%{opacity:.35}}',
      '.dst-progress{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dst-progress__bar{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.dst-menuItem:focus-visible,.dst-footerButton:focus-visible,.dst-button:focus-visible,',
      '.dst-close:focus-visible,.dst-link:focus-visible,.dst-drop__pick:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('')

    /** Resolve this plugin's name from either detail-subject shape (bundle or item). */
    function subjectPluginName(subject) {
      if (subject?.kind === 'bundle') return subject?.pkg?.name
      if (subject?.kind === 'item' && typeof subject?.id === 'string') {
        return subject.id === 'dsh-session-transfer' || subject.id === 'include:dsh-session-transfer'
          ? 'dsh-session-transfer'
          : undefined
      }
      return undefined
    }

    /** Plugin-detail self-test: four checks, run only when the button is pressed. */
    function SelfTestSection({ subject, t }) {
      const pluginName = subjectPluginName(subject)
      const idleItems = () => ['health', 'tools', 'boxes', 'writable'].map((id) => ({
        id,
        label: t(`selftest.item.${id}`),
        status: 'idle',
      }))
      const [state, setState] = React.useState(() => ({
        running: false,
        items: idleItems(),
        summary: null,
        error: null,
        copied: false,
        markdown: '',
      }))
      if (pluginName !== 'dsh-session-transfer') return null

      const summary = state.running
        ? t('selftest.running')
        : state.summary === null
          ? t('selftest.idle')
          : t('selftest.summary', {
            pass: String(state.summary.pass),
            fail: String(state.summary.fail),
            warn: String(state.summary.warn),
          })

      async function run() {
        setState({
          running: true,
          items: idleItems().map((row) => ({ ...row, status: 'running' })),
          summary: null,
          error: null,
          copied: false,
          markdown: '',
        })
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)
        try {
          const response = await fetch(`/session-transfer/selftest?lang=${encodeURIComponent(t('selftest.lang'))}`, { signal: controller.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          setState({
            running: false,
            items: Array.isArray(payload?.items) ? payload.items : idleItems(),
            summary: payload?.summary ?? null,
            error: null,
            copied: false,
            markdown: typeof payload?.markdown === 'string' ? payload.markdown : '',
          })
        } catch (error) {
          const reason = messageOf(error)
          setState({
            running: false,
            items: idleItems().map((row) => ({ ...row, status: 'fail', detail: reason })),
            summary: { pass: 0, fail: 4, warn: 0 },
            error: reason,
            copied: false,
            markdown: '',
          })
        } finally {
          clearTimeout(timer)
        }
      }

      async function copy() {
        if (state.markdown === '') return
        try {
          await navigator.clipboard.writeText(state.markdown)
          setState({ ...state, copied: true })
        } catch {
          /* clipboard denied; the result stays on screen */
        }
      }

      return h('section', { className: 'dst-selfTest', 'data-plugin': 'dsh-session-transfer' },
        h('div', { className: 'dst-selfTest__head' },
          h('span', { className: 'dst-selfTest__title' }, t('selftest.title')),
          h('span', { className: 'dst-selfTest__summary' }, summary),
          h('button', {
            type: 'button',
            className: 'dst-button is-primary',
            disabled: state.running,
            onClick: () => void run(),
          }, state.running ? t('selftest.running') : (state.summary === null ? t('selftest.run') : t('selftest.rerun'))),
          h('button', {
            type: 'button',
            className: 'dst-button is-ghost',
            disabled: state.markdown === '',
            onClick: () => void copy(),
          }, state.copied ? t('selftest.copied') : t('selftest.copy')),
        ),
        state.error !== null && h('div', { className: 'dst-selfTest__error' }, t('selftest.error', { error: state.error })),
        h('div', { className: 'dst-selfTest__items' }, state.items.map((row) => h('div', { key: row.id, className: 'dst-selfTest__row' },
          h('span', { className: 'dst-selfTest__label' }, row.label ?? row.id),
          h('span', { className: `dst-selfTest__badge is-${row.status}` }, t(`selftest.${row.status}`)),
          typeof row.detail === 'string' && row.detail !== '' && h('div', { className: 'dst-selfTest__detail' }, row.detail),
        ))),
      )
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-session-transfer/SessionTransfer.css')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-transfer: styles')

        ctx.effect(() => ctx.locale.register(NS, {
          zh: ZH,
          en: EN,
          ja: EN,
          es: EN,
          fr: EN,
          de: EN,
          ru: EN,
          pt: EN,
        }), 'session-transfer: dictionaries')

        const openImport = () => {
          void openDialog()
        }

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-session-transfer.selftest',
          order: 90,
          locale: NS,
        }, SelfTestSection))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-transfer-menu',
          order: 120,
          locale: NS,
        }, SessionPackMenuItem))

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-session-transfer.selftest',
          order: 90,
          locale: NS,
        }, SelfTestSection))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-transfer-box-menu',
          order: 121,
          locale: NS,
        }, SessionPackBoxMenuItem))

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'session-transfer-footer',
          order: 40,
          locale: NS,
          inject: () => ({ openImport }),
        }, ImportFooterAction))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-transfer-pack',
          order: 70,
          locale: NS,
        }, PackProgressCard))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-transfer-box-picker',
          order: 72,
          locale: NS,
        }, BoxPicker))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-transfer-dialog',
          order: 71,
          locale: NS,
          inject: () => ({ hostCtx: ctx }),
        }, ImportDialog))
      },
      selftest: { subjectPluginName },
    }
  },
})
