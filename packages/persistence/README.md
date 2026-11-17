# `@soul-harness/persistence` — 持久化基础

- **地位**：P1 唯一的 SQLite 访问层。任何模块都不得自行打开数据库文件、转换字段名或直接写表。
- **状态**：**批次 A（数据库基础与 Migration）+ 批次 B（事务、字段映射、六表 Repository）已完成**。
  检查点保存/读取属批次 C，尚未提供。
- **上位文档**：[DATA-MODEL](docs/architecture/DATA-MODEL.md) §1/§3/§6/§8、[MODULES](docs/architecture/MODULES.md) §2–§3、
  [RUNTIME-LIFECYCLE](docs/architecture/RUNTIME-LIFECYCLE.md) §2/§9、[TRUST-BOUNDARIES](docs/architecture/TRUST-BOUNDARIES.md) §5.1/§11.3。

## 1. 负责什么

| 能力 | 说明 |
|---|---|
| 连接与生命周期 | `openStore()` / `Store.close()`；自动创建父目录；不自动执行迁移 |
| 连接不变量 | `journal_mode=WAL`、`foreign_keys=ON`、`secure_delete=ON`、`busy_timeout`；打开后**读回断言** |
| Migration | 目录或数组来源统一校验、版本唯一、升序、checksum、逐文件事务 |
| 结构校验 | `verifySchema()` 对照 P1 六表六索引（含列顺序） |
| 事务 | `withWrite` / `withRead`；单写者、同步回调、嵌套拒绝、句柄失效保护 |
| 字段映射 | snake↔camel 纯机械转换；JSON 列带 schema 标识；布尔 0/1 |
| Repository | 六张 P1 表的基础 CRUD；错误分类；分页上限 |

## 2. 不负责什么

1. **不判断业务语义**：不决定事件是否该被注意、是否形成记忆、人格该做什么。
2. **不访问 Archive**：无连接、无密钥、无解密能力；P1 的 archive 三列恒为 NULL/NULL/`none`。
3. **不暴露裸句柄**：`DatabaseSync` 不在包入口；事务回调只拿到有生命周期的 `Tx`。
4. **不做进程级单实例锁**：属 Daemon（RUNTIME §9 第 4 步）。
5. **不保存正文**：P1 六表无任何正文字段。
6. **不实现检查点**：`runtime_state.checkpoint_json` 由批次 C 的专用接口负责；upsert 不会触碰该列。

## 3. 目录

```
packages/persistence/
├─ migrations/0001_init_core.sql   # P1 六表 + 六索引
├─ src/
│  ├─ index.ts                     # 唯一公共入口
│  ├─ errors.ts                    # PersistenceError + 受控错误码
│  ├─ mapping.ts                   # snake↔camel、JSON 列、布尔
│  ├─ db/{open-store,store,pragmas,rows,classify}.ts
│  ├─ tx/coordinator.ts            # withWrite / withRead
│  ├─ migrations/{types,expected-schema,load,migrator}.ts
│  ├─ repositories/{personas,sessions,events,tasks,runtime-state,schema-migrations,shared,index}.ts
│  └─ types/rows.ts                # camelCase 行类型（复用 contracts 品牌 ID）
└─ test/                           # 100 项，真实 SQLite 文件
```

## 4. 依赖

- 运行时依赖：`@soul-harness/contracts`（仅类型与枚举；品牌 ID、事件状态等）。
- 数据库驱动：Node 内置 `node:sqlite`，**无第三方数据库依赖、无 ORM**。

## 5. 事务模型

```ts
withWrite(store, (tx) => T): T     // T 必须同步；返回 Promise 视为错误
withRead(store, (tx) => T): T
```

| 保证 | 实现 |
|---|---|
| 单写者 | 单连接 + `BEGIN IMMEDIATE`；回调**同步**执行，JS 单线程下事务不可能被 `await` 打断 |
| 异步回调 | 运行时检测 thenable → `async_callback_unsupported`（回滚），**不做半支持** |
| 嵌套写 | 任何模式下的 `withWrite` 嵌套 → `nested_write` |
| 读嵌套 | `withRead` 在外层事务内**加入**外层（不新开事务、不切 `query_only`） |
| 只读强制 | `withRead` 期间 `PRAGMA query_only = ON`，写入被 SQLite 拒绝（`read_only_violation`） |
| 句柄生命周期 | 事务结束后 `Tx` 失效，再调用 → `transaction_closed` |
| 错误保真 | 非 SQLite 错误原样抛出（identity 不变）；SQLite 错误分类后带 `cause` |
| 关闭后 | `store_closed`，不会静默重开 |

