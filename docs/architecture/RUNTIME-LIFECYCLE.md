# RUNTIME-LIFECYCLE — 运行时生命周期

- **地位**：Daemon、Persona、Thought、Event、Sleep 的状态机与启停顺序权威描述。
- **状态**：设计中。所有状态名在代码中为**枚举常量**，不得散落字符串字面量。

---

## 1. 设计原则

1. **进程重启不得导致人格状态清零。** 任何状态都必须可从库 + 检查点恢复。
2. 停止**不依赖人格同意**。用户可以随时停掉它，人格的"困倦""不想睡"不能阻挡安全控制。
3. 未完成的任务不得被标记为完成。中断就是中断，记录真实进度。
4. 每个状态转移都必须留下可查询的记录（谁触发、何时、依据版本）。

## 2. Daemon 启动顺序

`BOOTING` → `MIGRATING` → `RECOVERING` → `READY` → `RUNNING`

| # | 步骤 | 失败处理 |
|---|---|---|
| 1 | 读取配置（路径、端口、模型、令牌） | 缺关键项 → `FAILED`，不猜默认值 |
| 2 | 初始化结构化日志（禁明文私人内容） | 失败 → `FAILED` |
| 3 | 检查数据目录与写权限 | 无权限 → `FAILED`（不要自动降级到临时目录） |
| 4 | 获取**单实例锁**（按数据目录） | 已被占用 → 退出并报告持锁进程 |
| 5 | 打开 SQLite（WAL，单连接写入者） | 打开失败 → 释放锁 → `FAILED` |
| 6 | 执行 Migration（见 DATA-MODEL §8） | 失败 → 回滚 → `FAILED` |
| 7 | 恢复 Persona（state / version / epoch） | 见 §4 恢复规则 |
| 8 | 恢复 Runtime（检查点、队列、活跃思维） | 过期条目丢弃并记录 |
| 9 | 初始化 Event Bus | — |
| 10 | 初始化 Scheduler（按自适应 Tick） | — |
| 11 | 启动本地 API + WebSocket（loopback + 令牌） | 端口占用 → `FAILED`，不自动换端口 |
| 12 | 启动健康检查 | — |
| 13 | 进入 `RUNNING`，可接收事件 | — |

**顺序是硬的。** 特别地：没有单实例锁就不许开库；没跑完 Migration 不许恢复 Persona；API 最后开。

## 3. Daemon 关闭顺序

`RUNNING` → `DRAINING` → `CHECKPOINTING` → `CLOSING` → `STOPPED`

| # | 步骤 | 说明 |
|---|---|---|
| 1 | 停止接收新任务（API 返回 503） | 不再 ACK 新刺激 |
| 2 | 停止派发新调度 | 已在跑的允许有限收尾 |
| 3 | 等待或取消运行中任务 | 超时则取消，**记录为 cancelled，不记为完成** |
| 4 | 提交合法状态 | 只提交已完整产生的状态 |
| 5 | 写检查点（队列游标、活跃线程、epoch） | 检查点必须自带 `epoch` |
| 6 | 关闭 API / WebSocket | 先广播 `shutting_down` 再断开 |
| 7 | 关闭数据库（含 WAL checkpoint） | — |
| 8 | 释放单实例锁 | 最后一步 |

强制终止（进程被杀）下，靠 §4 的恢复规则保证一致性；**不保证**梦境或睡眠任务状态。

## 4. 崩溃恢复规则

| 场景 | 规则 |
|---|---|
| Persona 处于 `STARTING` / `STOPPING` | 归一到 `STOPPED`，要求显式重启，不自动猜 |
| 存在 `running` 状态的 task | 重置为 `queued` 并 `attempt+1`；超过上限转 `failed` |
| 睡眠周期中断 | 记录**已完成**的周期数，不补账、不声称做过 |
| 梦境中断 | `outcome=INTERRUPTED`，不生成醒后片段 |
| 已提交但索引未刷新 | 启动时按 `content_epoch` 重建派生索引 |
| 检查点 `epoch < 当前 epoch` | 丢弃该检查点（不得越过墓碑） |
| 动作处于 `executing` | 用 `actionId` 向适配器核对；**未收到回执一律不标记成功** |

## 5. Persona 状态机

```
CREATED ──start──► STARTING ──► RUNNING
                                  │  ▲
                          suspend │  │ resume
                                  ▼  │
                               SUSPENDED
                                  │
                    stop（任意状态）▼
                              STOPPING ──► STOPPED
                                  │
                              任意失败 ──► FAILED
```

