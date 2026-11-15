# LEGACY-BASELINE — 旧插件冻结基线

> SH-001 交付物 · 冻结日期 2026-11-15 · 记录人：小鱼（DeepSeek 侧）
> 本文件只描述**冻结时的事实**，不含新内核设计。设计与协议见 `docs/architecture/`。

---

## 1. 冻结声明

| 项 | 值 |
|---|---|
| 旧仓库 | `F:\6\dsh-agent-dfy\dsh-soul-core` |
| remote | `https://github.com/wblnn/dsh-soul-core.git` |
| 分支 | `main` |
| HEAD | `9275c390d2d0b26ff130a8c7bca293df2c01dedd` |
| 提交标题 | `feat(qq): 切换协议端工具名 napcat_*；旧虚拟屏全禁保留` |
| 冻结 tag | `legacy-plugin-frozen-2026-11-15`（annotated，本地） |
| tag 是否已推送远端 | **否** |
| 冻结时工作区 | 干净（`git status --porcelain` 输出 0 行） |

**冻结规则**

1. 旧仓库此后只接受两类改动：安全补丁、以及作为 DSH Adapter 的最小桥接修复。
   认知内核、记忆图、睡眠、梦境相关开发一律不得进入该仓库。
2. 冻结 tag 指向的提交是**迁移对照的基准**。新内核任何行为差异都必须能回溯到这条基线。
3. 旧仓库的 `main` 不得被 force-push、rebase 或改写历史。

> 若需把 tag 推到远端用于备份：`git push origin legacy-plugin-frozen-2026-11-15`。本次未执行。

---

## 2. 仓库形态

- 包名 `dsh-soul-core`，版本 `0.1.0`，`"type": "module"`（纯 ESM）。
- 入口 `lib/index.js`；exports 另有 `./client`。
- **零外部运行时依赖**：`package.json` 无 `dependencies` / `devDependencies` 段。
  全部能力走 Node 标准库：`node:sqlite`（记忆库）、`node:zlib`（session 日志解压）、`node:net`（MC 控制层）。
