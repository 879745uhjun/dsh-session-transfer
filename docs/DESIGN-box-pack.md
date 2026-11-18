# 整盒打包与导入回盒 · 设计草案

> 状态：**仅设计，未改代码、未发版**。目标版本建议 `1.1.0`。
> 基线：`dsh-session-transfer` 1.0.2（`packVersion: 1`），`dsh-session-boxes` 现有 `GET/POST /session-boxes`。
> 决策人：lead。本文只回答“怎么做、风险在哪”，不包含实现。

---

## 1. 目标与非目标

**目标**：把侧边栏一个“盒子”里的 N 个会话一次性打包成一个可移植文件；在另一台 DSH 导入后，会话恢复并自动回到同名盒子。

**非目标**：

- 不迁移工作区文件（与单会话包一致）；
- 不迁移星级、待办、结束提醒、快捷栏配置；
- 不做跨会话格式代际迁移（仍是 v4）；
- **transfer 不写 `session-boxes.json`**（单一写者原则，见 §4）。

---

## 2. 已核实的事实

| 事实 | 位置 / 形状 |
| --- | --- |
| 盒子状态 | `~/.dsh/session-boxes.json`；`{ boxes[], memberships{}, pins{}, ungroupedCollapsed }` |
| 盒子字段 | `id, name, color, collapsed, parentId, order, header`（允许一层子盒） |
| 成员关系 | `memberships[sessionId] = [boxId, …]`（一个会话可进多个盒） |
| 置顶 | `pins[boxId] = [sessionId, …]` |
| 公开读写 | `GET /session-boxes` 返回 `{ ok, state }`；`POST /session-boxes` 传 `{ action, … }`，返回 `{ ok, state, boxId? }`；动作含 `create / update / assign / move / delete / pin / collapse …` |
| Host 服务 | **没有** `sessionBoxes` 服务；只有该路由和 `session_boxes` 工具 |
| 自身 base URL | `ctx.get('webServer').getOrigin()`（绑定端口后返回如 `http://127.0.0.1:3080`；未绑定会抛错） |
| transfer 现状 | `GET /session-transfer/export`、`POST /session-transfer/inspect`（dryRun + token）、`POST /session-transfer/import`；工具 `pack_session` / `unpack_session` |
| 版本门 | `normalizeManifest` 对 `packVersion > 1` 明确抛“pack layout v2 is newer than this plugin reads (v1)”，且发生在任何写盘之前 |

---

## 3. 方案对比

### 3.1 打包形态

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **a. 外层 zip** | N 个 `.dshpack` + `box.json` 再压一层 | 完全不动现有格式；实现快 | 双层压缩、体积变大；同一个图片/文件在多个会话里重复；老版本只会报“不是会话包”，不是“版本不支持” |
| **b. 扩展 `.dshpack` v2** | manifest 增加 `roots[]` 和 `box` 描述，仍是单层 zip | 单文件、无重复压缩、附件按内容地址天然去重；manifest 本来就是多会话结构（子会话），加“多根”是自然扩展；版本门精确 | 需要升格式；老版本完全不能读（这正是想要的） |
| **c. `--box` 循环导出** | 只加参数，导出到目录 | 改动最小 | 没有盒子元数据；导入端要手工归盒；不像“整盒”功能 |

**推荐 b**。`packVersion: 2`，只用于整盒导出；单会话导出继续 `1`，不制造无谓升级。附件去重和单文件传递是硬收益。

### 3.2 导入回盒

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **a. Host 调 boxes 路由** | 导入后 `fetch(getOrigin() + '/session-boxes')` 建盒/归盒 | 无跨插件代码依赖；工具路径也能用 | 依赖本机 loopback 可用与端口；用户无法在导入前确认；仍有并发覆盖成员列表的风险 |
| **b. 客户端编排（推荐）** | 导入成功后，浏览器同源调用 `/session-boxes` 建盒/归盒；预检卡片先展示“将创建盒子 X” | 无 base URL 问题；用户在预检里确认；boxes 保持唯一写者；失败可降级 | 只覆盖 UI 路径；工具路径需另给“盒子计划” |
| **c. boxes 提供 Host 服务** | 对方 `provide('sessionBoxes')`，transfer 直接调用 | 最干净、无 HTTP、可做原子操作 | 跨插件版本协同成本最高；要对方改代码并发版 |

**推荐 b**，工具路径用 **a 作为兜底**：`unpack_session({ …, box: true })` 时若 `getOrigin()` 可用则调用同一路由；不可用就只返回 `boxPlan`，让用户手动归盒。

---

## 4. 所有权与写入规则

1. transfer **绝不**读写 `session-boxes.json`，也不 import 对方的 store 模块；
2. 一切盒子变更只经 `POST /session-boxes`（`create` / `assign`），boxes 是唯一写者；
3. 归盒采用“读—合并—写”：
   - `GET` 当前 `memberships`；
   - 目标盒按 **name + parent** 匹配：存在则复用（颜色/顺序保留本地值并给提示），不存在才 `create`；
   - 对每个导入会话 `assign`，`boxIds` = 原成员列表 + 新盒 id（保持原有其它盒归属）；
4. `pins` 首版不迁移（跨机器置顶意义有限），在结果里给一句提示；
5. transfer 不删除、不改名任何已有盒子。

---

## 5. 包格式 v2（草案）