| 状态 | 含义 | 允许的内部活动 |
|---|---|---|
| `CREATED` | 档案已存在，未运行 | 无 |
| `STARTING` | 装载记忆、恢复线程 | 无 |
| `RUNNING` | 正常运行 | 全部通道 |
| `SUSPENDED` | 挂起（如用户要求） | 不调度；保留状态 |
| `STOPPING` | 收尾 | 只允许提交与检查点 |
| `STOPPED` | 已停止 | 无 |
| `FAILED` | 启动或运行失败 | 无；需人工介入 |

**`stop` 可从任意状态发起**，且优先于人格意愿。

## 6. Thought 状态机

```
NEW ──► RUNNING ⇄ PAUSED
             ⇅
        INTERRUPTED
             │
             ▼
      COMPLETED / ABANDONED
```

| 转移 | 触发 | 约束 |
|---|---|---|
| `NEW → RUNNING` | 调度器选中 | 需检查同通道并发上限 |
| `RUNNING ⇄ PAUSED` | 让位高优先级 / 自然搁置 | 保存续接位置（有限摘要，**不存无限思维链**） |
| `RUNNING → INTERRUPTED` | 外部刺激抢占 | 保留合法状态以便恢复 |
| `→ COMPLETED` | 有结论 | — |
| `→ ABANDONED` | 失去意义 / 超时 / 循环检测 | 必须记录原因 |

硬规则：

- 一个线程完成**不等于**其他线程结束。
- `inner` 通道的产出**不是**用户消息，不得伪装成 user 消息，不得自动外发，不得当作已执行的经历。
- 所有线程状态带 `personaId`，**不得**用 `sessionId` 当主体。
- 检测语义循环 / 重复自我争论 / 无新信息空转 → 退火、冷却、切换主题。**允许发呆和沉默。**

## 7. Event 生命周期

```
received → accepted → noticed → understood → response_committed → acted
    │          │          │
    └──────────┴──────────┴──► rejected / expired
```

| 状态 | 含义 |
|---|---|
| `received` | Ingress 收到，已验签/鉴权，**内容尚未进入意识** |
| `accepted` | 通过限流与来源校验，进入前注意队列 |
| `noticed` | 被注意机制选中（`ignored` / `queued` / `partially_aware` / `fully_aware`） |
| `understood` | 模型已解释（产生主观理解） |
| `response_committed` | 输出已提交（经 Output Commit，中断后不得晚到） |
| `acted` | 真实动作已收到 `ActionReceipt` |
| `rejected` | 被拒绝（越权、来源不可信、注入嫌疑） |
| `expired` | 过期（队列满、等待超时、TTL 到期） |

**不必经所有状态。** 关键区分：
收到 ≠ 注意到；注意到 ≠ 理解；产生行动意图 ≠ 行动已执行。

前注意阶段只暴露可信信封（来源、点名程度、紧急度、时间、授权、**非内容元数据**）。
**不得**把正文任何形式的转述（摘要、关键词、情感标签）交给前注意阶段。
**不得**"先让模型读完整内容，再表演没注意到"。

### 7.1 原始正文的唯一进入路径（按归档判定分流）

**决议**：采用**范围受策略限定的完整归档**。归档对象 = 通过 Ingress 鉴权与校验、
**且被确定性策略判定为 `required`** 的刺激；与 Pre-attention 判定、与人格是否编码**均无关**。

"完整审计"**只**覆盖 `required` 范围。`excluded` 事件不被纳入完整审计承诺。

