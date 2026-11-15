# Soul Harness 2.0

独立认知运行时。人格身份、主观记忆、思维进程与情绪状态由本系统自己持有，不依附任何聊天平台。

DSH / Minecraft / QQ / CLI 都是**可选适配器**；不安装它们，Daemon 也必须能独立运行。

> "自我""意识""睡眠""梦"是系统设计与行为模拟概念，不主张软件具备已被证实的人类意识。

---

## 当前状态

**P0：架构冻结与工程规范。** 代码一行未写。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | ADR、信任边界、数据模型、生命周期、协作规范 | 进行中（本批文档） |
| P1 | Monorepo 骨架、Daemon 生命周期、Persistence、最小 API | 未开始 |
| P2+ | 事件接入、记忆网络、激活、自主认知、遗忘、睡眠梦境、外部适配 | 未开始 |

目录和文档存在**不代表**功能完成。任何"已实现"必须以测试与验收记录为凭。

## 文档入口

| 文档 | 内容 |
|---|---|
| [ADR-001](docs/adr/ADR-001-independent-runtime.md) | 为什么取消插件形态，及锁定技术栈 |
| [OVERVIEW](docs/architecture/OVERVIEW.md) | 三层组件、分层拓扑、身份层级、端口 |
| [TRUST-BOUNDARIES](docs/architecture/TRUST-BOUNDARIES.md) | 三种权威域、四条红线、威胁模型 |
| [DATA-MODEL](docs/architecture/DATA-MODEL.md) | 表结构与迁移规则 |
| [RUNTIME-LIFECYCLE](docs/architecture/RUNTIME-LIFECYCLE.md) | Daemon / Persona / Thought / Event / Sleep 状态机 |
| [MODULES](docs/architecture/MODULES.md) | 模块职责与依赖方向 |
| [AI-DEVELOPMENT-RULES](docs/architecture/AI-DEVELOPMENT-RULES.md) | 双 AI 协作规范（动手前必读） |
| [LEGACY-BASELINE](docs/migration/LEGACY-BASELINE.md) | 旧插件冻结基线、数据现状、复用分类 |

## 旧系统

原 `dsh-soul-core` 插件已冻结：

- 仓库：`F:\6\dsh-agent-dfy\dsh-soul-core`
- tag：`legacy-plugin-frozen-2026-11-15`（指向 `9275c39`）
- 定位：迁移对照基准 + 未来的 DSH Adapter 源。**不再接受认知引擎开发。**

## 技术栈（锁定）

Node.js 24 LTS · TypeScript(strict) · pnpm · Turborepo · Fastify · WebSocket ·
SQLite（`node:sqlite`，WAL，单写入者）· JSON Schema · Vitest · React + Vite + Tailwind + shadcn/ui + Zustand

无 ORM。细节与变更流程见 [AI-DEVELOPMENT-RULES](docs/architecture/AI-DEVELOPMENT-RULES.md) §3。

## 已知限制（必须随发布一起声明）

1. **管理员保留的离线明文副本无法由软件消灭。** 真实遗忘只能保证本系统控制范围内的内容不可恢复
   （含库、派生索引、缓存、思维快照、检查点、备份密文）。备份策略与"诊断日志禁明文"属部署要求。
2. **模型仍可能自行推断出"这是梦"。** 梦境设计保证信息隔离与可观察行为，不宣称百分百消除内部推断。
3. **失败不可见时不允许声称成功。** 没有 `ActionReceipt` 就等于没发生。
4. 首期单机单人格为主；多人格并发隔离有测试要求，但非首期目标。
5. Node 24 与早期计划书中的 26.x 不一致，以本仓库锁定为准。

## 许可

见 [LICENSE](LICENSE)（继承自旧仓库，MIT）。
