# `@soul-harness/contracts` — 协议契约包

- **地位**：线协议（HTTP / WS / IPC / JSON）的**唯一权威定义**。任何模块需要跨边界传数据，
  类型与 Schema 都取自本包，不得各自复制一份。
- **状态**：**已实现（协议层）**。类型、枚举、JSON Schema 与纯格式校验已落地并有测试；
  测试路径 `packages/contracts/test/`，命令见本文末尾。
- **上位文档**：`docs/architecture/IDENTITY-PROTOCOL.md`、`DATA-MODEL.md`、`RUNTIME-LIFECYCLE.md` §7、
  `TRUST-BOUNDARIES.md` §5.4–§5.5、`MODULES.md` §2–§3。

> "已实现"仅指**契约**已实现并经过测试，**不表示**运行时、存储、Ingress 或 Archive Writer 存在。
> 本包不启动任何进程，不打开任何文件。

---

## 1. 负责什么

| 类别 | 内容 |
|---|---|
| 标识符 | 六类核心 ID、`tsk` / `cnf` 辅助 ID、`archiveRef` / `bootId` 的**格式**与品牌类型 |
| 枚举 | `EventStatus` / `AttentionOutcome` / `ArchiveState` / `ArchiveDisposition` / `RetentionClass` / `StatusReason` / `Channel` |
| 信封 | `StimulusV1`（顶层封闭 + `payload` 开放扩展区） |
| 响应 | `AckResponse`（只有 `eventId` + `status`）、`ErrorResponse`（只有 `ErrorCode`） |
| Archive IPC | `append` / `status` / `compare` **三套独立的请求与响应** |
| Schema | 9 份 draft-07 JSON Schema，按 `$id` 注册在 `SCHEMAS` 中 |
| 常量 | 协议版本、错误码到 HTTP 状态码的映射、可重试错误码 |

## 2. 不负责什么（硬边界）

1. **不生成 ID**。生成属于 `runtime`（IDENTITY-PROTOCOL §2）。本包只有 `parse*` / `is*` 校验，
   没有 `newXxxId()`。
2. **不访问数据库、不做列映射**。`snake_case ⇄ camelCase` 由 `persistence` 负责。
3. **不做 IO**：不读文件、不连网络、不读时钟、不读环境变量。
4. **不持有状态**：所有导出要么是常量，要么是纯函数。
5. **不查注册表**：`adapterId` / `source` 是否**已注册**由 `adapter-sdk` 判定；本包只校验**格式**。
6. **不承担业务语义**：不判断"该不该记"、不判断归档范围、不解释内容。

## 3. 依赖

- **运行时依赖：无**（`"dependencies": {}`）。
- 开发依赖：`typescript`（strict 编译）、`vitest`（测试）、`ajv`（**仅测试**用于真实 Schema 校验）、
  `@types/node`（测试读取 fixture 文件）。
- 包管理器：pnpm。`pnpm-workspace.yaml` 中放行 `esbuild` 的安装脚本（vitest 的传递依赖）。
  **SH-005 会把该配置与 lockfile 上提到 Monorepo 根**；在此之前本包自成一体、可独立构建与测试。

## 4. 目录

```
packages/contracts/
├─ src/
│  ├─ index.ts               # 唯一公共入口
│  ├─ version.ts             # PROTOCOL_VERSION 等
│  ├─ json.ts                # JsonValue（payload 的类型上界）
│  ├─ ack.ts                 # AckResponse
│  ├─ ids/{patterns,types,validate}.ts
│  ├─ events/{enums,status-reason}.ts
│  ├─ errors/{codes,error-response}.ts
│  ├─ envelope/v1.ts
│  ├─ archive/ipc.ts
│  └─ schemas/               # 9 份 draft-07 Schema + SCHEMAS 注册表
└─ test/                     # vitest + fixtures
```

## 5. 用法

```ts
import {
  SCHEMAS,
  PROTOCOL_VERSION,
  isPersonaId,
  isCoreId,
  parseEventId,
  EVENT_STATUSES,
  ERROR_HTTP_STATUS,
  type StimulusV1,
} from '@soul-harness/contracts';

// 1) 交给任意 draft-07 校验器（此处在测试中用 ajv）
validate(SCHEMAS['soul.stimulus.v1'], incoming);

// 2) 纯格式校验（不生成、不改写）
isPersonaId('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC'); // true
isCoreId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF');     // false —— 辅助 ID 不属于六类核心

// 3) 类型收窄
const eventId = parseEventId(ack.eventId); // EventId | null
```

