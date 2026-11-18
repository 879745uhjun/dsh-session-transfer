# 更新日志 · Changelog

本文件记录 dsh-session-transfer 的每次可见变化。版本号遵循语义化版本；此前的迭代只在本地工作区进行，
本仓库从 1.0.0 起有可追溯的提交历史。

## 1.1.0 — 2026-11-18

### 新增

- **整盒打包**：会话菜单新增「打包所在盒子…」（会话在多个盒子里时弹出选择），智能体工具新增 `pack_box`。一个 `.dshpack` 带上盒内全部会话、它们的子会话，以及盒子元数据（名称、颜色、顺序、折叠、表头、直接子盒、成员顺序）。
- **包格式 v2**：`roots[]` + `box{}`。单会话导出仍为 v1；只有整盒才写 v2。
- **导入回盒**：预检显示盒子计划（复用 X / 新建 Y / 跳过 Z、成员数、不可达原因），可选择「复用同名盒」或「新建副本」（副本名后缀「（导入）」）；`unpack_session` 新增 `boxMode`。
- **归盒边界**：通过 boxes 的公开 `POST /session-boxes` 完成，transfer 不读写 `session-boxes.json`；复用同名盒时不改它的颜色/顺序/表头；boxes 不可达时导入照常并标注“未归盒”。
- **失败语义**：先导入会话、再归盒；归盒失败不回滚已导入会话，按会话返回结果；置顶顺序不迁移并提示。

### 兼容

- 1.0.x 打开 v2 包会在 `inspect` 阶段明确报 `pack layout v2 is newer than this plugin reads (v1)`，零写入；新版本继续兼容 v1。

### 测试

- 新增 v2 编解码、v1 兼容、同名复用、副本模式、嵌套子盒、boxes 不可达降级、pins 提示、并发同名创建回退等用例；测试 22 → 41。

## 1.0.2 — 2026-11-16

### 修复

- **两个智能体工具的 `parameters` 改为 JSON Schema 对象根**：`pack_session`（`sessionId` / `path` / `includeDescendants`，无必填）与 `unpack_session`（`path` / `workspace` / `dryRun`，根级 `required: ['path']`）。原来的裸属性表会被原样发给模型 API，属性名一旦撞上 `title`、`default`、`enum`、`type`、`required`、`items`、`properties` 等 JSON Schema 关键字，整轮请求直接 400；只包 `properties` 而保留属性级 `required: true` 同样会报 `true is not of type "array"`。`unpack_session` 的根级 `required: ['path']` 也是这次唯一的行为级变化：模型侧现在能直接看到 `path` 必填，而此前缺失只会在 `execute` 里报错。
- **`npm test` 在 Node 24 下跑不起来**：`node --test test/` 被当成模块路径，实际执行 0 个测试；改为 `node --test "test/**/*.test.mjs"`，并新增 `test/tools.test.mjs` 覆盖对象根、`properties`、无裸属性表、根级 `required`，测试数 20 → 22。

### 补充记录（1.0.1 之前的存储坑）

- Windows 上目标图片对象已存在时，`rename` 覆盖会报 `EPERM`；改为先比对内容摘要，相同则复用，并处理并发写入后的竞态。
- v4 物理头部不接受 `type: "session"` 字段；`persistence.create` 前剥离 `type`，并按 `isSeeded` 传入 `inheritedEventCount`。
- 以 `link:` 安装的插件启动时读取一次源码，工具 schema 改动必须重启 DSH 才生效（HMR 不覆盖这些目录）。

### 验收

- `node tools/verify-tool-schemas.mjs dsh-session-transfer/index.js` → `pack_session` props=3 required=[]，`unpack_session` props=3 required=[path]，2/2 PASS；
- `npm test` → 22/22 通过；
- 主会话重启后线上 `request/header` 复核：41 个工具，两个工具均为对象根。

## 1.0.1 — 2026-11-16

### 修复

- `unpack_session` 的 `dryRun` 结果带有 `undefined` 字段，会被工具层判为非法输出；现在只返回可 JSON 序列化的字段，并确认不写盘。
- 无标题会话的打包/导入结果不再携带 `undefined`。
- 打包/导入失败（包括 4xx）现在都会写入诊断日志，桌面版也能查到原因。
- 会话已删除时返回 404 `TRANSFER_SESSION_NOT_FOUND`，客户端给出明确提示并自动刷新侧边栏；宿主未加载时（HTTP 404）也会提示重启/启用插件。

### 新增

- `GET /session-transfer/health`：报告插件版本、会话格式与依赖服务状态，便于跨机器排查。

## 1.0.0 — 2026-11-15

首个公开版本：把任意会话打包成 `.dshpack`，换一台电脑导入继续用。

### 新增

- **完整会话记录**：对话、工具调用与结果、改动、审批、标题、模型与预设选择一并打包。
- **子会话默认包含**：会话派生的 subagent 会话可以一起带走，也可以只带主会话。
- **附件按内容寻址**：记录里引用到的图片与上传文件原样恢复。
- **导入可选工作区**：会话路径、预设、会话 id 冲突都会自动处理。
- 打包端与导入端都需要安装本插件。
