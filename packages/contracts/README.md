# `@soul-harness/contracts` — 协议契约包

- **地位**：线协议（HTTP / WS / IPC / JSON）的**唯一权威定义**。任何模块需要跨边界传数据，
  类型与 Schema 都取自本包，不得各自复制一份。
- **状态**：**已实现（协议层）**。类型、枚举、10 份 JSON Schema 与纯格式校验已落地并有测试；
  测试路径 `packages/contracts/test/`，命令见本文末尾。
- **契约版本**：`CONTRACTS_VERSION = 1.1.0`（1.1.0 引入双层信封、append 判别联合、错误文案目录）。
- **上位文档**：`docs/architecture/IDENTITY-PROTOCOL.md`、`DATA-MODEL.md`、`RUNTIME-LIFECYCLE.md` §7、
  `TRUST-BOUNDARIES.md` §5.4–§5.5 与 §6（输入信任边界）、`MODULES.md` §2–§3。

> "已实现"仅指**契约**已实现并经过测试，**不表示**运行时、存储、Ingress 或 Archive Writer 存在。
> 本包不启动任何进程，不打开任何文件。

---

## 1. 负责什么

| 类别 | 内容 |
|---|---|
| 标识符 | 六类核心 ID、`tsk` / `cnf` 辅助 ID、`archiveRef` / `bootId` 的**格式**与品牌类型 |
| 枚举 | `EventStatus` / `AttentionOutcome` / `ArchiveState` / `ArchiveWriterState` / `ArchiveDisposition` / `RetentionClass` / `StatusReason` / `Channel` |
| 信封 | **两层**：`StimulusInputV1`（适配器提交，无 `receivedAt`）与 `StimulusV1`（Ingress 归一化，`receivedAt` 必填） |
| 响应 | `AckResponse`（只有 `eventId` + `status`）、`ErrorResponse`（`ErrorCode` + **固定的** `message`） |
| Archive IPC | `append` / `status` / `compare` **三套独立的请求与响应**；`append` 响应是四型判别联合 |
| Schema | 10 份 draft-07 JSON Schema，按 `$id` 注册在 `SCHEMAS` 中 |
| 常量 | 两个协议版本、错误码到 HTTP 状态码的映射、错误文案目录、可重试错误码 |

## 2. 不负责什么（硬边界）

1. **不生成 ID**。生成属于 `runtime`（IDENTITY-PROTOCOL §2）。本包只有 `parse*` / `is*` 校验，
   没有 `newXxxId()`。
2. **不生成 `receivedAt`**。时间戳由 Ingress 在受信任路径内打；本包只声明"输入层没有这个字段"。
3. **不访问数据库、不做列映射**。`snake_case ⇄ camelCase` 由 `persistence` 负责。
4. **不做 IO**：不读文件、不连网络、不读时钟、不读环境变量。
5. **不持有状态**：所有导出要么是常量，要么是纯函数。
6. **不查注册表**：`adapterId` / `source` 是否**已注册**由 `adapter-sdk` 判定；本包只校验**格式**。
7. **不承担业务语义**：不判断"该不该记"、不判断归档范围、不解释内容。

## 3. 依赖

- **运行时依赖：无**（`"dependencies": {}`）。
- 开发依赖由 Monorepo 根统一提供：`typescript`、`vitest`、`ajv`（**仅测试**）、`@types/node`。
- 包管理器与 Node 版本在根 `package.json` 中锁定（`packageManager` / `engines`），见根 README。

## 4. 目录

```
packages/contracts/
├─ src/
│  ├─ index.ts               # 唯一公共入口
│  ├─ version.ts             # 输入层 / 归一化层 两个协议版本
│  ├─ json.ts                # JsonValue（payload 的类型上界）
│  ├─ ack.ts                 # AckResponse
│  ├─ ids/{patterns,types,validate}.ts
│  ├─ events/{enums,status-reason}.ts
│  ├─ errors/{codes,error-response}.ts
│  ├─ envelope/v1.ts         # StimulusInputV1 + StimulusV1
│  ├─ archive/ipc.ts         # 三接口 + append 判别联合
│  └─ schemas/               # 10 份 draft-07 Schema + SCHEMAS 注册表
└─ test/                     # vitest + fixtures
```

## 5. 用法

```ts
import {
  SCHEMAS,
  STIMULUS_INPUT_VERSION,
  isPersonaId,
  isCoreId,
  parseEventId,
  ERROR_MESSAGES,
  type StimulusInputV1,
} from '@soul-harness/contracts';

// 1) 适配器入口只校验输入层（无 receivedAt）
validate(SCHEMAS['soul.stimulus.input.v1'], incoming);

// 2) Ingress 归一化后可再校验一次内部信封
validate(SCHEMAS['soul.stimulus.v1'], normalized);

// 3) 纯格式校验（不生成、不改写）
isPersonaId('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC'); // true
isCoreId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF');     // false —— 辅助 ID 不属于六类核心

// 4) 错误文案只能是目录里的固定值
ERROR_MESSAGES.archive_unavailable; // 'archive is temporarily unavailable'
```

## 6. 关键设计决策

### B1 — `payload` 是开放的扩展区，不是聊天消息白名单

信封负责**稳定字段与事件身份**；`payload` 是适配器/插件自己的版本化 JSON 对象，只要求：

- 必须是 JSON 对象；
- 必须带 `kind`（小写带命名空间，如 `qq.message` / `mc.world`）与 `version`（整数 ≥ 1）；
- 其余字段自由。

