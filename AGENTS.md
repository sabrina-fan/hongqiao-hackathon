# NextStop 协作约定

开始前说明目标、最小改动范围和验收条件，保留用户已有改动。先从下表找到入口，再沿调用方和测试读取。当前能力以实现和 [README](./README.md#目录与边界) 为准，产品范围与验收标准见 [PRD](./PRD.md)。

## 按任务找入口

| 任务 | 先读 | 怎样验证 |
| --- | --- | --- |
| 首页连接、断线与重试 | [页面](./apps/web/src/App.tsx)、[健康 API](./apps/server/src/app.ts)、[共享契约](./packages/core/src/contracts.ts) | [HTTP 集成测试](./apps/server/src/app.integration.test.ts)、[移动端验收](./e2e/run-ego.mjs) |
| 雷达提案、展示与接受 | [页面](./apps/web/src/RadarPanel.tsx)、[应用用例](./apps/server/src/radar/store.ts)、[高德证据](./apps/server/src/radar/amap.ts)、[绑定规则](./packages/core/src/proposal-binding.ts) | [HTTP 与 SQLite 联验](./apps/server/src/radar-http.integration.test.ts)、[事务测试](./apps/server/src/radar/store.integration.test.ts)、[业务切片验收](./README.md#雷达确认验收) |
| 模型传输与响应 | [任务路由](./packages/model-gateway/src/task-catalog.ts)、[Jev 客户端](./packages/model-gateway/src/jev.ts)、[失败与重试规则](./ENGINEERING_工程化基线与Skill分工.md#实现与错误处理) | 协议探针、mock 测试、真实质量评测分别报告。见[传输测试](./packages/model-gateway/src/jev.test.ts)。 |
| 功能开发、TS/TSX、重构或审查 | 按 [pstack 流程与 Skill 分工](./ENGINEERING_工程化基线与Skill分工.md#4-skill-分工)选取并读取当前阶段的 Skill | [已生效的工程检查](./ENGINEERING_工程化基线与Skill分工.md#32-规则与执行入口)与[验收命令](./README.md#检查与测试) |

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `apps/web` | 工作区内只依赖 `core` 的公开契约。页面和客户端状态通过 HTTP/SSE 使用服务端能力。 |
| `apps/server` | 依赖 `core` 和 `model-gateway`。HTTP 层解析和映射响应，应用用例编排业务。durable 与 SQLite 操作集中在 runtime、存储适配和集成测试。 |
| `packages/core` | 生产代码只依赖自身与 pi-schema。共享契约和纯函数通过参数接收时间、配置和数据，只读契约声明的字段，禁止 I/O。 |
| `packages/model-gateway` | 封装任务级传输、provider SDK、响应解析与调用预算，不依赖 apps 或行程存储。业务降级和行程写入由服务端用例决定。 |

跨包只用公开导出，保持依赖单向。仅服务端使用的规则随业务模块维护。外部输入按 `unknown` 在入口解析，类型从 pi-schema 推导，内部沿用已验证的类型。新增模块和依赖须服务于当前调用方。

## 业务不变量

- 模型只提议候选 ID 和定性理由。POI、时长、价格、证据、归属和版本由可信能力或服务端提供。区分 `estimated`、`unknown`、`stale` 和 `verified`。
- 确认可行集为空才返回 `kind: empty`。模型或地图调用失败保留错误。`unknown` 和“需要用户确认”都是有效结果。
- 展示、缓存和接受只使用当前 session 已校验的提案。`checkProposalBinding` 只核对 session、提案、候选池、ETA 和行程的绑定与修订。应用端还须校验候选与业务约束，只有应用端可以写入 `validated`。
- 行程只由应用端在用户确认后写入。在同一事务中完成幂等检查、当前版本与约束复核、行程写入。每用户一个 SQLite 文件，同一文件只有一个写者，runtime 负责释放资源。
- 服务端密钥不得进入客户端产物、日志或测试 fixture。`.env.example` 仅用占位值，并纳入扫描。

## 验证与授权

- 命令、Node 与 pnpm 版本以根 [package.json](./package.json) 为准。先跑受影响的检查，只格式化本轮文件。UI 改动按影响用 `pnpm test:e2e` 验收，检查本次报告与截图。
- 新增测试须确认实际执行。保留密钥与依赖检查。普通 PR 使用本地测试和 mock，真实付费调用、提交、推送、对外评论、合并和部署按当前任务授权执行。
- 子代理仅经本机 Herdr，派发、审查模型和完成凭据遵循上级 `AGENTS.md`。审查最终差异，修正后复验；仅能自查时注明。交付说明行为变化、实际检查结果与剩余限制。