```json
{
  "kind": "dsh-session-pack",
  "packVersion": 2,
  "createdAt": 1795000000000,
  "tool": { "name": "dsh-session-transfer", "version": "1.1.0" },
  "source": { "dshVersion": "0.2.2-rc.1", "platform": "win32", "sessionFormatVersion": 4 },
  "roots": ["session-a", "session-b"],
  "box": {
    "name": "插件制作",
    "color": "blue",
    "parentName": null,
    "order": 3,
    "collapsed": false,
    "header": { "count": true, "stars": true },
    "members": [
      { "sessionId": "session-a", "index": 0 },
      { "sessionId": "session-b", "index": 1 }
    ],
    "pinned": ["session-a"]
  },
  "sessions": [ /* 与 v1 相同的会话行，含子会话 */ ],
  "attachments": [ /* 与 v1 相同 */ ]
}
```

规则：

- `roots[]` 必填且非空；`sessions` 必须覆盖全部 roots 及其子会话；
- `box` 可选：没有它就是一个“多会话包”，导入按普通会话处理；
- 读端：`packVersion === 1` 时视作 `roots = [root]`、无 `box`；`=== 2` 按上述；`> 2` 明确拒绝；
- 写端：单会话仍写 v1；整盒写 v2；
- 盒子 **不写本地 box id**（id 是随机的），用 `name + parentName` 表达身份；
- `members[].index` 保留盒子内排序；导入端按 index 依次 `assign`。

---

## 6. 导入流程（推荐 b）

1. 选包 → `POST /session-transfer/inspect`（现有 dryRun）：返回 `plan.box`（名称、成员数、是否已存在同名盒）、`plan.roots`、目标工作区、id 冲突与预设改写；
2. 预检卡片增加一行：“将导入到盒子「插件制作」（3 个会话，本机已存在同名盒 → 合并）”；
3. 用户确认 → `POST /session-transfer/import?token=…`：
   - 逐个恢复会话（多根时全部 attach 到目标工作区；子会话仍不挂侧边栏）；
   - 读回校验照旧；
4. 客户端拿到 `result.roots[]` 后：
   - `GET /session-boxes` → 找/建盒；
   - 对每个 root `POST { action: 'assign', sessionId, boxIds: [...existing, boxId] }`；
   - 写失败不阻塞会话导入，结果里给“会话已导入，盒子未完成：…”；
5. 工具路径：`unpack_session({ path, workspace, box: true })`，Host 端用 `getOrigin()` 走同一套逻辑；拿不到 origin 就返回 `boxPlan`。

**降级矩阵**

| 情况 | 行为 |
| --- | --- |
| boxes 未安装 / 路由 404 | 会话照常导入；提示“盒子未创建”，附 `boxPlan` |
| 同名盒已存在 | 复用，不重复创建；颜色/折叠保持本地 |
| 同名但父盒不同 | 视为不同盒，新建（名称加后缀避免歧义） |
| 达到盒子/成员上限 | 捕获 boxes 的 400，提示并保留已导入会话 |
| 重复导入同一个包 | 会话按现有规则生成副本；盒子复用，副本追加进去（提示“盒内出现重复副本”） |

---

## 7. 兼容与版本门

- 老版本 transfer（1.0.2）打开 v2 包：`inspect` 阶段即报 `pack layout v2 is newer than this plugin reads (v1)`，**不写任何会话/附件**；
- 新版本读取 v1：行为与今天完全一致；
- 新版本读取 v2：多根导入；`box` 缺失就是普通多会话包；
- 包内会话格式仍受现有 v4 校验约束，不新增迁移路径。

---

## 8. 工作量（0.5–2 天）

| 步骤 | 估计 | 说明 |
| --- | --- | --- |
| manifest v2 编解码 + 版本门 + 单测 | 0.5 天 | 复用现有 `zip/pack`，只加字段与校验 |
| 整盒导出（工具 + 菜单入口） | 0.25–0.5 天 | 复用 `exportPack`，多根循环 + box 元数据 |
| 多根导入 + 预检展示 | 0.5 天 | 现有多会话恢复已具备，主要改 attach 与 UI |
| 归盒编排 + 降级 + 文档 | 0.5 天 | 客户端调 `/session-boxes`，处理同名/上限/缺失 |

合计 **1.5–2 天**。**最可能返工的是“归盒语义”**（同名盒复用、父子盒、并发成员列表、pins），不是包格式；其次是多根 attach 的 UI 表达。

---

## 9. 这次怎么省时间

按《DSH 插件开发耗时分析与提速清单》的清单执行：

- **设计先行**（本轮 0 代码），把格式、版本门、降级先定死，避免实现中途改协议；
- **复用现有管线**（zip 编解码、导入读回校验、预检 token），不新写归档器；
- **真机验证只做一次**，放在“导出→导入→归盒”全链路完成后，不在中间反复导；
- 工具调用合并并行，宿主改动攒一批只重载一次；
- 机械步骤降推理档，只有归盒语义与真机排错用高推理；
- 单测只加关键断言：v2 往返、v1 兼容、老版本拒绝 v2 且零写入、boxes 缺失降级。

---

## 10. 验收标准

1. 一个含 3 个会话的盒子 → 导出 v2 包 → 另一工作区导入 → 3 个会话存在且都在同名盒内；
2. v1 包仍按今天的方式导入；
3. 用 1.0.2 打开 v2 包：明确报版本不支持，且会话目录/附件目录零新增；
4. 卸载 boxes 后导入 v2：会话成功、返回 `boxPlan`、无异常；
5. 代码检索确认 transfer 没有任何 `session-boxes.json` 写入路径。
