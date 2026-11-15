# DATA-MODEL — 数据模型与存储规则

- **地位**：数据库 schema 与迁移规则的权威描述。任何表结构变更必须先改本文件，再写 migration。
- **状态**：设计中。以下 DDL 为**逻辑草案**，未在任何数据库执行过。
- **上位决策**：`ADR-001`（SQLite WAL / 单写入 / 首期单库 / 不用 Drizzle）

---

## 1. 命名与字段规则

| 层 | 风格 | 例 |
|---|---|---|
| 线协议（HTTP / WS / JSON Schema / TS 接口） | **camelCase** | `personaId` `receivedAt` |
| 数据库列名 | **snake_case** | `persona_id` `received_at` |
| 表名 | snake_case，复数 | `memory_nodes` |
| 索引 | `ix_<表>_<列…>` | `ix_nodes_persona_lifecycle` |
| 迁移文件 | `NNNN_<snake_desc>.sql` | `0001_init_core.sql` |

**camelCase ↔ snake_case 的映射由 `packages/contracts` 的映射层统一完成，禁止各模块自己转换。**
转换规则固定为纯机械转换（`personaId` ⇄ `persona_id`），不做任何特例，以便推断与测试。

时间字段一律 **Unix 毫秒整数**（`INTEGER`），不用字符串时间戳。需要人读时在边缘层格式化。
布尔字段用 `INTEGER` 0/1，不用 SQLite 的松散类型。
结构化内容用 `TEXT` 存 JSON，且必须带 `schema` 字段标识版本。

## 2. 权威关系

```
SQLite（权威）
   ↕ 导入校验（单向：文件 → 库）
Markdown 投影（SOUL.md / IDENTITY.md / MEMORY.md …）
```

- 数据库是**唯一权威**。Markdown 是版本化投影，供人直接编辑。
- 外部编辑 Markdown 后**必须**经 Schema、版本、权限校验后导入；校验失败则整体拒绝，不部分导入。
- **禁止双主写入。** 不允许"文件改了也算真"。
- 人格可自行改写的内容（自我叙事、偏好、关系）与**永不允许人格改写**的内容（密钥、授权策略、归档保留策略）必须分开存放，后者不进入任何可写投影。

## 3. 首期表（P1，只实现这 6 张）

> 首期目标是"可靠的认知运行时容器"，不是记忆系统。**不要**提前建记忆表。

```sql
-- 人格身份与生命周期
CREATE TABLE personas (
  id            TEXT PRIMARY KEY,          -- personaId
  display_name  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('CREATED','STARTING','RUNNING','SUSPENDED','STOPPING','STOPPED','FAILED')),
  version       INTEGER NOT NULL DEFAULT 0, -- 状态版本，每次提交 +1
  epoch         INTEGER NOT NULL DEFAULT 1, -- 内容纪元，遗忘时 +1，只增不减
  boot_id       TEXT,                       -- 最近一次持有它的进程实例
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 外部交互会话（适配器提供，不代表人格身份）
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- sessionId
  persona_id  TEXT NOT NULL REFERENCES personas(id),
  adapter_id  TEXT NOT NULL,               -- dsh / minecraft / qq / cli
  external_id TEXT,                        -- 适配器侧原始会话标识
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  meta_json   TEXT
);
CREATE INDEX ix_sessions_persona ON sessions (persona_id, opened_at DESC);

-- 事件（Reliable World 的观察记录）
-- 注意：本表只存信封与受限摘要，原始正文归 Archive，通过 archive_ref 指向。
CREATE TABLE events (
  id             TEXT PRIMARY KEY,         -- eventId
  persona_id     TEXT NOT NULL REFERENCES personas(id),
  session_id     TEXT REFERENCES sessions(id),
  source         TEXT NOT NULL,            -- minecraft.chat / dsh.chat / qq.group …
  status         TEXT NOT NULL CHECK (status IN
                   ('received','accepted','noticed','understood',
                    'response_committed','acted','rejected','expired')),
  salience       REAL NOT NULL DEFAULT 0,
  summary        TEXT,                     -- 受限摘要，非原文
  archive_ref    TEXT,                     -- 指向 Sealed Archive 的不透明引用
  received_at    INTEGER NOT NULL,
  occurred_at    INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX ix_events_persona_status ON events (persona_id, status, received_at);
CREATE INDEX ix_events_session ON events (session_id, received_at);

-- 任务（调度与睡眠周期共用）
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  persona_id    TEXT NOT NULL REFERENCES personas(id),
  kind          TEXT NOT NULL,             -- stimulus.encode / thought.run / sleep.cycle / dream.segment …
  channel       TEXT NOT NULL CHECK (channel IN ('external','inner','sleep','dream','audit')),
  state         TEXT NOT NULL CHECK (state IN ('queued','running','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT,                      -- 执行它的模型调用/作业
  payload_json  TEXT,
  scheduled_at  INTEGER,
  started_at    INTEGER,
  finished_at   INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_tasks_persona_state ON tasks (persona_id, state, scheduled_at);

-- 运行时状态（恢复用；不含主观正文）
CREATE TABLE runtime_state (
  persona_id     TEXT PRIMARY KEY REFERENCES personas(id),
  state          TEXT NOT NULL,            -- 见 RUNTIME-LIFECYCLE.md
  boot_id        TEXT,
  epoch          INTEGER NOT NULL,
  checkpoint_json TEXT,                    -- 合法检查点：调度游标、队列快照引用
  updated_at     INTEGER NOT NULL
);

-- 迁移追踪
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
```