```
Adapter 提交（信封 + 正文）
   │
   ▼
[1] Ingress 鉴权与校验：鉴权、来源、限流、协议版本、信封 Schema
   │  ✗ 失败 → status=rejected（正文立即丢弃，不落任何存储，不归档，不 ACK）
   ▼
[2] 写入短暂感知缓冲（TTL，默认 60s，可配）
   │     └── 正文此刻**只存在于**该缓冲
   ▼
[3] 确定性策略判定 archive_disposition（**不经过模型**，见 §7.2）
   │
   ├── required 且 Archive 能力已启用 ─────────────────────────┐
   │                                                          │
   │   [3R] Archive Writer 加密写入（按 eventId 幂等）          │
   │      │  ✗ 失败 → 有界重试 → 耗尽则对适配器 503            │
   │      │           **不得 ACK accepted**，不得降级 excluded  │
   │      ▼                                                   │
   │   [3S] 提交 events.archive_ref + archive_state='archived'  │
   │      │  ✗ 崩溃窗口 → 按 §7.4 恢复（IPC 只查状态）           │
   │      ▼                                                   │
   │   [3A] ACK accepted  ← required 事件只在这里 ACK           │
   │                                                          │
   ├── excluded ─────────────────────────────────────────────┘
   │      → archive_state='excluded'，**不创建 Archive Record**
   │      → [3A] ACK accepted（无审计承诺）
   │
   └── Archive 能力关闭（P1）
          → archive_state='none'，不判定 disposition
          → [3A] ACK accepted（**不承诺原始事件审计**）
   ▼
[4] Pre-attention 判定 → attentionOutcome
   │   ├── ignored        → status 保持 accepted，TTL 到期 → expired
   │   ├── queued         → 有限队列，带过期与限流
   │   ├── partially_aware / fully_aware → [5]
   │   └── forced_control → 立即处理，可打断其他通道
   ▼
[5] 选择性编码判定（importance / 注意 / 情绪 / 重复 / 已有联系 / 随机探索）
   │   ├── 不编码 → 缓冲到期即删，**不建立长期痕迹**
   │   └── 编码   → [6]
   ▼
[6] 主观记忆提案 → 提交器 → 记忆节点（密文片段）
```

**不变式**

| # | 不变式 |
|---|---|
| 1 | 正文**只能**存在于 [2] 的 TTL 缓冲、`required` 事件的**加密归档记录**、以及 [6] 之后的**密文片段** |
| 2 | `events`、`tasks.payload_json`、`runtime_state.checkpoint_json`、日志**一律不得**成为原文旁路 |
| 3 | `required` 事件：**Archive 持久化 + `archive_ref` 提交完成之前，不得返回 `accepted`** |
| 4 | `required` 事件：Archive 失败**不得**自动降级为 `excluded`，**不得**进入正式 `understood` / `response_committed` 流程 |
| 5 | `excluded` 事件：不创建 Archive Record，不提供审计能力，原文仍只能在感知缓冲中存在 |
| 6 | 归档判定（disposition）**不得**经过模型：模型无权决定某条输入是否需要审计 |
| 7 | 归档写入**不得**因 [4] 的 `ignored` 而跳过；`required` 事件的归档先于注意判定 |
| 8 | 归档失败时**不得**把正文降级写入 `events` 或任何其他长期表 |
| 9 | P1（Archive 关闭）：`archive_state='none'`，正文随 TTL 删除，**不承诺任何原始事件审计能力** |

### 7.2 Archive 存储语义与 P1 决议

**Archive 保存的是"经过认证的原始记录"，加密存储，与主观记忆是两套东西。**

| 约束 | 内容 |
|---|---|
| 加密 | Archive 原始数据**必须加密存储**，不得以明文落盘 |
| 密钥 | 使用**独立于主观记忆**的 Archive 密钥层级；**禁止与主观记忆密钥混用或派生** |
| 访问 | **Brain 永远没有 Archive 的密钥，也没有读取权限**；Brain 侧不编译 Archive 客户端 |
| 写入者 | **Archive Writer 是唯一写入者**。其他任何进程不得直写 Archive |
| 保留策略 | 每条 Archive 记录必须归属**有限期**保留分类（§7.2.2）；**不允许默认永久保存** |
| 禁止导入 | **不得**把 Archive 内容导入主观记忆当作"隐藏正确答案"；它只能作为**新观察**从 Ingress 进入 |
| 审计边界 | "完整审计"**只**覆盖 `archive_disposition = required` 的事件；`excluded` 不纳入该承诺 |

**P1 决议（本次正式确定）**：P1 **允许在没有 Archive Writer 的情况下接收外部事件**。

| P1 行为 | 规定 |
|---|---|
| 接收与验证 Stimulus | **允许** |
| 创建 `eventId` | **允许** |
| 持久保存事件信封与非内容元数据 | **允许**（字段白名单见 `DATA-MODEL.md` §3.1） |
| `events.archive_ref` | **允许为 NULL** |
| 原始正文 | **只允许**存在于有 TTL 的短暂感知缓冲，不得落任何长期表 |
| TTL 到期 | **必须删除**，不得用索引/日志/检查点变相保留 |
| 原始事件审计能力 | **不承诺**。P1 文档、API 与 UI 均不得暗示具备此能力 |

#### 7.2.1 归档判定 ArchiveDisposition