> **设计取舍**：不提供异步事务。`node:sqlite` 是同步 API，允许 `await` 会把事务拉长到跨越提交点之外，
> 正是"异步操作在事务结束后继续写库"的成因。需要异步工作时，应在事务**外**完成。

## 6. 字段映射

| 规则 | 例 |
|---|---|
| camel → snake | `personaId` → `persona_id`、`adapterEventRef` → `adapter_event_ref` |
| snake → camel | `received_at` → `receivedAt` |
| 非法名 | 空、首字母大写、`__`、首尾下划线、含 `-`/空格 → `invalid_field_name`（**不修复**） |
| 行键转换 | `camelizeRow()` 只改键；`null` 原样保留，不转 `undefined` |
| 布尔 | `toDbBoolean` / `fromDbBoolean`；只接受 0/1，其他 → `invalid_column_value` |
| JSON 列 | `encodeJsonColumn(schemaId, payload)` 写入 `schema` 标记；`decodeJsonColumn` 校验；payload 自带 `schema` 被拒绝 |

映射**不生成 SQL**：Repository 用固定语句 + 参数绑定，映射只处理名称与列值形状。

## 7. Repository

| 表 | 方法 |
|---|---|
| `personas` | `insert` / `getById` / `updateState`（版本自增）/ `list(limit)` |
| `sessions` | `insert` / `getById` / `findActiveByExternal` / `close` / `listByPersona` |
| `events` | `insert`（archive 三列不可设）/ `getById` / `findByDedupeKey` / `updateStatus` / `listByPersonaStatus` |
| `tasks` | `insert` / `getById` / `updateState` / `listByPersonaState` |
| `runtime_state` | `upsert`（不触碰 checkpoint）/ `get` |
| `schema_migrations` | **只读**：`listApplied` / `getLatest` |

- 所有写入都经过 `withWrite`；Repository 不持有连接、不暴露 `DatabaseSync`。
- 列表查询默认 50、上限 500，越界 → `invalid_argument`，不存在"全表读取"入口。
- 错误区分：`unique_conflict` / `foreign_key_violation` / `check_violation` / `not_null_violation` / `db_error`。
- 返回 `null` 表示"不存在"（`getById`）或"未命中/未变更"（`updateState` 返回 `null`、`close` 返回 `false`）。

## 8. Migration 机制

1. 文件命名 `NNNN_<snake_desc>.sql`；目录来源与数组来源**共用** `normalizeMigrations()`（校验 + 去重 + 升序）。
2. checksum = 归一化（CRLF/CR → LF）后内容的 SHA-256；始终由 SQL 文本推导，调用方无法注入。
3. 已应用迁移先校验 checksum；不匹配 → `migration_checksum_mismatch`，且不执行任何新迁移。
4. 待应用迁移逐个 `BEGIN IMMEDIATE … COMMIT`；失败回滚，不留半成品表与记账行。
5. 缺失版本 → `migration_not_found`；待应用版本低于已应用最高版本 → `migration_out_of_order`。
6. 允许版本不连续；追踪表由迁移器自举，`0001` 以 `IF NOT EXISTS` 重复同一 DDL。

### 回滚说明

- 已应用迁移**永不回滚**（DATA-MODEL §8.3）；修正靠新增迁移。
- `0001_init_core.sql` 文件头写明测试环境的 DROP 顺序。

## 9. 已知限制

1. **事务回调必须同步**（见 §5）；异步调用方需要在事务外完成 IO。
2. `verifySchema()` 只覆盖 P1 六表；新增迁移必须同步更新 `expected-schema.ts`。
3. 行类型里的 ID 使用 contracts 品牌类型，但**读取不再校验格式**：数据库是存储，不是鉴权边界。
4. `PersonaState` / `TaskState` 目前定义在本包（contracts 未提供）；迁入 contracts 属后续契约变更。
5. 检查点（批次 C）、单实例锁与 WAL checkpoint on close（Daemon）尚未实现。
