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

**camelCase ↔ snake_case 的映射由 `packages/persistence` 统一完成，禁止各模块自己转换。**
`contracts` 只定义协议类型与 JSON Schema，**不知道**数据库列名。
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

### 2.1 P1 存储形态（与隔离边界）

- P1 使用**一个 SQLite 文件**，三域数据同库同进程，**不具备物理隔离**（见 `TRUST-BOUNDARIES.md` §5.1）。
- 逻辑隔离靠两点：**表归属唯一**（每张表只属于一个模块，见 `MODULES.md`）与**接口边界**（跨模块只能走公开接口）。
- 物理隔离（独立 Archive db 文件、独立权限、独立进程）的启用门槛见 `PLAN.md` §6.2。
  **在门槛达成前，`archive_records` 表不创建**：P1 允许正常接收事件，
  `events.archive_ref` 恒为 NULL、`archive_state = 'none'`，**系统不承诺原始事件审计能力**
  （见 §3.1 与 `RUNTIME-LIFECYCLE.md` §7.2）。

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
-- 注意：本表只存信封与非内容元数据；原始正文归 Archive（加密），通过 archive_ref 指向。
-- P1 无 Archive Writer，本表照样可用，archive_ref 恒为 NULL。
CREATE TABLE events (
  id             TEXT PRIMARY KEY,         -- eventId
  persona_id     TEXT NOT NULL REFERENCES personas(id),
  session_id     TEXT REFERENCES sessions(id),
  source         TEXT NOT NULL,            -- minecraft.chat / dsh.chat / qq.group …
  status         TEXT NOT NULL CHECK (status IN
                   ('received','accepted','noticed','understood',
                    'response_committed','acted','rejected','expired')),
  -- 注意判定结果，与 status 是两个不同维度（见 §3.2）
  attention_outcome TEXT CHECK (attention_outcome IN
                   ('not_evaluated','ignored','queued','partially_aware','fully_aware','forced_control')),
  salience       REAL NOT NULL DEFAULT 0,
  summary        TEXT,                     -- ⚠ 必须为 NULL 或仅含白名单非内容元数据（见 §3.1）
  archive_ref    TEXT,                     -- 不透明引用；P1 允许 NULL（无 Archive 时）
  received_at    INTEGER NOT NULL,
  occurred_at    INTEGER,
  updated_at     INTEGER NOT NULL,
  -- 归档状态：与 archive_ref 分离，支持"已归档但引用未提交"的崩溃恢复
  archive_state  TEXT NOT NULL DEFAULT 'none'
                 CHECK (archive_state IN ('none','pending','archived','failed'))
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

**关键取舍：`events` 不存正文。** 本表只留信封 + 非内容元数据 + 不透明引用。
理由：正文一旦在 Reliable World 留一份，就会出现"第二份真相"，遗忘、审计与隐私全部失效。

### 3.1 原文旁路禁令（各字段的具体约束）

原始正文只允许存在于**短暂感知缓冲**（TTL）以及其后**编码出的主观记忆密文片段**。
以下位置**一律不得**成为永久原文储存的旁路：

| 位置 | 允许存什么 | 明确禁止 |
|---|---|---|
| `events.summary` | **必须为 NULL**，或**仅含下表白名单中的非内容元数据** | 任何自然语言摘要、原始消息全文、原文拼接、可还原原文的编码、情感描述、主题概括 |
| `events.archive_ref` | 不透明引用（ID 或哈希），**不是路径**；**P1 允许 NULL** | 文件路径、可直接读取的 URI、SQL 片段、密钥材料 |
| `events.archive_state` | 枚举 `none/pending/archived/failed` | 任何原文或可推断原文的附加信息 |
| `tasks.payload_json` | **只放引用**：`eventId` / `nodeId` / `threadId` / 参数枚举 | 任何原文、上下文正文、模型输入原文 |
| `runtime_state.checkpoint_json` | 游标、队列位置、版本号、活跃 ID 列表 | 任何正文、对话片段、思维内容 |
| 日志 / 遥测 | 计数、耗时、错误码、ID | 默认不记录原文；确需时须脱敏并显式开关 |
| `sessions.meta_json` | 适配器侧标识与配置 | 会话消息内容 |

**`events.summary` 白名单（严格穷举，不得扩展而不改本文件）**

只允许以下非内容元数据：

- 字符长度 / 字节数 / token 估算；
- 语言标识（如 `zh`、`en`）；
- 消息类型枚举（`text` / `image` / `sticker` / `voice` / `command`）；
- 是否被点名的布尔标记；
- 来源渠道名与协议版本；
- 内容哈希（用于去重，不可逆）。

**禁止**：任何"把内容说一遍"的字段——包括自然语言摘要、关键词列表、情感标签、主题命名。
若在 P2 阶段确实需要给人看的摘要，该摘要属于**主观解释结果**，必须进入
`memory_nodes` 的加密正文，**不得**回填 `events.summary`。

**这条是硬约束。** 违反它会让整条遗忘链失效：删了主观记忆，原文还在 `events` 或检查点里躺着。

判据（可自动化）：注入带唯一标记的刺激后，遍历全部库表、索引、检查点与日志，标记串不得出现在上表"明确禁止"的列中。

### 3.2 `attentionOutcome` 与 `event.status` 是两件事

| 维度 | 含义 | 取值 | 谁负责 |
|---|---|---|---|
| `event.status` | 事件在**持久管线**中的阶段 | `received` / `accepted` / `noticed` / `understood` / `response_committed` / `acted` / `rejected` / `expired` | `runtime`（提交器） |
| `attentionOutcome` | 注意机制对这条刺激**单次判定**的结果 | `not_evaluated` / `ignored` / `queued` / `partially_aware` / `fully_aware` / `forced_control` | `attention` |

规则：

1. `ignored` / `queued` 是**注意结果**，不是事件终态。被忽略的事件其 `status` 仍可能是 `accepted`，
   直到队列超时或 TTL 到期才转 `expired`。
2. `forced_control` 必须导致 `status` 立即进入终态（`rejected` 或由控制路径直接处理），不受排队影响。
3. 同一事件可以被**多次**注意判定（例如先 `queued` 后 `fully_aware`），因此
   `attention_outcome` 记录**最近一次**判定；完整历史写入审计流，不进主观回忆。
4. 事件进入模型解释的前提是 `attentionOutcome ∈ {partially_aware, fully_aware, forced_control}`。
   **不得**让模型先读全文再表演"没注意到"。

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

-- 词法索引。⚠ 默认明文，可遗忘内容不得直接进入常驻索引（见下方 §4.1）
CREATE VIRTUAL TABLE memory_fts USING fts5(node_id UNINDEXED, body, tokenize = 'unicode61');
```

### 4.1 FTS 明文与真实遗忘的冲突（OPEN）

SQLite FTS5 的索引内容默认是**明文**，`node:sqlite` 无法对索引加密。
"删掉正文、留下索引"等于什么都没删——搜一次就能把已遗忘的内容捞回来。

三个候选方案，**P3 前必须定一个**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 分层索引 | 可遗忘内容**不进**常驻 FTS；检索时从解密正文临时构建内存索引，用完即弃 | 检索慢，内存占用高 |
| B. 只索引标签 | 索引里只放概念 ID / 主题标签，不放原文片段 | 丧失词法召回能力 |
| C. 接受约束 | 常驻 FTS 只服务"明确不允许遗忘"的内容（能力文档、技能） | 记忆检索全靠向量 + 图 |

当前默认倾向 **A**，但需 P3 基准测试后定案。**在定案前，禁止实现"常驻明文 FTS + 可遗忘内容"的组合。**

相关硬要求（详见 `TRUST-BOUNDARIES.md` §10）：

- `PRAGMA secure_delete = ON`，否则删行不从磁盘抹除。
- 遗忘事务结束必须 `PRAGMA wal_checkpoint(TRUNCATE)`。
- 删除后必须在库文件与 `-wal` 中搜索金丝雀，命中数须为 0。

**节点类型与关系类型是开放注册表**，新增类型只需注册，不需要改表结构。

### 4.2 主观正文加密审查清单（P3 / P5 必须逐项定案）

除已明确加密的列（`memory_nodes.payload_enc`、`memory_fragments.content_enc`、
`archive_records.content_enc`）外，以下列**可能承载主观正文或私人内容**，
在 P3（记忆）与 P5（认知）实现前必须逐项确认：加密 / 白名单限制 / 或改存引用。

**P3 必须审查（记忆层）**

| 列 | 风险 | 初判 |
|---|---|---|
| `memory_nodes.source_impression` | 主观来源印象，可能写成"我记得是他说的……" 这类带内容的叙述 | **加密**或限为枚举（`direct` / `heard` / `inferred` / `dream` / `unknown`） |
| `memory_nodes.emotion_json` | 情绪常附带具体事由描述 | 限为数值向量 + 枚举标签；**禁止**放自由文本 |
| `memory_nodes.subjective_time` | 主观时间可能夹带事件描述 | 限为结构化时间或模糊枚举（`today` / `recently` / `long_ago`） |
| `memory_edges.origin_group` | 来源分组标识 | 只放不透明 ID |

**P5 必须审查（认知层）**

| 列 | 风险 | 初判 |
|---|---|---|
| `thought_threads.trigger` | 触发描述常直接引用原话（"他问我……"） | **加密**或限为枚举 + 节点 ID |
| `thought_threads.unresolved_question` | 未解决问题本身就是一整句私人内容 | **加密** |
| `thought_threads.focus_ids_json` | 只放 ID | 无需加密，但禁止拼入内容 |
| `dream_sessions.fragments_json` | 醒后保留的梦境片段，本质是主观正文 | **加密**或改存为 `memory_nodes` 的 Dream 节点 |
| `action_records.receipt_json` | 回执可能回带请求参数原文 | 只保留状态码与外部动作 ID；原文由适配器侧负责 |

审查通过的结论必须回写本节。**未定案前，上述列不得以明文自由文本形式落盘。**

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

-- Archive：独立权限域、独立密钥、独立保留策略。
-- 该表属"记录域"，BRAIN 侧永不连接；只有 Archive Writer 进程可写。
-- 存档内容一律加密；此表只存元数据与密文引用。
CREATE TABLE archive_records (
  event_id     TEXT PRIMARY KEY,          -- 幂等键 = eventId：重复写入不产生第二条
  persona_id   TEXT,
  source       TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  occurred_at  INTEGER,
  content_enc  BLOB,                      -- 加密后的原始记录（不得明文）
  key_id       TEXT NOT NULL,             -- Archive 专属密钥标识（与主观记忆密钥不同域）
  content_sha256 TEXT NOT NULL,           -- 密文或明文的完整性校验（不可逆）
  byte_len     INTEGER NOT NULL,
  retention_class TEXT NOT NULL,          -- 保留策略分级；由管理员策略决定，不属人格可改
  created_at   INTEGER NOT NULL
);
CREATE INDEX ix_archive_persona ON archive_records (persona_id, received_at);
CREATE INDEX ix_archive_retention ON archive_records (retention_class, created_at);
```

**Archive 表的约束**

1. `event_id` 为主键，**天然幂等**：重复归档请求 `INSERT OR IGNORE` / 唯一冲突视为已存在。
2. `content_enc` **必须**是密文；`key_id` 属 Archive 密钥域，**不得**与 `memory_nodes.key_id` 混用或互相派生。
3. 本表**不得**被 Brain 侧连接。P1 阶段本表**不创建**（无 Archive Writer）。
4. 保留策略由 `retention_class` 表达，与主观记忆的 `lifecycle` / `epoch` / 墓碑**完全独立**：
   遗忘主观记忆**不会**删除 Archive；清理 Archive **不会**改写主观叙述。

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
