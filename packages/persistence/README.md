# `@soul-harness/persistence` — 持久化基础

- **地位**：P1 唯一的 SQLite 访问层。任何模块都不得自行打开数据库文件或转换字段名。
- **状态**：**批次 A 已完成（数据库基础与 Migration）**。事务、Repository、字段映射、检查点属后续批次，
  当前尚未提供。
- **上位文档**：[DATA-MODEL](docs/architecture/DATA-MODEL.md) §1/§3/§8、[MODULES](docs/architecture/MODULES.md) §2–§3、
  [RUNTIME-LIFECYCLE](docs/architecture/RUNTIME-LIFECYCLE.md) §2/§9、[TRUST-BOUNDARIES](docs/architecture/TRUST-BOUNDARIES.md) §5.1/§11.3。

## 1. 负责什么

| 能力 | 说明 |
|---|---|
| 连接与生命周期 | `openStore()` / `Store.close()`；自动创建父目录；不自动执行迁移 |
| 连接不变量 | `journal_mode=WAL`、`foreign_keys=ON`、`secure_delete=ON`、`busy_timeout`；打开后**读回断言**，未生效即报错 |
| Migration | 目录加载、`NNNN_name.sql` 校验、版本唯一/升序、checksum 校验、逐文件事务执行 |
| 结构校验 | `verifySchema()` 对照 P1 六表六索引（含列顺序） |
| 迁移追踪 | `schema_migrations(version, name, checksum, applied_at)` |

## 2. 不负责什么

1. **不判断业务语义**：不决定事件是否该被注意、是否形成记忆、人格该做什么。
2. **不访问 Archive**：无连接、无密钥、无解密能力。
3. **不暴露裸句柄**：`DatabaseSync` 不出现在包入口，deep import 由 `exports` 阻断。
4. **不做进程级单实例锁**：那属于 Daemon（RUNTIME §9 第 4 步）。
5. **不保存正文**：P1 六表无任何正文字段。

## 3. 目录

```
packages/persistence/
├─ migrations/0001_init_core.sql   # P1 六表 + 六索引
├─ src/
│  ├─ index.ts                     # 唯一公共入口
│  ├─ errors.ts                    # PersistenceError + 受控错误码
│  ├─ db/{open-store,store,pragmas}.ts
│  └─ migrations/{types,expected-schema,load,migrator}.ts
└─ test/                           # 真实 SQLite 文件 + 真实迁移执行路径
```

## 4. 公开接口

```ts
openStore({ file, busyTimeoutMs? }): Store
store.close(): void
store.isClosed: boolean

migrate(store, { dir?, migrations? }): { applied, alreadyApplied, currentVersion }
verifySchema(store): void

loadMigrationsFromDir(dir): readonly MigrationFile[]
checksumOfSql(sql): string
normalizeSqlText(sql): string
P1_TABLE_COLUMNS / P1_INDEXES
PersistenceError / PERSISTENCE_ERROR_CODES / isPersistenceError
```

依赖方向：`persistence → contracts`（批次 B 引入类型依赖）。**当前无第三方运行时依赖**。

## 5. Migration 机制

1. 文件命名 `NNNN_<snake_desc>.sql`，版本 1–9999，**重复版本直接报错**。
2. checksum = 归一化（CRLF/CR → LF）后内容的 SHA-256；CRLF 检出不会造成假不匹配。
3. 已应用迁移先**校验** checksum，不匹配即 `migration_checksum_mismatch`，**不执行**任何新迁移。
4. 待应用迁移逐个在 `BEGIN IMMEDIATE … COMMIT` 内执行；任何异常 `ROLLBACK`，
   不留半成品表、不留记账行（`migration_failed`）。
5. 若数据库里的版本在源码树中缺失 → `migration_not_found`；
   若待应用迁移版本小于已应用最大版本 → `migration_out_of_order`。
6. 允许版本不连续（`0001`, `0003`），按版本升序执行。

### 回滚说明

- 已应用的迁移**永不回滚**（DATA-MODEL §8.3）；修正靠新增迁移。
- `0001_init_core.sql` 的文件头写明测试环境的 DROP 顺序：
  `events → tasks → runtime_state → sessions → personas → schema_migrations`。
- 破坏性变更遵循"先停用 → 确认无引用 → 再删除"两步法。

## 6. 已知限制（批次 A）

1. 事务/Repository/字段映射/检查点尚未实现（批次 B/C）。
2. `verifySchema()` 只覆盖 P1 六表；新增迁移必须同步更新 `expected-schema.ts`，否则会报警。
3. 单写入者目前只保证"单连接 + 迁移串行"；通用 `withWrite` 在批次 B 落地。
4. 进程级单实例锁、WAL checkpoint on close 属 Daemon。
