# IDENTITY-PROTOCOL — 六类核心身份协议

- **地位**：身份语义的唯一权威描述。与 `OVERVIEW.md` §5 的概览表冲突时，以本文为准。
- **状态**：**协议定义中。尚未实现，未经过运行测试。**
- **上位决策**：`ADR-001`（独立运行时 / camelCase 线协议 / snake_case 数据库 / persistence 负责映射）
- **配套**：`DATA-MODEL.md`（列与约束）、`RUNTIME-LIFECYCLE.md`（状态机）、`TRUST-BOUNDARIES.md`（权限域）

---

## 1. 总则

1. **六类 ID 全部由 Harness 内部生成**，任何外部调用方（Adapter / CLI / Studio / 模型）**都不得指定**。
2. ID 是**身份**，不是**凭据**：拿到 ID 不代表有权限（见 §8）。
3. ID **不含语义**：不得从 ID 反推时间以外的信息（序号、用户、内容、权限）。
4. 一个 ID 一旦分配，**永不复用**，也永不改指向。
5. 所有记录引用 ID 时**必须**带 `personaId` 作为作用域（见 §6）。

## 2. 六类 ID 总表

| ID | 语义 | 生成者 | 生成时机 | 唯一性范围 | 可外部指定 |
|---|---|---|---|---|---|
| `personaId` | 长期人格身份 | **Daemon（supervisor）** | 建档时（CLI / Studio 管理动作） | 部署内全局 | **否** |
| `sessionId` | 某适配器的交互窗口 | **Runtime（Ingress）** | 首次见到该 `(adapterId, externalSessionRef)` 时 | 部署内全局 | **否** |
| `threadId` | 内部思维进程 | **Runtime（cognition）** | ThoughtProcess 诞生时 | 部署内全局 | **否** |
| `runId` | **一次**模型调用或作业执行 | **Runtime（model gateway / scheduler）** | **每次尝试**（含重试） | 部署内全局 | **否** |
| `eventId` | 一个已发生的观察 | **Runtime（Ingress）** | 刺激通过鉴权与 Schema 校验后 | 部署内全局（主键） | **否** |
| `actionId` | 一次真实外部动作的意图 | **Runtime（cognition）** | 动作意图建立时 | 部署内全局 | **否** |

## 3. 格式与生成算法

### 3.1 格式

```
<prefix>_<26 字符 Crockford Base32>
       └─ 10 字符毫秒时间戳 + 16 字符密码学随机
```

| 前缀 | ID |
|---|---|
| `psn` | personaId |
| `ses` | sessionId |
| `thr` | threadId |
| `run` | runId |
| `evt` | eventId |
| `act` | actionId |

**辅助前缀**（不属于六类核心身份，但使用同一算法以避免歧义）：

| 前缀 | 标识 |
|---|---|
| `tsk` | taskId（逻辑任务，见 §4.4） |