**关键取舍：`events` 不存正文。** 原始文本进 Archive，本表只留信封 + 受限摘要 + 不透明引用。
理由：正文一旦在 Reliable World 留一份，就会出现"第二份真相"，遗忘、审计与隐私全部失效。

## 4. 二期表（P3–P5：记忆网络与思维）

```sql
CREATE TABLE memory_nodes (
  id                    TEXT PRIMARY KEY,
  persona_id            TEXT NOT NULL REFERENCES personas(id),
  kind                  TEXT NOT NULL,       -- 开放注册表：Experience/Person/Concept/Emotion/…
  payload_enc           BLOB,                -- 主观正文，按密钥加密
  key_id                TEXT,                -- 内容密钥标识；遗忘时销毁
  vividness             REAL NOT NULL,
  accessibility         REAL NOT NULL,
  stability             REAL NOT NULL,
  salience              REAL NOT NULL,
  subjective_confidence REAL NOT NULL,
  source_impression     TEXT,                -- 主观来源印象（可退化）
  source_group          TEXT,                -- 系统侧来源分组，用于"独立证据"判定
  causal_root_id        TEXT,                -- 同源溯源：同一句话→自述→复述→梦境
  emotion_json          TEXT,
  subjective_time       TEXT,                -- 主观时间（人读，可能是错的）
  content_epoch         INTEGER NOT NULL,
  state_version         INTEGER NOT NULL,
  lifecycle             TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','FADING','ERASURE_PENDING','ERASED')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX ix_nodes_persona_lifecycle ON memory_nodes (persona_id, lifecycle, kind);

CREATE TABLE memory_fragments (           -- 片段级存储，供遗忘按片段精确删除
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES memory_nodes(id),
  ordinal     INTEGER NOT NULL,
  content_enc BLOB,
  key_id      TEXT
);

CREATE TABLE memory_edges (
  id                  TEXT PRIMARY KEY,
  persona_id          TEXT NOT NULL REFERENCES personas(id),
  src_id              TEXT NOT NULL REFERENCES memory_nodes(id),
  dst_id              TEXT NOT NULL REFERENCES memory_nodes(id),
  relation            TEXT NOT NULL,       -- Episodic/Semantic/Emotional/…（开放注册表）
  weight              REAL NOT NULL,
  gain                REAL NOT NULL,
  decay               REAL NOT NULL,
  directional         INTEGER NOT NULL DEFAULT 1,
  origin_group        TEXT,
  confidence          REAL NOT NULL DEFAULT 0.5,
  last_coactivated_at INTEGER,
  state_version       INTEGER NOT NULL
);
CREATE INDEX ix_edges_src ON memory_edges (persona_id, src_id);
CREATE INDEX ix_edges_dst ON memory_edges (persona_id, dst_id);
-- 不设"每节点最多 N 条边"的硬上限：靠局部质量、Hub 抑制与衰减回收控制规模。

CREATE TABLE activation_states (         -- 易失缓存，可重建，不是权威
  persona_id  TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  activation  REAL NOT NULL,
  updated_tick INTEGER NOT NULL,
  PRIMARY KEY (persona_id, node_id)
);

CREATE TABLE thought_threads (
  id                  TEXT PRIMARY KEY,    -- threadId
  persona_id          TEXT NOT NULL REFERENCES personas(id),
  channel             TEXT NOT NULL CHECK (channel IN ('external','inner','sleep','dream','audit')),
  trigger             TEXT,
  focus_ids_json      TEXT,
  unresolved_question TEXT,
  state               TEXT NOT NULL CHECK (state IN ('NEW','RUNNING','PAUSED','INTERRUPTED','COMPLETED','ABANDONED')),
  priority            INTEGER NOT NULL DEFAULT 0,
  epoch               INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_active_at      INTEGER NOT NULL
);
CREATE INDEX ix_threads_persona_state ON thought_threads (persona_id, state, priority DESC);

-- 词法索引：内容随主体一起删（见遗忘流程）
CREATE VIRTUAL TABLE memory_fts USING fts5(node_id UNINDEXED, body, tokenize = 'unicode61');
```

