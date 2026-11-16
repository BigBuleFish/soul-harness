# AI-DEVELOPMENT-RULES — 双 AI 协作与工程规范

- **地位**：强制。任何 AI 在本仓库的产出都必须满足本文件；与本文件冲突的实现一律驳回。
- **适用范围**：DeepSeek 侧与 GPT 侧的两位 AI、以及人类维护者。

---

## 1. 开工前必读（顺序不能跳）

1. `docs/adr/` — 所有已接受的架构决策
2. `docs/architecture/OVERVIEW.md` — 系统是什么
3. `docs/architecture/TRUST-BOUNDARIES.md` — 什么绝对不能做
4. `docs/architecture/DATA-MODEL.md` — 数据怎么存
5. `docs/architecture/RUNTIME-LIFECYCLE.md` — 状态怎么流转
6. `docs/architecture/MODULES.md` — 你的任务能碰哪里
7. `docs/architecture/IDENTITY-PROTOCOL.md` — 谁是谁（六类 ID 与去重身份）
8. 目标模块的 `README.md`

**没读完就写代码 = 违规。** 产出与文档冲突时，先停手提变更，不许"先写了再说"。

## 2. 十条禁止

1. 不允许擅自更换技术栈（Node 版本、语言、库、包管理器）。
2. 不允许擅自修改架构决议；变更必须新开 ADR 并被接受。
3. 不允许跨模块直接访问对方数据库/文件/内部符号。
4. 不允许跳过 Schema 校验（任何外部输入、模型输出都必须过 Schema）。
5. 不允许直接修改其他模块的内部实现来"顺手修好"。
6. 不允许未经授权的大范围重构。
7. 不允许用 Mock 结果冒充真实功能。
8. 不允许为通过测试而删除或放宽安全约束。
9. 不允许把未实现的功能描述成已完成。
10. 不允许在实现任务里顺手升级基础依赖或改工具链配置。

## 3. 锁定技术栈

| 层 | 选定 | 不得更换为 |
|---|---|---|
| 运行时 | **Node.js 24 LTS**，`>=24.15.0 <25`，精确版本以实测锁定 | 26.x 或更早；小版本升级需说明理由 |
| 语言 | TypeScript（strict） | 纯 JS、Rust |
| 包管理 | pnpm | npm、yarn |
| 构建 | Turborepo | nx、自研脚本 |
| HTTP | Fastify | express、koa |
| 实时 | WebSocket | SSE、轮询 |
| 存储 | SQLite（`node:sqlite`）+ WAL | Postgres、Neo4j、Redis |
| ORM | **无**（薄仓储层；禁止 Drizzle/Prisma） | 任何 ORM |
| 校验 | JSON Schema | zod 以外的自研校验（zod 可用于 TS 层，Schema 必须同时存在） |
| 测试 | Vitest | jest、mocha |
| 前端 | React + Vite + Tailwind + shadcn/ui + Zustand | 其他框架 |
| 文档语言 | 中文 | — |
| 代码注释 | **英文** | 中文注释 |

升级任何一项都要 ADR。版本锁定在 lockfile 与 CI 中。

## 4. 任务交接格式

每个任务必须带齐以下字段，缺项就是任务描述不合格，AI 有权先问而不动手：

```
任务编号: SH-0NN
任务目标: （一句话，可验收）
允许修改: apps/... packages/... docs/...
禁止修改: （明确列出）
依赖接口: （哪些 contracts 类型/函数，需已存在或本任务一并定义）
输入/输出: （函数签名或 API 形状）
必须通过的测试: （测试文件路径或断言）
验收标准: （可观察的行为）
最终变更摘要: （完成后回填）
```

**一次只给一个明确范围。** AI 不得自行扩大范围去"顺便整理"。

## 5. 分支与合并

| 分支 | 用途 |
|---|---|
| `main` | 稳定主干，始终可构建、可测试 |
| `feature/<slug>` | 单项功能 |
| `fix/<slug>` | 问题修复 |
| `architecture/<slug>` | 架构或契约变更 |