核心 **不枚举**任何平台事件类型。**扩展不能绕过核心约束**：身份、鉴权、Persona 作用域全部在信封顶层校验，
核心从不从 `payload` 里读身份；请求体大小限制属于 Ingress 运行时职责。

### B2 — 顶层封闭，`payload` 开放

两层信封的顶层都是 `additionalProperties: false`：未知顶层字段返回 `schema_invalid`，不得静默忽略。
开放区只有 `payload` 一处。

### B3 — ACK 只有 `eventId` + `status`

即时失败走 `ErrorResponse` + `ErrorCode`；事件的后续状态与原因码由**状态查询**负责，不混进 ACK。
Schema 用 `additionalProperties: false` 把这条变成硬失败。

### B4 — `receivedAt` 只能由 Ingress 生成（双层信封）

| 层 | Schema | 有 `receivedAt`？ | 谁能构造 |
|---|---|---|---|
| 适配器输入 | `soul.stimulus.input.v1` | **没有该字段** | 任何外部适配器 |
| 归一化 | `soul.stimulus.v1` | **必填** | 只有 Ingress |

- 适配器提交 `receivedAt` → 输入层判为未知顶层字段 → `schema_invalid`。**不是**"可选"，也**不是**"被覆盖"。
- `occurredAt` 两段都可选，属**来源自报**：可缺失、可偏斜、可错误，不作为系统权威时间。

### B5 — `append` 响应是判别联合，非法组合不可表示

| `result` | `archiveRef` | `errorCode` |
|---|---|---|
| `archived` | **必须有** | 禁止 |
| `duplicate` | **必须有** | 禁止 |
| `conflict` | 禁止 | 禁止 |
| `error` | 禁止 | **必须有** |

TypeScript 用四型联合表达，JSON Schema 用四分支 `oneOf`（每支封闭）。两边都把非法组合挡死。

### B6 — 错误文案是固定目录，不是自由文本

`ErrorResponse.error.message` 必须等于 `ERROR_MESSAGES[code]`。Schema 的 `oneOf` 逐码钉死配对关系，
因此**无法**把异常字符串、堆栈、文件路径或输入片段拼进响应——这类文本只会让校验失败。
新增或修改文案属于契约变更，不是运行时决定。

### 附：`compare` 的边界（TRUST-BOUNDARIES §5.5）

- 请求**允许**候选正文（`candidateBody`），并强制绑定 5 个身份字段，使一次调用只能对应"一个事件的一次投递"。
- 响应**只有** `match` / `conflict` / `not_found`，连 `eventId` 都不回显。
- `status` 请求只带 `eventId`，响应三个字段；`append` 请求可带原文，响应只可能多一个 `archiveRef`。

## 7. 测试与命令

```bash
# 仓库根
pnpm install --frozen-lockfile
pnpm --filter @soul-harness/contracts typecheck
pnpm --filter @soul-harness/contracts test
pnpm --filter @soul-harness/contracts build
```

覆盖内容：

| 测试文件 | 覆盖 |
|---|---|
| `test/ids.test.ts` | 六类核心 ID 正反例、长度、字母表（排除 `I/L/O/U`）、跨类前缀 |
| `test/auxiliary.test.ts` | `tsk` / `cnf` 与核心 ID **双向分离** |
| `test/identifiers.test.ts` | `requestNonce` / `adapterEventRef` / `adapterId` / `source` / `archiveRef` / `bootId` / `payload.kind` 的长度与字符边界 |
| `test/enums.test.ts` | 枚举完备性、去重、原因码分组、`ErrorCode` 与 `StatusReason` **类型级分离** |
| `test/envelope.test.ts` | **双层信封**：输入层拒绝 `receivedAt`、归一化层必须带 `receivedAt`；`payload` 规则；字段格式 |
| `test/ack-error.test.ts` | ACK 最小性；**错误文案目录**：拒绝自造文案、异常串、回显正文、错误配对 |
| `test/archive-ipc.test.ts` | 三接口独立性；`append` 四型合法 + 13 种非法组合；`compare` 三值判定 |
| `test/type-assertions.test.ts` | `append` 响应联合的**编译期**负例（`@ts-expect-error`） |
| `test/schemas.test.ts` | 10 份 Schema 的 meta-schema 合法性、`$id` 与注册表一致、双层差异、错误文案钉死、响应无内容字段 |
| `test/fixtures.test.ts` | 30 个正反 fixture 逐一过真实 ajv 校验器 |

**测试是真实调用 Schema 校验器**（ajv，`strict: true`），没有 mock 校验结果。

## 8. 已知限制

1. **`body` 必须逐字节一致**：`append` 与 `compare` 的 HMAC 比对依赖序列化结果完全一致；
   这是 Ingress 的编码责任，本包只能约束它是 `string`。
2. **不表达大小上限**：请求体上限由 Ingress 在传输层限制，JSON Schema 无法表达"整个对象多大"。
3. **不校验 `adapterId` / `source` 是否注册**：只校验格式；注册表属 `adapter-sdk`。
4. **`archiveRef` 生成算法未定**（OPEN-8）：本包只固定其形状（1–128 不透明 token）。
5. **错误文案目录是封闭的**：新增错误码必须同时新增文案，属契约变更。
6. **不校验 `occurredAt` 与 `receivedAt` 的先后关系**：那是 Ingress 的判定（可拒绝或标注），不是格式问题。