**节点类型与关系类型是开放注册表**，新增类型只需注册，不需要改表结构。

## 5. 三期表（P6–P8）

```sql
CREATE TABLE erasure_tombstones (        -- 不含原文的不可逆墓碑
  persona_id   TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  erase_epoch  INTEGER NOT NULL,
  erased_at    INTEGER NOT NULL,
  reason_code  TEXT,
  PRIMARY KEY (persona_id, node_id)
);

CREATE TABLE dream_sessions (
  id           TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL,
  sleep_task_id TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  outcome      TEXT CHECK (outcome IN ('COMPLETED','INTERRUPTED','AROUSED','REJECTED')),
  fragments_json TEXT                     -- 只留醒后选择保留的有限片段
);

CREATE TABLE action_records (             -- 幂等与回执
  action_id    TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  adapter_id   TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL CHECK (state IN ('requested','approved','executing','succeeded','failed','revoked','expired')),
  receipt_json TEXT,
  requested_at INTEGER NOT NULL,
  settled_at   INTEGER
);

CREATE TABLE archive_records (            -- 仅 Archive Writer 可写；Brain 无连接
  id          TEXT PRIMARY KEY,
  persona_id  TEXT,
  source      TEXT NOT NULL,
  raw_ref     TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  sha256      TEXT NOT NULL
);
```

## 6. 版本与纪元

三个独立版本各自维护，**不许合并成一个计数器**：

| 字段 | 作用 | 变化时机 |
|---|---|---|
| `state_version` | 乐观并发控制 | 每次成功提交 +1 |
| `epoch`（Persona） | 内容纪元 / 恢复下限 | 遗忘时 +1，只增不减 |
| `intent_version` | 场景/意图版本 | 意图变更时更新；过期意图不得执行动作 |

规则：

1. 任何写事务提交前校验 `base_version` 与当前一致，否则拒绝并要求重算。
2. 恢复时取 `max(epoch)`；旧检查点的 `epoch` 低于当前 → **不得**越过墓碑复活内容。
3. 迟到模型结果若 `base_epoch < 当前 epoch` → 直接丢弃，不合并。

## 7. 一致性协议

```
Read Snapshot（事务外，含 version/epoch）
    → Model Proposal（事务外，模型只提案）
    → Schema 校验
    → 权限校验（域 / persona / 字段）
    → 版本与 epoch 校验
    → 冲突合并或要求重算
    → 短事务 Commit（单写入者）
    → 派生索引刷新（FTS / 向量）
    → 广播（WebSocket）
```

写事务尽量短；不得在事务内调用模型、网络或文件 IO。
高频激活**不写盘**：活跃子图在内存迭代，批量快照。

## 8. 迁移规则

1. 每个变更 = 一个 migration 文件，带 `checksum`，记录到 `schema_migrations`。
2. migration 必须**幂等**、可在空库上重放、有对应的回滚说明。
3. **禁止修改已提交的 migration**；错误用新 migration 修正。
4. 破坏性变更（删列/删表）必须分两步：先停用，确认无引用后再删。
5. 表归属唯一：每张表只属于一个包（见 MODULES.md），跨包访问必须走该包接口。

## 9. 旧库 → 新库的映射提示

> 迁移是**一次性重编码**，不是导出导入。旧库 `user_version=0`，只能靠表结构探测判断版本。

| 旧表 | 去向 | 说明 |
|---|---|---|
| `sessions` | `sessions` | 需补 `adapter_id='dsh'` |
| `events` | `events` | 旧行无正文，天然符合新设计；`summary` 需重新生成 |
| `episodes` / `episode_notes` | `memory_nodes`（Experience） | 按锚点生成初始主观痕迹，**保留"旧系统摘要"来源标记** |
| `messages` | 不迁入主观记忆 | 原文属 Archive；是否导入由迁移授权窗口决定 |
| `links` | `memory_edges` | **权重不可直接沿用**；五边上限与两跳扩散的产物需要重算 |
| `dream_runs` / `dream_notes` | `dream_sessions` + 记忆节点 | 语义待确认（见 LEGACY-BASELINE 未决项） |
| `world_events` / `world_cursor` | `events`（source 加 `mc.world`） | 游标不迁移，新内核重新建立 |
| `frames` / `note_usage` | 不迁移 | 属旧索引与统计实现细节 |

**硬规则**：旧库中的"历史模型摘要"不得自动提升为真实经历，必须保留其 `source_impression = '旧系统推断'` 类标记。
