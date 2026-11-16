-- 0001_init_core.sql — P1 核心六表（docs/architecture/DATA-MODEL.md §3）
--
-- Scope: personas / sessions / events / tasks / runtime_state / schema_migrations.
-- No memory tables, no archive tables: P1 has no physical isolation and the
-- Archive Writer has not reached its enablement threshold (PLAN §6.2).
--
-- Rollback: DROP the six tables in reverse dependency order
--   (events → tasks → runtime_state → sessions → personas → schema_migrations).
-- Rollback is only legitimate on an empty/test database. In production an
-- applied migration is never reverted; mistakes are corrected by a new
-- migration (DATA-MODEL §8.3).

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
  external_id TEXT,                        -- 适配器侧会话引用 externalSessionRef；不透明，不参与权限判断
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  meta_json   TEXT
);
CREATE INDEX ix_sessions_persona ON sessions (persona_id, opened_at DESC);
-- 会话映射以人格为作用域：同一适配器同一外部会话在不同人格下是不同会话。
-- 谓词含 closed_at IS NULL：只约束"当前有效"的映射 —— 旧会话关闭后，同一
-- (persona_id, adapter_id, external_id) 允许再建新会话（重开 = 新 sessionId）。
CREATE UNIQUE INDEX ux_sessions_external
  ON sessions (persona_id, adapter_id, external_id)
  WHERE external_id IS NOT NULL AND closed_at IS NULL;

-- 事件（Reliable World 的观察记录）
-- 本表只存信封与非内容元数据；原始正文归 Archive（P1 不存在）。
CREATE TABLE events (
  id             TEXT PRIMARY KEY,         -- eventId
  persona_id     TEXT NOT NULL REFERENCES personas(id),
  session_id     TEXT REFERENCES sessions(id),
  source         TEXT NOT NULL,            -- minecraft.chat / dsh.chat / qq.group …
  adapter_id     TEXT NOT NULL,            -- 来源适配器；内部来源用 system.* 正式 ID
  adapter_event_ref TEXT NOT NULL          -- 适配器侧刺激标识；同一刺激重试必须复用
                 CHECK (length(adapter_event_ref) BETWEEN 1 AND 64),
  status         TEXT NOT NULL CHECK (status IN
                   ('received','accepted','noticed','understood',
                    'response_committed','acted','rejected','expired')),
  -- 注意判定结果，与 status 是两个不同维度（DATA-MODEL §3.2）
  attention_outcome TEXT CHECK (attention_outcome IN
                   ('not_evaluated','ignored','queued','partially_aware','fully_aware','forced_control')),
  salience       REAL NOT NULL DEFAULT 0,
  summary        TEXT,                     -- ⚠ 必须为 NULL 或仅含白名单非内容元数据（§3.1）
  archive_ref    TEXT,                     -- 不透明引用 token；P1 恒为 NULL
  received_at    INTEGER NOT NULL,
  occurred_at    INTEGER,
  updated_at     INTEGER NOT NULL,
  -- 归档判定：确定性策略产物，模型不得参与。Archive 能力关闭时（P1）为 NULL
  archive_disposition TEXT CHECK (archive_disposition IN ('required','excluded')),
  -- 归档状态：与 archive_ref 分离，支持"已归档但引用未提交"的崩溃恢复
  archive_state  TEXT NOT NULL DEFAULT 'none'
                 CHECK (archive_state IN ('none','pending','archived','failed','excluded')),
  -- 终态原因码：受控枚举，且必须与 status 配对（§3.4）
  status_reason  TEXT,
  CHECK (
    (status IN ('expired','rejected') AND status_reason IS NOT NULL)
    OR
    (status NOT IN ('expired','rejected') AND status_reason IS NULL)
  ),
  CHECK (
    status_reason IS NULL
    OR (status = 'expired' AND status_reason IN ('buffer_lost','ttl_expired','queue_overflow'))
    OR (status = 'rejected' AND status_reason IN
        ('auth_failed','untrusted_source','schema_invalid','rate_limited',
         'archive_unavailable','archive_conflict','processing_failed'))
  )
);
CREATE INDEX ix_events_persona_status ON events (persona_id, status, received_at);
CREATE INDEX ix_events_session ON events (session_id, received_at);
-- 去重键：同一人格、同一适配器、同一来源、同一刺激 → 只映射一个 eventId
CREATE UNIQUE INDEX ux_events_dedupe
  ON events (persona_id, adapter_id, source, adapter_event_ref);

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
-- IF NOT EXISTS：迁移器会在执行任何迁移之前自举这张表，这里保留同一份 DDL
-- 以便空库仅凭本文件也能得到完整结构（DATA-MODEL §8.2 要求迁移可重放）。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