规则：

1. 两个 AI **不得同时**改同一批核心文件。
2. 涉及 **共享核心**（见 §6）的改动：先定方案 → 由一个 AI 实现 → 另一个 AI 审查 → 才合并。
3. 所有改动经 PR 或等效审查后进 `main`。禁止直接 push 到 `main`。
4. 主干保护开启：CI 不通过不得合并。

## 6. 共享核心文件（改之前必须先说）

- `packages/contracts/**`（所有协议类型与 Schema）
- `packages/persistence/migrations/**`（数据库迁移）
- `packages/runtime/**`（提交器与生命周期）
- `docs/architecture/**`、`docs/adr/**`
- 根 `package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、CI 配置

改这些文件时，PR 描述必须写：影响面、回滚方式、是否需要迁移、是否影响另一个 AI 的在研任务。

## 7. 代码规范

- TypeScript `strict: true`；禁止 `any`（`unknown` + 类型收窄代替）；禁止 `@ts-ignore`（用 `@ts-expect-error` 并附原因）。
- 线协议字段 camelCase，DB 列 snake_case；**转换只在 `packages/persistence` 做**，其他模块不得自行转字段名。
- 状态、通道、关系、节点类型用**枚举常量**，禁止散落字符串字面量。
- 所有时间用 Unix 毫秒整数；禁止在包里格式化给人看的时间。
- 注释写**英文**，说明"为什么"而不是"做了什么"。文件头写清该文件的核心约束。
- 禁止 `console.log` 作为日志（用结构化 logger，禁明文私人内容）。
- 提交信息格式：`<type>(<scope>): <中文简述>`，type ∈ `feat|fix|docs|refactor|test|chore|perf|security`。

## 8. 测试要求

| 改动类型 | 最低要求 |
|---|---|
| 纯函数/算法 | 单元测试，含边界与退化输入 |
| 涉及权威状态写入 | 单元 + 集成测试（真实 SQLite，不用 mock） |
| 涉及边界（§TRUST-BOUNDARIES 四条红线） | 安全测试，且必须能在旧实现上失败 |
| 涉及迁移 | 空库重放 + 旧库升级 + 回滚说明 |
| 涉及外部动作 | 幂等重放测试（重复执行次数 = 0） |
| 涉及遗忘 | 金丝雀恢复测试（所有认知接口命中 = 0） |

**"能跑通"不算验收。** 涉及 P0 风险的改动，必须证明约束仍成立。

## 9. 状态诚实

- 文档里写"已实现"必须附测试路径与实际运行结果。
- 写"设计中""未实现"不丢人，谎报才是严重问题。
- 目录存在、类型定义存在、Schema 存在，都**不代表**功能完成。
- 交付报告必须明说：本次是否修改了运行时行为。

## 10. 遇到冲突怎么办

```
发现实现与架构冲突
  → 停手
  → 写 ADR 草案（Context / Decision / Consequences / 被否决的备选）
  → 说明影响面与迁移成本
  → 等接受
  → 才写代码
```

**不允许**在 PR 里偷偷改架构然后声称"与文档一致"。

## 11. 任务完成的标准（Definition of Done）

- [ ] 代码符合 §7
- [ ] 有 §8 要求的测试，且本地通过
- [ ] 涉及的 `README.md` 状态已更新
- [ ] 涉及的架构文档已同步（或在 PR 里说明为何无需同步）
- [ ] 无新增 P0 边界风险；若有，附自检清单（TRUST-BOUNDARIES §10）
- [ ] 变更摘要已回填到任务单
- [ ] 明确说明：是否改变了运行时行为、是否需要迁移、如何回滚

## 12. 交付报告模板

```
1. 做了什么（文件清单 + 一句话各自作用）
2. 现在什么状态（哪些能跑、哪些只是文档）
3. 测试情况（跑了什么、结果如何）
4. 是否修改运行时代码（是/否）
5. 是否涉及边界与安全（是/否，哪些）
6. 未解决的问题
7. 下一步建议
```