- 总长度固定 **30 字符**。
- 字母表：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`（Crockford Base32，排除 `I L O U`，大小写不敏感编码为**大写**）。
- 正则：`^(psn|ses|thr|run|evt|act)_[0-9A-HJKMNP-TV-Z]{26}$`

### 3.2 算法

1. 取当前 Unix 毫秒（48 bit，大端补零到 50 bit 高位）→ 10 个字符。
2. 取 `crypto.randomBytes(10)`（80 bit）→ 16 个字符。
3. 拼接后加前缀。

**理由**：时间前缀让 ID 近似有序（便于索引与排查），随机段保证不可猜。**不引入任何第三方依赖**（`node:crypto` 足够）。
**不采用**自增整数：会泄露规模、跨表冲突、迁移困难。

### 3.3 唯一性

- 唯一性范围 = **单个 Harness 部署**（单 SQLite 实例）内全局。
- **跨部署不保证**：导出/合并两个部署的数据需要重新映射，视为迁移问题（OPEN-3）。
- 数据库主键/唯一索引是最终防线；生成器碰撞时**重试生成**（仍冲突则报错，不得静默覆盖）。

## 4. 逐类决议

### 4.1 personaId

- **语义**：一切主观状态的主体。跨进程、跨会话、跨模型、跨场景、跨睡眠周期恒定。
- **生成**：仅 Daemon 的管理路径（CLI `persona create` 或 Studio）。生成后写入 `personas.id`，**不可变**。
- **不得**：由 Adapter 提供；由模型提议；由配置字符串直接当 ID。
- **终止**：人格不"结束"，只会 `STOPPED`。ID 永久保留（墓碑仅供审计，不复用）。
- **恢复**：重启后按 ID 恢复，绝不新建第二个。

```json
{ "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC" }
```

### 4.2 sessionId

- **语义**：某个适配器上的一段交互窗口。**不代表人格身份**。
- **生成**：Ingress 首次见到该 `(adapterId, externalSessionRef)` 时分配；之后同一组合复用同一 `sessionId`。
- **外部可见性**：Adapter 提供 `externalSessionRef`（它自己的会话标识），**不是** `sessionId`。
- **关闭**：`sessions.closed_at` 置位；关闭后不再接受新事件，但历史事件仍引用它。
- **重开**：同一 `externalSessionRef` 重新出现 → **新** `sessionId`（视为新窗口），不复活旧会话。
- **不得**：用 `sessionId` 当人格主键；用 `externalSessionRef` 直接当 `sessionId`。

```json
{ "sessionId": "ses_01JQ8Z4A6N8Q0S3U5W7Y9B1CDE", "externalSessionRef": "dsh:abc123" }
```

### 4.3 threadId

- **语义**：一个内部思维进程（ThoughtProcess）。可跨会话、跨重启继续。
- **生成**：cognition 创建线程时。`inner` / `external` / `sleep` / `dream` / `audit` 通道都用同一格式。
- **终止**：`COMPLETED` / `ABANDONED` 为终态；**终止后不得复用**该 ID 开新线程。
- **恢复**：重启后按 ID + 检查点恢复；不得凭"最近线程"猜测。
- **不得**：由模型创建或指定；用 `sessionId` 顶替。

```json
{
  "threadId": "thr_01JQ8Z5B7P9R1T3V5X7Z9A2BDF",
  "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "channel": "inner",
  "state": "RUNNING"
}
```

### 4.4 runId

**三层必须分清：逻辑任务（task） / 一次运行（run） / 重试次数（attempt）。**

| 概念 | 标识 | 何时变 | 用途 |
|---|---|---|---|
| 逻辑任务 | `taskId`（`tasks.id`） | 创建时分配，**整个任务生命周期不变** | 表达"要做的这件事" |
| 一次运行 | **`runId`** | **每一次实际执行都新分配**（含每一次重试） | 计费、日志、时延、失败归因 |
| 尝试序号 | `attemptNo`（`tasks.attempt`） | 每次重试 +1 | 表达"第几次尝试" |

- **重试 = 新 run + 同 task**。把重试当作同一次模型调用会导致：计费与用量统计错误、时延分布失真、
  失败重试掩盖首次失败、缓存/幂等判断误用同一个键。
- 生成者：调度器派发任务时 / Model Gateway 实际发起调用时。**生成时机精确到"开始执行"**，不是"计划执行"。
- **终止**：单次运行必然终止（成功 / 失败 / 取消 / 超时）。终态后该 `runId` 不再使用。
- **不得**：把 `runId` 当记忆主体；把 `taskId` 当 `runId`；复用旧 `runId` 表达重试。

```json
{
  "runId": "run_01JQ8Z6C8Q0S2U4W6Y8A0B2CEG",
  "taskId": "tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF",
  "attemptNo": 2,
  "kind": "memory.encode",
  "state": "RUNNING"
}
```

> `taskId` 不在六类核心 ID 内，但为避免歧义在此明确：它同样是 Harness 内部生成的不透明标识。

### 4.5 eventId

**决议：`eventId` 由 Runtime 的 Ingress 生成，Adapter 不再分配 `eventId`，只提供 `adapterEventRef`。**

- 原因：`events.id` 是**全局主键**。若允许 Adapter 自行分配，两个 Adapter 各自用 `"1"` 就会主键冲突。
  让 Adapter 决定我们的主键，也违反"外部不得冒充内部身份"。
- **去重键**：`(adapterId, source, adapterEventRef)` 建**唯一索引**。
  - 同一 Adapter 对同一刺激重试 → 同一 `adapterEventRef` → **映射到同一 `eventId`**，返回既有状态，不新建事件行。
  - 不同 Adapter 用相同字符串 → `adapterId` 不同 → 不冲突。
- **顺序**：Schema 校验通过 → 计算去重键 → 命中则返回既有 `eventId`；未命中则**分配新 `eventId`** 并写 pending/事件行。
- **返回**：`eventId` 通过 ACK 响应回给 Adapter；Adapter 后续以 `adapterEventRef` 重试，不需要也不应该保存我们的 `eventId`。
- **不得**：把 `requestNonce` 当 `eventId`（前者是"这次投递"，后者是"这个观察"）；
  把 `adapterEventRef` 直接塞进 `events.id`。

```json
{
  "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH",
  "adapterId": "minecraft",
  "source": "minecraft.chat",
  "adapterEventRef": "mc-7f3a9c21",
  "status": "accepted"
}
```

### 4.6 actionId

必须同时支撑：崩溃恢复、执行核对、回执关联、**防止重复真实执行**。

| 规则 | 内容 |
|---|---|
| 生成者 | Runtime（意图建立时），**不是** Action Gateway、不是模型 |
| 不可变 | 同一意图的所有重试**复用同一 `actionId`**；绝不重新生成 |
| 幂等身份 | Gateway 以 `actionId` 作为幂等身份（`action_records.action_id` 主键） |
| 回执关联 | 任何 `ActionReceipt` **必须**带 `actionId`；无匹配 `actionId` 的回执**拒绝** |
| 崩溃恢复 | 启动时凡 `state='executing'` 的动作，一律以 `actionId` 向适配器核对；**无回执不得标成功** |
| 重新意图 | 若意图内容实质改变（`intentVersion` 递增），分配**新** `actionId`；旧 `actionId` 保留其结局 |
| 模型边界 | 模型只能在提案里表达"想做什么"，**不得**提供或预测 `actionId` |
| 禁止 | 用"最近一次动作"推断 `actionId`；用内容哈希当 `actionId`；重试时新建 `actionId` |

```json
{
  "actionId": "act_01JQ8Z8E0S2U4W6Y8A0B2C4EGJ",
  "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "actorId": "persona:psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "adapterId": "minecraft",
  "intentVersion": 3,
  "idempotencyKey": "act_01JQ8Z8E0S2U4W6Y8A0B2C4EGJ",
  "state": "executing"
}
```

## 5. 关联与基数

```
persona (psn)
 ├─1:N─ session (ses) ──1:N── event (evt)
 ├─1:N─ thread (thr)  ──1:N── run (run)
 ├─1:N─ task (tsk)    ──1:N── run (run)      ← 每次 attempt 一个新 run
 └─1:N─ action (act)  ──1:0..1── receipt
