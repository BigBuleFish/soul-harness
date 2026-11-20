# `@soul-harness/runtime` — 认知运行时

- **地位**：L3 编排层。业务逻辑在这里，不在 Daemon（[MODULES](../../docs/architecture/MODULES.md) §2–§4）。
- **状态**：**SH-008A 已完成：ID 分配器。** Persona 生命周期、事件总线、调度器、恢复扫描、检查点编排与 Daemon 装配都还没有，对应 SH-008B–E。本目录没有这些能力的空类。
- **上位文档**：[IDENTITY-PROTOCOL](../../docs/architecture/IDENTITY-PROTOCOL.md) §3、[MODULES](../../docs/architecture/MODULES.md) §2–§3、[PLAN](../../docs/PLAN.md) §13。

## 1. 负责什么

按身份协议 §3 的冻结算法分配标识：

| 前缀 | 函数 | 身份 |
|---|---|---|
| `psn` `ses` `thr` `run` `evt` `act` | `allocatePersonaId` 等 | 六类核心身份 |
| `tsk` | `allocateTaskId` | 逻辑任务（辅助，§4.4） |
| `cnf` | `allocateConflictRecordId` | 归档冲突记录（辅助，§3.1） |

算法（不得改）：

1. Unix 毫秒取 48 bit，大端，**高位补零到 50 bit**，编成 10 个 Crockford Base32 字符。因此时间前缀的首字符只能是 `0-7`。
2. `crypto.randomBytes(10)`（80 bit）编成 16 个字符。
3. 加前缀。总长 30。字母表与 `contracts` 的 `ID_ALPHABET` 是同一份，排除 `I L O U`，只输出大写。

碰撞：调用方用 `isOccupied` 告诉分配器「这个 ID 已经被占」。分配器换一对新的时间戳和熵再试。默认最多 **8** 次（`ID_ALLOCATION_MAX_ATTEMPTS`）；显式预算是 `1..128`。耗尽抛 `id_collision`，**不返回已占用的 ID，也不写库**。数据库主键 / 唯一索引仍是最终防线（§3.3）。

时钟默认 `Date.now`，熵默认 `node:crypto`。两者都可以注入，供测试锁住时间前缀。没有 `isOccupied` 时只取一次，不空转。

## 2. 不负责什么

1. **不接受外部指定的内部 ID。** 没有把调用方字符串收成 `PersonaId` 的函数。
2. **不访问数据库，不写 SQL，不读环境变量。** 权威写入仍只在 `@soul-harness/persistence`。本批不依赖 persistence：分配器没有行可写。SH-008B 起才会把 persistence 加进依赖。
3. **不创建人格、会话、思维、动作或冲突记录。** `allocateThreadId` / `allocateActionId` / `allocateConflictRecordId` 只产生符合格式的字符串。没有 ThoughtProcess，没有 Action Gateway，没有 `archive_conflict_records` 表。
4. **不实现** Persona 状态机、事件总线、调度器、扫描 A/B、检查点、Daemon 生命周期。入口不导出这些名字。
5. **不提升 epoch，不分配 `bootId`。** `bootId` 不是身份 ID（§3.4），由 Daemon 生成。
6. **不保存历史 run。** OPEN-1 已决定：P1 不建 `runs` 表。

## 3. 目录

```
packages/runtime/
├─ src/
│  ├─ index.ts                 # 唯一公共入口
│  ├─ errors.ts                # RuntimeError
│  └─ ids/{encode,allocate}.ts # 冻结编码与分配
└─ test/                       # 31 项
   ├─ allocator.test.ts        # 向量、时钟、碰撞、SQLite 主键
   └─ allocator-sample.test.ts # OPEN-7 大样本
```

## 4. 依赖

| 方向 | 包 | 本批实际情况 |
|---|---|---|
| 允许依赖 | `contracts` | **已依赖**。格式校验与字母表只引用 contracts，不在这里复制正则 |
| 允许依赖 | `persistence` | **本批不依赖**。分配器无 IO。测试里的 SQLite 主键在测试文件中，用 `node:sqlite` 证明「冲突不覆盖」，不把 SQL 放进 `src/` |
| 被谁依赖 | 仅 apps | **还没有。** `soul-daemon` 未装配本包 |

`contracts` / `persistence` 不得依赖本包。

## 5. 对外接口

```ts
allocateId(prefix, options?): HarnessId
allocatePersonaId(options?): PersonaId
allocateSessionId(options?): SessionId
allocateThreadId(options?): ThreadId
allocateRunId(options?): RunId
allocateEventId(options?): EventId
allocateActionId(options?): ActionId
allocateTaskId(options?): TaskId
allocateConflictRecordId(options?): ConflictRecordId
```

`AllocateOptions`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `now` | `Date.now` | 返回 Unix 毫秒整数，范围 `[0, 2^48)` |
| `randomBytes` | `crypto.randomBytes` | 入参为 10，必须返回 10 字节的 `Uint8Array` |
| `isOccupied` | 无 | 返回 `true` 则重试；抛错原样传播，不当作碰撞 |
| `maxAttempts` | `8` | 仅在提供了 `isOccupied` 时使用 |

错误码：`invalid_argument` / `invalid_clock` / `invalid_entropy` / `id_collision` / `id_encoding`。消息不回显时钟、熵或候选 ID。

## 6. 测试

| 文件 | 覆盖 |
|---|---|
| `test/allocator.test.ts` | 29 项。已知向量（0、1、32、2^45、2^48−1、大端熵）、前缀不可混用、时钟进退与同毫秒不进位、碰撞重试、真实 SQLite 主键冲突不覆盖、`src/` 无 SQL / 无环境读取 |
| `test/allocator-sample.test.ts` | 2 项。每个前缀 10000 个 ID，另加同毫秒突发 10000 个；全部通过 contracts 的 `is*` / `parse*`，样本内唯一 |

OPEN-7 的样本量就是这两个 **10000**。不把「统计上永不碰撞」写成验收。

## 7. 已知限制

1. 分配 `runId` 不会把历史尝试写入 `runs` 表——P1 没有这张表（OPEN-1，2026-11-20）。
2. 占用检测是调用方的谓词。分配器自己看不到唯一索引；索引测试在 `allocator.test.ts`，生产写入路径要到后续批次才接到这里。
3. 重试上限 8 是本批的实现选择，不是协议里的新常数。需要更多次时由调用方在 `1..128` 内显式传入。
4. 本包被构建、被测试，**不表示** Daemon 已经在恢复人格或受理事件。
