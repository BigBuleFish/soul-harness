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

前注意阶段只暴露可信信封（来源、点名程度、紧急度、时间、授权、受限摘要）。
**不得**"先让模型读完整内容，再表演没注意到"。

### 7.1 原始正文的唯一进入路径

```
Adapter 提交（信封 + 正文）
   │
   ▼
[1] Ingress 校验：鉴权、来源、限流、协议版本
   │  ✗ 失败 → status=rejected（正文立即丢弃，不落任何存储）
   ▼
[2] 写入短暂感知缓冲（TTL，默认 60s，可配）
   │     └── 正文此刻**只存在于**该缓冲，未进入任何长期表
   ▼
[3] Pre-attention 判定 → attentionOutcome
   │     ├── ignored      → status 保持 accepted，等 TTL 到期 → expired
   │     ├── queued       → 留在有限队列，带过期时间与反刷屏限流
   │     ├── partially_aware / fully_aware → 进入 [4]
   │     └── forced_control → 立即处理，可打断其他通道
   ▼
[4] 选择性编码判定（importance / 注意 / 情绪 / 重复 / 已有联系 / 随机探索）
   │     ├── 不编码 → 缓冲到期即删，**不建立任何长期痕迹**
   │     └── 编码   → 进入 [5]
   ▼
[5] Archive 写入原始记录（**门槛未达时跳过**，见 TRUST-BOUNDARIES §5.2）
   │     ├── 成功 → events.archive_ref 写入不透明引用
   │     └── 失败 → 见 §7.2
   ▼
[6] 产生主观记忆提案 → 提交器 → 记忆节点（加密片段）
   ▼
[7] 事件 status 推进（understood / response_committed / acted）
```

**硬约束**

1. 正文**只能**存在于 [2] 的 TTL 缓冲，以及 [6] 之后编码出的**密文片段**。
2. `events`、`tasks.payload_json`、`runtime_state.checkpoint_json`、日志**一律不得**成为原文旁路。
   字段级禁令见 `DATA-MODEL.md` §3.1。
3. 感知缓冲到期即删；**不得**用"长期索引"偷偷保留未编码原文。
4. 内存在缓冲期内属于敏感数据：不得写交换文件、不得进崩溃转储（部署要求）。

### 7.2 Archive 不可用 / 写入失败

| 情形 | 处理 |
|---|---|
| 门槛未达（P1–P2） | **不启用 Archive**。原始正文随感知缓冲 TTL 到期即删；`events.archive_ref` 留空。此时只允许"不产生审计承诺"的功能 |
| 写入瞬时失败 | 有界重试（默认 3 次，指数退避）。重试期间正文留在缓冲内，**不复制到 events** |
| 重试耗尽 | 丢弃正文，`events.status = rejected`（原因码 `archive_unavailable`）或 `expired`。**不得**降级为"存进 events 再说" |
| Archive 长时间不可用 | 停止接收需要持久审计的刺激源（Adapter 侧收到 503），而不是收下却记不住 |
| 恢复后 | 不追补、不重放历史正文。新刺激按新规则处理 |

**不允许的"聪明做法"**：把正文暂存到 `tasks.payload_json` 等它恢复；写临时文件；压进日志。

### 7.3 队列溢出与事件重试

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