```

| 关系 | 基数 | 说明 |
|---|---|---|
| persona → session | 1:N | 一个会话只属一个人格 |
| persona → thread | 1:N | 线程跨会话存在 |
| session → event | 1:N | `event.sessionId` 可空（系统事件无会话） |
| thread → run | 1:N | 一次思维步可能多次调用模型 |
| task → run | 1:N | **N = 尝试次数**，每次新 `runId` |
| action → receipt | 1:0..1 | 没有回执即未成功 |
| event → thread | N:0..1 | 线程可由某事件触发（`triggerEventId`） |
| persona → 全部 | 1:N | 所有表都带 `persona_id` 作用域 |

## 6. 生命周期规则

| 阶段 | personaId | sessionId | threadId | runId | eventId | actionId |
|---|---|---|---|---|---|---|
| 创建 | 建档时，一次性 | 首次见 `(adapter, ref)` | 线程诞生 | **每次执行** | 校验通过后 | 意图建立时 |
| 使用 | 永不变 | 会话期内有效 | 运行/挂起期间有效 | 单次执行内有效 | 永久 | 直到动作终结 |
| 关闭 | 不关闭（只停止） | `closed_at` 置位 | `COMPLETED`/`ABANDONED` | 必然终止 | 终态后只读 | 见下 |
| 终止 | `STOPPED` | 关闭即终止 | 终态不可复活 | 终态不可复用 | `expired`/`rejected` 终态 | `succeeded`/`failed`/`revoked`/`expired` |
| 恢复 | 按 ID 恢复，绝不新建 | 重开用新 `ses` | 按 ID + 检查点 | **不恢复**：放弃的 run 记为失败 | 按 `adapterEventRef` 查回同一 `eventId` | 按 ID 对账，无回执不标成功 |
| 重试 | — | — | 同 `threadId` | **新 `runId`** | 同 `eventId`（同 `adapterEventRef`） | **同 `actionId`** |

**关键不对称**（有意设计）：

- 重试时 `runId` **变**（因为是新的一次执行）。
- 重试时 `eventId` / `actionId` **不变**（因为是同一个观察 / 同一个意图）。

## 7. 生成与使用权限

| ID | Adapter | Runtime | Daemon/supervisor | Action GW | Studio | 模型 |
|---|---|---|---|---|---|---|
| personaId | 仅读取 | 读取 | **创建** | 读取 | 发起创建 | 读取 |
| sessionId | 仅读取 | **创建 / 关闭** | 读取 | 读取 | 读取 | 读取 |
| threadId | ✗ 不可见 | **创建 / 更新** | 读取 | ✗ | 受限视图 | **不提供** |
| runId | ✗ 不可见 | **创建 / 终结** | 读取 | ✗ | 受限视图 | ✗ |
| eventId | 仅读取（ACK 返回） | **创建 / 推进** | 读取 | 读取 | 受限视图 | 不提供 |
| actionId | 仅读取（动作请求内） | **创建** | 读取 | 读取 / 校验 | 受限视图 | ✗ |

**硬约束**

- 外部 Adapter **不得**提交、猜测或伪造任何内部 ID。
- 模型**不得**创建或指定任何具有权限意义的身份（`personaId` / `actionId` 尤其）。
- Studio 只能**发起**创建（如新建 persona），实际 ID 仍由 Daemon 生成。

## 8. 与鉴权、幂等键、requestNonce 的区别

| 概念 | 回答的问题 | 例子 | 能否当凭据 |
|---|---|---|---|
| **身份 ID** | 这是谁 / 这是什么 | `evt_…`、`act_…` | **不能** |
| **鉴权（capability / token）** | 你有权做什么 | adapter token、scope | 是 |
| **幂等键** | 同一操作如何只生效一次 | `actionId`、`(adapterId, source, adapterEventRef)`、`(eventId, adapterId, source, requestNonce)` | 否（只是去重） |
| **requestNonce** | 这是**同一次投递**吗 | `^[A-Za-z0-9_-]{16,64}$` | 否 |

**三条禁止**

1. **不得**把 `requestNonce` 当 `eventId`：一个事件可以有多条投递（重试），但只有一个身份。
2. **不得**用 ID 代替鉴权：拿到 `personaId` 不等于有权操作该人格。
3. **不得**用内容哈希充当任何上述标识（会变相留存原文特征，见 `DATA-MODEL.md` §5.3）。

**区别小结**：`eventId` 标识**观察**，`requestNonce` 标识**投递**，`actionId` 标识**意图**，
`runId` 标识**一次执行**。四者不可互换。

## 9. 与现有数据库 / 生命周期的兼容性

### 9.1 已有列对照

| 表 | 列 | 对应 ID | 状态 |
|---|---|---|---|
| `personas` | `id` | personaId | 兼容 |
| `sessions` | `id` / `external_id` | sessionId / adapter 侧会话引用 | 兼容（`external_id` 即 `externalSessionRef`） |
| `thought_threads` | `id` | threadId | 兼容 |
| `tasks` | `id` / `run_id` / `attempt` | taskId / runId / attemptNo | 兼容，需明确"每次 attempt 换 runId" |
| `events` | `id` | eventId | **需改**（见 §9.2） |
| `action_records` | `action_id` | actionId | 兼容 |

### 9.2 必须的数据模型修正：`events` 主键冲突消解

`events.id` 是全局主键，而 Adapter 只提供 `adapterEventRef`。为此 `events` 增加两列并建唯一索引：

```sql
adapter_id        TEXT NOT NULL,   -- 来源适配器（内部来源用 system.* 正式 ID）
adapter_event_ref TEXT NOT NULL,   -- 适配器侧的刺激标识，重试复用
CREATE UNIQUE INDEX ux_events_dedupe
  ON events (adapter_id, source, adapter_event_ref);