- **无构建步骤**：没有 tsc / bundler，`node --check` 即语法校验。
- `engines.node` 声明 `>=22`；本地实际运行 24.x。
- 分发方式为 DSH 插件：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`。

---

## 3. 代码规模

| 区域 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| `lib/` | 24 | 7607 | 运行时全部逻辑 |
| `bin/` | 3 | — | `mem.mjs` / `prefetch.mjs` / `seed-mc-skills.mjs` |
| `test/` | 30 | 3660 | 纯 `node test/*.mjs`，无测试框架 |
| `install.mjs` | 1 | — | 向 DSH profile 安装 preset 块 |
| `cordis.patch.yml` | 1 | 12408 B | 6 个 preset 定义 |

**行数集中度**（重构风险点）：

| 文件 | 行数 | 占比 |
|---|---|---|
| `lib/index.js` | 2515 | 33% |
| `lib/memory-store.js` | 1142 | 15% |
| `lib/persona-api.js` | 556 | 7% |
| 其余 21 个文件 | 3394 | 45% |

两个文件承担了近一半逻辑，且都直接耦合 DSH 生命周期或表结构 —— 这是"新内核从空目录起"的主要理由。

---

## 4. 数据现状

**数据根目录：`F:\Users\Administrator\.dsh\soul`**（由插件配置决定，日志可查）

```
F:\Users\Administrator\.dsh\soul\
  IDENTITY.md  SOUL.md  USER.md  MEMORY.md  MEMORY.mc.md  RULES.md
  people.json  ingest-deny.json  soul-core.log
  memory\      7 个日期文件（按天追加的主观记忆）
  diary\       5 个日期文件
  journal\     空
  skills\mc\   30 个技能文件
  memory-tree\ memory.db + memory.db-wal + memory.db-shm
```

规模：54 个文件，10.16 MB（其中记忆库占 9.5 MB）。

### 4.1 记忆库

`memory-tree\memory.db` —— SQLite，`journal_mode=wal`，**`user_version=0`（无迁移追踪机制）**。

冻结时行数：

| 表 | 行数 | 备注 |
|---|---|---|
| events | 13611 | 事件索引行，**不存正文** |
| frames | 7850 | 帧级偏移索引（offset,length） |
| messages | 3178 | 消息索引 |
| links | 2025 | 关联表（五边上限 + 两跳扩散的旧算法产物） |
| sessions | 25 | 会话 |
| episodes | 66 | 事件骨架（带 seq 锚点） |
| episode_notes | 1 | 骨架摘要 |
| dream_notes | 4 | 梦境笔记 |
| dream_runs | 258 | 做梦运行记录 |
| world_events | 111 | 世界事件 |
| world_cursor | 6 | 世界游标 |
| note_usage | 1 | 笔记使用计数 |

> `dream_runs` 在两次采样间从 257 变成 258 —— **旧库仍在被写入**。
> 这就是备份必须走 SQLite online-backup API 而不是复制文件的原因。

### 4.2 ⚠ 存在第二个 soul 目录

`C:\Users\Administrator\.dsh\soul` 也存在，含 IDENTITY/SOUL/USER/MEMORY/RULES 五个 Markdown，
但 `memory\` 与 `journal\` 为空，**无 `memory-tree\`**。

判断：配置里实际生效的是 `F:\...` 那份（`soul-core.log` 记录 `root=F:\Users\Administrator\.dsh\soul`）。
C 盘那份是早期残留。

**迁移时只认 F 盘那份。** C 盘目录在迁移完成前不要删除，也不要读取。

---

## 5. 数据备份

| 项 | 值 |
|---|---|
| 路径 | `F:\6\Soul_Harness_2.0\_backup\legacy-soul-2026-11-15\` |
| 方式 | `node:sqlite` 的 `backup()` 在线备份（WAL 折入主库） |
| 文件数 | 53 |
| 大小 | 7.06 MB |
| 快照内 `memory.db` | 6.97 MB，`memory.db-wal` 为 0 字节 |
| 完整性 | `PRAGMA integrity_check` → `ok` |
| 行数校验 | events 13611 / frames 7850 / messages 3178 / links 2025 / episodes 66 / sessions 25 / dream_runs 258 / world_events 111 |

备份脚本保留在 `_scratch/backup-legacy-soul.mjs`，可复现。

> 备份目录**不得**进入新仓库的 git 索引（含个人主观记忆原文）。见 `.gitignore`。

---

## 6. DSH 耦合点（迁移必须解开的结）

`lib/index.js` 对宿主提供的服务做 `ctx.inject`：

| 宿主服务 | 位置 | 用途 | 新内核对应 |
|---|---|---|---|
| `systemPrompt` | index.js:276 | `sp.variable("soul_block", ...)` 注册提示词变量 | Adapter 侧渲染，内核不管 |
| `tools` | index.js:2850 | 注册 19 个工具 | 内核暴露 API，Adapter 转工具 |
| `webServer` | index.js:2542 | `/dsh-soul/api/*` 供 UI 取数 | Daemon 的本地 API |
| `llm` | index.js:1256 | 做梦时调模型 | Model Gateway |
| `agents` | index.js:1263 | 取 agent 句柄 | 无（内核不认识 DSH agent） |

**已定义的工具清单**（persona 模式实测挂载 6 个，其余按域/开关出现）：

- 自我：`soul_status` `soul_read` `soul_remember` `soul_journal` `soul_recall` `soul_update` `soul_digest` `soul_diary`
- 记忆：`memory_episodes` `memory_expand` `memory_annotate` `memory_search`
- 状态：`plan` `mood` `person_link`
- MC：`mc_chat_watch` `mc_chat_status`
- 技能：`skill_list` `skill_read` `skill_recall` `skill_learn`

**preset 清单**（`cordis.patch.yml`）：`soul`、`soul-test-chat`、`soul-qq`、`soul-test`、`soul-work`、`soul-mc`。
其中 `soul-work` / `soul-test*` 刻意不在 persona 白名单内，用于隔离写入。

---

## 7. 复用分类

### 7.1 可直接复用（逻辑与 DSH 无关，纯计算或纯文件）

| 模块 | 行数 | 说明 |
|---|---|---|
| `lib/similarity.js` | 179 | Dice 系数 + 池内 BM25 + 情感极性对齐，纯算法零依赖 |
| `lib/relevance.js` | 59 | 寒暄/空话门控，决定"要不要跑检索" |
| `lib/people.js` | 85 | 跨场景身份映射（people.json） |
| `lib/skills.js` | 249 | 技能以 Markdown 文件存储的读写层 |
| `lib/diary.js` | 83 | 日记生成 |
| `lib/mood.js` | 177 | 心情慢变量 |
| `lib/presence.js` | 71 | 处境（睡/忙/看不看视频） |
| `lib/plans.js` | 198 | 自我认下的计划表 |
| `lib/persona-api.js` | 556 | 作者已声明"纯函数层、零 DSH 依赖、零状态" |

### 7.2 只作参考（思路可搬，代码不可直接进内核）

| 模块 | 行数 | 原因 |
|---|---|---|
| `lib/session-source.js` | 296 | 解析 DSH 的 `session.v4.jsonl.zstd` 多帧追加格式，属 Adapter 职责 |
| `lib/dream.js` | 280 | 现有"做梦"是调模型生成带锚点摘要；新内核的梦境是沙箱体验，语义不同 |
| `lib/mc-*.js` / `world.js` | 192+174+88+45+172 | MC 领域经验，全部降级为 Adapter |
| `lib/gate.js` | 74 | 控制入口拦截，思路并入 pre-attention，不搬实现 |
| `lib/client.js` | 412 | DSH 浏览器端 UI（CJS factory），Studio 需重写 |
| `lib/memory-store.js` | 1142 | `node:sqlite` 零依赖封装思路可留，**表结构全部重design** |
| `lib/inject.js` | 67 | 注入预算策略（≤400 字符、6 小时去重）是可参考资料 |

### 7.3 必须移出新内核

| 项 | 原因 |
|---|---|
| `lib/index.js`（2515 行） | 进程全局变量 + 绑定 `soul_block` 唯一生命循环 |
| `lib/define-tool.js` | 为宿主 junction 解析失败自带的兜底 defineTool |
| `cordis.patch.yml` | DSH preset 装配，内核不该知道宿主 |
| `install.mjs` | 向 DSH profile 安装配置块 |
| `_wire-presence-a.mjs` | 一次性临时脚本，已提交进仓库 |
| `links.js` 的五边上限与两跳扩散 | 计划书明确废弃：无上限、无固定跳数，改数值激活 |
| `templates/*.md` | 由数据库投影取代，不再作为人格源文件 |

### 7.4 待确认

1. `MEMORY.mc.md` 这类**域记忆**在 2.0 里的归属：仍作为投影，还是彻底进入主观记忆图？
2. `ingest-deny.json`（禁入规则）保留为配置还是进入注意力层策略？
3. `people.json` 的关系数据是并入记忆图（Person 节点），还是独立关系表？
4. `soul-core.log`（959 KB）是否属于需要封存的档案？

---

## 8. 与计划书基线的差异

计划书核对基线写的是 `main@9275c390`，实测一致，无需修正。

唯一需要记录的是 **Node 版本**：计划书要求 26.x，本机只有 24.14.1（PATH）与 24.21.0（DSH 内置）。
经决定，新项目基线改为**本机可用的 Node 24 LTS**。

---

## 9. 未决问题

- [ ] 冻结 tag 是否推送到远端（备份用）
- [ ] C 盘那份残留 soul 目录，迁移完成后如何处理
- [ ] 旧库 `user_version=0`，迁移器需自行判断源 schema，不能依赖版本号
- [ ] `dream_runs` 258 行的语义（每次睡眠一行？每次调模型一行？）需读代码确认后才能写迁移映射