## 6. 三个关键设计决策（SH-004）

### B1 — `payload` 是开放的扩展区，不是聊天消息白名单

信封负责**稳定字段与事件身份**；`payload` 是适配器/插件自己的版本化 JSON 对象，只要求：

- 必须是 JSON 对象；
- 必须带 `kind`（小写带命名空间，如 `qq.message` / `mc.world`）与 `version`（整数 ≥ 1）；
- 其余字段自由。

核心 **不枚举**任何平台事件类型，因此 QQ 消息、Minecraft 世界状态、多模态数据都不需要改核心契约。
**扩展不能绕过核心约束**：身份、鉴权、Persona 作用域全部在**信封顶层**校验，核心从不从 `payload`
里读身份；请求体大小限制属于 Ingress 运行时职责（本包不表达字节上限）。

### B2 — 顶层封闭，`payload` 开放

信封顶层 `additionalProperties: false`：未知顶层字段返回 `schema_invalid`，不得静默忽略。
开放区只有 `payload` 一处。这样"允许扩展"与"拒绝未知字段"不矛盾。

### B3 — ACK 只有 `eventId` + `status`

即时失败走 `ErrorResponse` + `ErrorCode`；事件的后续状态与原因码由**状态查询**负责，不混进 ACK。
Schema 层用 `additionalProperties: false` 把这条变成硬失败：ACK 里出现 `statusReason` 直接校验不通过。

### 附：`compare` 的边界（TRUST-BOUNDARIES §5.5）

- 请求**允许**候选正文（`candidateBody`），并强制绑定 5 个身份字段（`eventId` / `personaId` /
  `adapterId` / `source` / `requestNonce`），使一次调用只能对应"一个事件的一次投递"。
- 响应**只有** `match` / `conflict` / `not_found`，连 `eventId` 都不回显 —— 任何多余字段都是未来
  内容泄露的入口。
- `append` 的请求可以带原文，响应只多一个 `archiveRef`；`status` 请求只带 `eventId`，响应三个字段。

## 7. 测试与命令

```bash
# 在 packages/contracts 下
pnpm install --frozen-lockfile   # 首次
pnpm run typecheck               # tsc --noEmit（strict）
pnpm run test                    # vitest run
pnpm run build                   # 产出 dist（ESM + d.ts）
```

覆盖内容：

| 测试文件 | 覆盖 |
|---|---|
| `test/ids.test.ts` | 六类核心 ID 正反例、长度、字母表（排除 `I/L/O/U`）、跨类前缀 |
| `test/auxiliary.test.ts` | `tsk` / `cnf` 与核心 ID **双向分离** |
| `test/identifiers.test.ts` | `requestNonce` / `adapterEventRef` / `adapterId` / `source` / `archiveRef` / `bootId` / `payload.kind` 的长度与字符边界 |
| `test/enums.test.ts` | 枚举完备性、去重、原因码分组、`ErrorCode` 与 `StatusReason` **类型级分离** |
| `test/envelope.test.ts` | 必填字段、未知顶层字段、`payload` 规则、字段格式 |
| `test/ack-error.test.ts` | ACK 最小性（拒绝 `statusReason`）、错误码与原因码不混用 |
| `test/archive-ipc.test.ts` | 三接口请求/响应独立性、`compare` 三值判定、ref 与 state 配对 |
| `test/schemas.test.ts` | 9 份 Schema 的 meta-schema 合法性、`$id` 与注册表一致、响应无内容字段 |
| `test/fixtures.test.ts` | 22 个正反 fixture 逐一过真实 ajv 校验器 |

**测试是真实调用 Schema 校验器**（ajv，`strict: true`），没有 mock 校验结果。

## 8. 已知限制

1. **`body` 必须逐字节一致**：`append` 与 `compare` 的 HMAC 比对依赖序列化结果完全一致；
   这是 Ingress 的编码责任，本包只能约束它是 `string`。
2. **不表达大小上限**：请求体上限由 Ingress 在传输层限制，JSON Schema 无法表达"整个对象多大"。
3. **不校验 `adapterId` / `source` 是否注册**：只校验格式；注册表属 `adapter-sdk`。
4. **`archiveRef` 生成算法未定**（OPEN-8）：本包只固定其形状（1–128 不透明 token）。
5. **没有 Monorepo 根**：workspace、CI、统一 lockfile 属 SH-005，本包当前自带 `pnpm-lock.yaml`。