```

- `events.id` **只由 Ingress 生成**（`evt_` 前缀）。
- 去重键命中 → 直接返回既有 `eventId`，不新增事件行。
- `adapter_event_ref` 是**外部引用**，允许适配器自定义格式（仍受长度/字符集约束），
  但它**不是**内部身份，不参与任何权限判断。

### 9.3 对现有文档的同步（SH-003 已执行）

| # | 文档 | 变更 | 状态 |
|---|---|---|---|
| 1 | `RUNTIME-LIFECYCLE.md` §7.1 | 信封字段表：`eventId` 改为 `adapterEventRef`；`eventId` 改为 ACK 返回值 | **已同步** |
| 2 | `RUNTIME-LIFECYCLE.md` §7.3 | 幂等条目新增"去重入口是 `adapterEventRef`" | **已同步** |
| 3 | `DATA-MODEL.md` §3 | `events` 增加 `adapter_id` / `adapter_event_ref` 两列 + 去重唯一索引 | **已同步** |
| 4 | `DATA-MODEL.md` §3.1 | 新增 `adapter_event_ref` 字段白名单行 | **已同步** |
| 5 | `MODULES.md` | `runtime` 增加"六类 ID 分配"；`contracts` 增加"ID 格式与生成契约" | **已同步** |
| 6 | `PLAN.md` §4 / `README.md` | 文档入口指向本文 | **已同步** |

**尚未同步、需要后续处理**：`sessions.external_id` 的语义（`externalSessionRef`）目前只在本文 §4.2 说明，
`DATA-MODEL.md` 的注释仍是旧措辞。这是措辞级差异，不影响结构；留到 P1 实现该表时一并更新。

## 10. 正例 / 反例 / 边界

### 正例

```json
// 1. Adapter 首次投递 → 拿到 eventId
{ "adapterId": "minecraft", "adapterEventRef": "mc-7f3a9c21", "requestNonce": "NQ7x...16chars" }
→ 201 { "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH", "status": "accepted" }