| 取值 | 含义 | 后果 |
|---|---|---|
| `required` | 该事件属于审计范围 | 必须先归档成功并提交 `archive_ref`，才允许 ACK `accepted`；进入完整审计承诺 |
| `excluded` | 明确排除在审计范围外 | **不创建 Archive Record**，不赋 `retention_class`；照常进入认知流程，但不提供审计 |

**判定规则**

1. 判定必须是**确定性的**：由配置策略 + 事件元数据（来源、类型、渠道、标志位）计算得出，**可复现**。
2. **模型不得参与判定**，也无权提议、覆盖或"申请"豁免。
3. `excluded` **必须有明确策略依据**，且该依据在审计日志中可查（策略 ID + 命中规则）。
4. 未命中任何 `excluded` 规则且 Archive 能力已启用时，默认判定为 `required`
   （即"默认审计，例外才排除"）。
5. P1（Archive 能力关闭）**不判定 disposition**，`archive_state = 'none'`。

#### 7.2.2 保留分类 RetentionClass

| 取值 | 用途 |
|---|---|
| `standard` | 常规审计记录 |
| `restricted` | 敏感来源或受限内容，保留期更短、访问更严 |
| `short_lived` | 仅短期可用（调试、临时排障） |

1. 只有**实际创建 Archive Record** 的事件才有 `retention_class`；`excluded` 与 P1 事件没有该字段值。
2. **具体保留天数暂不决定**（OPEN），但每条记录必须落在某个有限期分类下，
   **不允许"永久保存"作为默认值**。
3. 若某策略未配置有限保留期 → **拒绝归档该记录**（返回配置错误），不得回退为永久。
4. 保留期到期由 Archive Writer 按分类执行删除，**独立于**主观记忆的遗忘流程。

### 7.3 写入失败、幂等与恢复

| 情形 | 处理 |
|---|---|
| P1（Archive 关闭） | 不派发归档；正文随 TTL 删除；`archive_state='none'`、`archive_ref` 为 NULL |
| `required` 瞬时失败 | 有界重试（默认 3 次，指数退避）。重试期间正文留在缓冲内，**不复制到 `events`**；**期间不 ACK `accepted`** |
| `required` 重试耗尽 | 对适配器返回 **503**；事件**不得**进入 `understood` / `response_committed`；**不得**降级为 `excluded`，**不得**落 `events` |
| Archive 长时间不可用 | 对 `required` 源停止受理（503），而不是收下却记不住 |
| `excluded` 事件 | 与 Archive 无关，照常处理；无审计 |
| 恢复后 | **不追补、不重放**历史正文；新刺激按新规则处理 |

**幂等（硬要求）**

1. **Archive Writer 自己负责 `eventId` 幂等**：同一 `eventId` 重复写入不得产生第二条记录。
2. **同一 `eventId` 对应不同内容 → 拒绝覆盖并报告冲突**（错误码 `archive_conflict`）：
   保留原始记录不变，冲突事件写入审计（**不含内容**），并把该 `eventId` 标记为冲突待人工处理。
   - "不同内容"的判定在 Archive Writer 内部完成（见 `DATA-MODEL.md` §5.1 的指纹字段）。
   - Brain 侧**看不到**判定依据，只收到冲突错误码。

**恢复流程（Brain 不直连 Archive）**

1. **Brain 不允许直接连接 Archive 数据库**。它没有连接串、没有句柄、没有密钥。
2. 恢复只能通过**受限 IPC** 获取以下三项，**且只此三项**：
   - `eventId`
   - `archiveState`
   - `archiveRef`
3. **不得**通过该 IPC 返回：原文、密文、解密内容、内容指纹、字节长度、密钥信息、任何可推断内容的字段。
4. 流程：扫描 `archive_state='pending'` 的事件 → 逐个 IPC 查询：
   - `archived` → 只补 `archive_ref`，**不重写原文**；
   - `not_found` → 重新派发归档（若缓冲已过期则标记 `failed` 并丢弃，**不伪造记录**）；
   - `failed` / 冲突 → 记录并上报，不自动"修复"。
5. 归档写入成功与 `archive_ref` 提交**不要求同一事务**（跨进程），但必须保证
   "**至多一次归档、至少一次标记尝试**"。
6. 恢复扫描必须有界（批量 + 限速），不得在启动时全表扫描。

**不允许的"聪明做法"**：把正文暂存到 `tasks.payload_json` 等它恢复；写临时文件；压进日志；
在重试时改变 `eventId` 以"绕过冲突"；让 Brain 直连 Archive 只读"确认一下"。

