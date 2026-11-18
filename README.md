# Session Transfer · dsh-session-transfer

Pack any DSH session into a portable `.dshpack` and import it into another DSH installation.

A pack carries:

- the complete session log — conversation, tool calls and results, approvals, title, model and preset selections;
- the **subagent sessions** it spawned (included by default);
- every referenced **image** and **uploaded file**, restored by content address.

On import you choose the target workspace; the session path, agent preset, and session-id collisions are handled for you.

---

## Install

Install the plugin on **both** machines.

### From the DSH UI (recommended)

1. Copy the `dsh-session-transfer` folder to the target machine, e.g. `D:\dsh-plugins\dsh-session-transfer`;
2. In DSH: **Settings → Plugins → Install**, then enter the folder's **absolute path** (or run `npm pack` locally and point at the `.tgz`);
3. Reload the DSH window.

The plugin manager accepts absolute local paths, `file:` paths, and `.tgz` archives. The desktop profile is managed by the app, so no manual profile editing is needed.

### Command line (non-desktop profiles)

```bash
dsh plugin --profile web add "D:\dsh-plugins\dsh-session-transfer"
```

### Verify

- every session's `…` menu gains **Pack session…**;
- the sidebar footer gains **Import session pack**;
- agents can call `pack_session` / `unpack_session`.

---

## Usage

### Pack (source machine)

Hover a session row → `…` → **Pack session…**. A progress card reports packing and download progress; the browser saves `<session title>.dshpack` (through a save dialog when supported; cancelling is not a failure).

Agent equivalent:

```
pack_session({ sessionId: "session-...", path: "D:\\tmp\\session.dshpack" })
```

`sessionId` defaults to the calling session. `path` must stay inside the DSH home or a registered workspace; when omitted the file lands in `~/.dsh/session-packs/`.

### Whole-box packs (1.1.0)

Session menu → **Pack its box…** (a picker appears when the session sits in several boxes), or the `pack_box` tool. A box pack is a `.dshpack` v2 that also carries the box name/color/order/collapse/header, direct child boxes, and member order.

Importing one shows a box plan first: a same-name box (name + parent) is **reused** without touching its color/order/header, or choose **New copy** to create one suffixed 「（导入）」. Boxes are restored through the boxes plugin's public route; transfer never writes its data file. If boxes is unreachable the sessions still import and the result says they were not boxed. A failed assignment never rolls back sessions, and pinned order is not migrated (reported).

Old 1.0.x builds reject v2 with a clear "layout newer than this plugin reads" error before writing anything.

### Import (target machine)

1. Copy the `.dshpack` over;
2. Sidebar footer → **Import session pack**;
3. Pick an existing workspace, or choose **New workspace…** and enter an absolute path to create one on the spot;
4. Pick the file. DSH **preflights** the pack first and shows its title, session/event/attachment counts, the target path, the source DSH version and format, and which ids become copies or presets get replaced;
5. Confirm with **Import**. The dialog then shows attachment/session/box phases streamed over SSE On success, either open the session immediately or find it at the top of that workspace.

A failed preflight writes nothing; retry re-runs it. Esc closes, Enter confirms, and the dialog cannot be dismissed while an import is running. After writing, the host reads the session back and compares its content digest, so a truncated log fails loudly instead of leaving an unopenable row.

Agent equivalent:

```
unpack_session({ path: "D:\\Downloads\\session.dshpack", workspace: "workplace" })
```

`workspace` accepts an id, an absolute path, or a unique title; the first workspace is the default. `dryRun: true` validates and plans without writing.

---

## What import changes

| Item | Behavior |
| --- | --- |
| Workspace path | the header `cwd` is rewritten to the chosen workspace; old paths in history stay as text |
| Session id | an existing id becomes a new copy id, and child `parentSession` plus in-log self references are remapped |
| Agent preset | an unavailable preset falls back to the current default with a warning |
| Images / files | restored by content address; files verbatim, images at their normalized object path |
| Title | kept from the stored title event |
| Integrity | the imported log is read back and digest-checked; a mismatch reports "could not write the session" |
| Attachment | the root session is attached to the target workspace, so it appears in the sidebar |

Not included: other workspace files, stars, session boxes, scheduled tasks, or any other plugin's data.

---

## Pack format (`.dshpack`)

A plain ZIP — rename it to `.zip` and inspect it with any archive tool:

```
dsh-session-pack.json                 manifest: source versions, sessions, attachments, checksums
sessions/<session-id>.jsonl           canonical log: header line, then one event per line
attachments/images/<sha256>.<ext>     normalized image objects
attachments/files/<sha256>/<name>     verbatim file objects
```

The manifest records the source DSH version and session format generation. Import verifies SHA-256, event counts, and event continuity for every member, and the ZIP reader validates entry names, sizes, and CRCs (no traversal, no silent corruption). Caps: 2 GiB per pack, 1 GiB per entry, 65535 entries.

## Compatibility

- Session format **v4** (DSH `0.2.2-rc.1` line). A generation mismatch fails the import with an explicit message instead of risking a damaged session;
- Pack layout `packVersion 1`; older plugins refuse newer layouts;
- Engine range: `dsh >= 0.2.2-rc.1 < 0.3.0`.

## Privacy

Packs are **not encrypted**. They contain the full conversation, which may include code, paths, secrets, or tool output. Treat them like source archives and review before sharing.

## Troubleshooting

- **Session missing after import?** Switch to the target workspace or reload; the import response carries the new session id.
- **"Session format incompatible"?** The two DSH builds use different log generations. Align the versions; the plugin never attempts lossy migration.
- **"Preset not found"?** The import already substituted the default and reported a warning; install the original preset first if you need it.
- **Attachments?** Always included so the restored session renders; very large attachments make a large pack.
- **Errors with no explanation?**
  - Check `http://127.0.0.1:<DSH port>/session-transfer/health` for the host plugin, its version, and mounted services;
  - The host keeps a diagnostics log at `~/.dsh/tmp/session-transfer.log` (failures only);
  - "Session no longer exists" means the sidebar still shows a deleted row; refresh the list and pick another session.

## Development

```bash
npm test   # zero-dependency node:test suite for ZIP, pack codec, and import/export
```

Development notes:

- [Where a plugin-dev session spends its time](docs/time-audit.zh.md) (Chinese): a real session's model/tool/idle breakdown plus a speed-up checklist;
- `docs/session-time-audit.mjs` audits any DSH session's timing:

```bash
node docs/session-time-audit.mjs --session <session id>
```

MIT License.

## Install from GitHub

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-transfer
```

Reload the Web UI page after installing.