// 2. 同一刺激重投（网络超时）→ 复用原 eventId
{ "adapterId": "minecraft", "adapterEventRef": "mc-7f3a9c21", "requestNonce": "SAME-nonce-reused" }
→ 200 { "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH", "status": "accepted" }

// 3. 重试一次模型调用 → 新 runId，同 taskId
{ "taskId": "tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF", "attemptNo": 2, "runId": "run_01JQ8Z6C8Q0S2U4W6Y8A0B2CEG" }
```

### 反例

| 反例 | 为什么错 |
|---|---|
| Adapter 提交 `eventId: "1"` | 主键会被外部控制；两个适配器必然冲突 |
| 两个 Adapter 都发 `adapterEventRef: "1"` | 合法：由 `adapterId` 隔离，不冲突 |
| 用 `requestNonce` 当去重键判断"是否同一事件" | nonce 标识**投递**，同一事件重试时 nonce 应当复用，但不同投递也可能换 nonce |
| 重试时分配新 `actionId` | 会导致同一意图被执行两次（重复真实动作） |
| 重试时复用旧 `runId` | 计费/时延/失败归因全部失真 |
| 用 `sessionId` 作为记忆主键 | 会话是窗口不是人格，换窗口记忆就断 |
| 模型在提案里写 `actionId` | 越权：意图身份必须由确定性代码分配 |
| 由 ID 反推权限 | ID 不含权限信息；权限由 capability 决定 |

### 边界

| 边界情况 | 处理 |
|---|---|
| 同一 `adapterEventRef`、不同正文 | 归档冲突路径：409 + 冲突审计，**不改写原事件**（`RUNTIME-LIFECYCLE.md` §7.3.2） |
| 同一 `externalSessionRef` 断开后重连 | **新 `sessionId`**，不复活旧窗口 |
| 线程恢复后又中断 | 同 `threadId`；每次模型调用仍产生新 `runId` |
| 动作执行中进程崩溃 | 按 `actionId` 向适配器对账；无回执不标成功 |
| 动作超时但适配器实际成功 | 以真实回执为准；`actionId` 不变，状态由回执更新 |
| `adapterEventRef` 被适配器**错误复用**（不同内容） | 与归档冲突同路：拒绝并报冲突，不静默接受 |
| 迁移旧库 | 旧 `events.id`（旧格式）→ 需重新生成 `evt_` 并建立 `adapter_event_ref` 映射（P9） |

## 11. OPEN（尚未决定，含最迟决策阶段）

| # | 问题 | 原因 | 最迟决策阶段 |
|---|---|---|---|
| OPEN-1 | `runId` 是否需要独立 `runs` 表保存全部历史尝试 | 现在只存 `tasks.run_id`（当前尝试），历史尝试会丢；影响计费与复盘 | **P1 建表前** |
| OPEN-2 | 会话空闲多久自动关闭（`closed_at` 置位阈值） | §4.2 已定"首事件自动创建"，但自动关闭阈值未定；影响空会话治理与会话数膨胀 | **P2 事件接入前** |
| OPEN-3 | 跨部署导入时的 ID 重映射规则 | 唯一性只在单部署内保证 | **P9 迁移前** |
| OPEN-4 | `adapterEventRef` 的保留期（适配器多久内可重试） | 与事件保留策略耦合 | **P8 前** |
| OPEN-5 | 模型是否可见 `threadId` / `actionId` | 影响可解释性与越权风险（当前定为不可见） | **P5 自主认知前** |
| OPEN-6 | 旧库 `sessions`/`events` 的 ID 迁移映射细则 | 旧 ID 非 `evt_` 格式 | **P9 迁移前** |
| OPEN-7 | ID 生成器是否需要在 CI 做碰撞与大样本格式测试 | 属测试设计，非协议本身 | **P1 实现时** |

## 12. 验收表

> 本文档为**协议定义**，下列各项为**待实现后的验收条件**，不是当前通过状态。

| ID | 验收项 | 状态 |
|---|---|---|
| I01 | 六类 ID 格式符合 §3.1 正则，长度恒为 30 | 未实现 |
| I02 | 所有 ID 由 Harness 生成；Adapter 提交内部 ID 一律拒绝 | 未实现 |
| I03 | 相同 `(adapterId, source, adapterEventRef)` 重投返回同一 `eventId` | 未实现 |
| I04 | 不同 Adapter 使用相同 `adapterEventRef` 不冲突 | 未实现 |
| I05 | 每次重试产生新 `runId`，`taskId` 不变，`attemptNo` 递增 | 未实现 |
| I06 | 同一意图的所有重试复用同一 `actionId` | 未实现 |
| I07 | 无 `actionId` 或 `actionId` 不匹配的回执被拒绝 | 未实现 |
| I08 | 崩溃恢复后 `executing` 动作不因重启被标记成功 | 未实现 |
| I09 | 任何记录都可凭 `personaId` 隔离查询，不串人格 | 未实现 |
| I10 | `requestNonce` 与 `eventId` 在任何路径上不可互换 | 未实现 |
| I11 | ID 中不含可推断内容的信息（仅时间前缀） | 未实现 |
| I12 | 数据库唯一索引能捕获生成器碰撞并报错而非覆盖 | 未实现 |

---

**本文档不表示任何实现已完成。** 六类身份的代码、Schema 与测试属 SH-004 及后续阶段。