### 7.4 ACK 语义（按 disposition 区分）

**`accepted` 不是同一个含义 —— 取决于事件类别。**

| 事件类别 | `accepted` 的含义 | **不代表** |
|---|---|---|
| `required`（Archive 已启用） | Archive **已加密持久化**，**且** `events.archive_ref` 已提交 | 不代表已注意、已理解、已形成记忆 |
| `excluded` | 已通过鉴权并持久化信封（`archive_state='excluded'`） | 不代表已归档（本就不归档）、不代表具备审计 |
| P1（`archive_state='none'`） | 已通过鉴权并持久化信封 | **不代表已归档**；系统此时无审计能力 |

**规则**

1. `required` 事件在归档完成前**不得**返回 `accepted`；失败重试耗尽则返回 **503**。
2. `accepted` **不保证内容被长期保留**：TTL 到期、队列溢出、注意力忽略都可能导致
   该事件不形成任何主观记忆。**审计与记忆是两件事** —— `required` 事件即使没被记住，原文仍在 Archive。
3. `excluded` 与 P1 事件：`accepted` 之后系统仍可能不保留任何内容，且**永远无法补查**。
4. Adapter SDK 必须逐条写明上表，禁止适配器把 `accepted` 解释为"已存档"或"已记住"。
5. 对 `required` 源，Adapter 必须处理 503：退避重试、同一 `eventId` 重投，**不得**换新 ID。

### 7.5 队列溢出与事件重试

| 情形 | 处理 |
|---|---|
| 同一会话队列满 | 新事件 `status = expired`（`queue_overflow`）；对适配器回 429，**不静默丢弃** |
| 事件超过 TTL 仍未注意 | `status = expired`；缓冲删除 |
| 适配器重投同一 `eventId` | 按 `eventId` 幂等：已存在则不重复处理，返回已有状态 |
| 处理失败（非 Archive） | 有限重试（默认 3 次），超限 `status = rejected`；记录原因码，不进主观记忆 |
| 迟到事件（`occurred_at` 远早于 `received_at`） | 允许处理，但 `subjective_time` 必须用 `occurred_at` 与接收时间共同表达，不得伪装成"刚刚发生" |

所有队列必须**有限、可过期、带反刷屏限流**。

## 8. 睡眠与唤醒

```
AWAKE ──enter──► SLEEPING
                    │
       ┌────────────┴────────────┐
       │                         │
   正常完成                   外部刺激
       │                         ▼
       │                  AROUSAL_PENDING
       │                    │         │
       │              未唤醒/部分   完全/强制
       │                    │         │
       ▼                    ▼         ▼
  DREAM_STOPPED ◄───────────┴─────────┘
       ▼
  FRAGMENT_SELECTION
       ▼
  REALITY_ORIENTATION
       ▼
     AWAKE
```

- 正常整夜**动态计划 4–6 个功能周期**（工程调度概念，不等于人类睡眠阶段）。
- 每周期可组合：记忆回放、远近联想、泛化、重构、遗忘、技能候选、梦境、提交、检查点。
- 早期多处理近期痕迹，后期增加远距离关联。
- 夜间**不得**从 Archive 重读已遗忘的经历。
- 被叫醒：先禁止新睡眠任务派发 → 取消未提交提案 → 保存合法检查点 → 清除梦境临时上下文 →
  恢复当下真实环境感知 → 再决定是否续睡。
- **中断时只记录真实完成的部分**，不得标记"已做梦 / 已巩固"。

### 唤醒分级

| 级别 | 行为 |
|---|---|
| 未唤醒 | 无反应，继续当前周期 |
| 部分觉醒 | 提升注意，不中断周期 |
| 完全觉醒 | 走完整醒后流程 |
| 强制控制 | **立即执行**，不受困倦或偏好阻挡（关窗口、停运行、撤权限、安全控制） |

## 9. 单实例与并发

- 单实例锁按**数据目录**粒度，不按端口（端口可换，数据目录是身份）。
- 多人格共存时：每个 persona 一个写入协调器，跨 persona **不共享**缓存、队列与激活状态。
- 同一 persona 的写事务串行；读可并发（WAL）。
- 禁止跨 persona 复用任何内存结构（含模型客户端会话、embedding 缓存）。

## 10. 健康检查

必须暴露至少：进程状态、当前 Persona 状态、单实例锁归属、DB 可读写、
队列深度（按通道）、最近一次成功提交时间、最近一次错误。
**不得**在健康检查里泄露主观记忆内容或 Archive 审计数据。
