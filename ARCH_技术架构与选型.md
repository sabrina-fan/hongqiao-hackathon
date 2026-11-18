# NextStop 技术架构与选型

定稿日期：2026-11-15
评审修订：2026-11-16 —— 闸门移到应用端（proposal doc）、批量 ETA 方向更正、补齐导入/数据模型/API/进程模型/对象存储/删除/预约与停留时长数据源、延迟预算。修订记录见文末。
评审修订：2026-11-17 —— proposal/candidate_pool/eta_snapshot 改为按 radar session 键控的 doc family，验证证明绑定 session/proposal 修订/快照版本/trip 修订；提案结果改 `kind=empty|recommendations` 判别联合；删除分级（单 trip 引用清理 vs 全删用户关库清文件+客户端缓存）；提案轮次由运行时收窄工具面并拒绝混合批次；模型输入与存储输出 schema 分离；`compile().validate()` 更正；testdata 入库；Node 24 统一与 pnpm monorepo 脚手架。修订记录见文末。
适用 PRD：`NextStop_旅行机会雷达_完整PRD_V1.0_2026-11-15.md`

## 0. 文档地图与标记约定

| 文档 | 管什么 |
| --- | --- |
| **本文** | 架构、选型、分层、能力层、网关、契约、状态、闸门、安全、场景走查 |
| [SETUP_平台开通指南.md](./SETUP_平台开通指南.md) | 智谱 / 火山 / 高德账号开通、标准 Key 创建、环境变量、JS API 安全密钥代理、自检清单 |
| [VERIFY_待验证清单.md](./VERIFY_待验证清单.md) | 已查证事实（Pi 版本矩阵、智谱/火山结构化输出约束、模型套餐合规边界）+ 16 条待验项 V1–V16 与可执行探针 |
| [ENGINEERING_工程化基线与Skill分工.md](./ENGINEERING_工程化基线与Skill分工.md) | `pi-durable` 1.5.1/1.5.2/main 版本判定、`heirloom-lite` 工具链借鉴清单、测试矩阵、CI、Skill 分工 |

标记：

- ✅ **已查证** —— 一手来源（npm registry / GitHub API / 官方 README / 官方文档）核实过，可直接当约束用。
- 🔷 **设计决策** —— 我们的选择，不是关于外部世界的事实。可以被推翻，推翻时改这里。
- 🔴 **未验证** —— 指向 VERIFY 的具体编号。**不许在代码里当成已知事实。**

> **本文档的一条硬规则**：凡引用 Pi 的能力，必须标注它在 **1.5.2 已发布**还是**仅在 main 未发布**。
> 上一轮讨论曾把 main 的在途代码当成已发布，已更正，见 §4.2。同一个错不许再犯。

---

## 1. AI-first 的判据

### 1.1 判据本身 🔷

**「新增一个能力时，能否复用既有循环，由模型选择何时调用？」** 这是衡量扩展性的工程目标，不能单独作为架构正确性的二元判据。

具体到本项目：接入「查营业时间」「查人均消费」「查排队情况」等信息能力时，优先注册能力并复用循环。如果新增数据改变硬约束、输出契约或用户交互，应同步修改闸门、契约和前端。模型选择何时调用能力，应用端始终裁决是否允许展示与写入。

两个不许误读的地方：

- **判据管的是「新增能力」，不是「新增不变量」。** 新增一条硬约束（例如「接受前必须复核 ETA 新鲜度」）本来就该改闸门——闸门是不变量的家，为不变量更新闸门是正常演进，不构成 AI-added。「永不改闸门/控制流」不是判据，也不该当判据用。
- **固定编排不等于 AI-added。** `radar.evaluate` 把一串确定性步骤打包成一次能力调用压延迟（§5.7），编排顺序由代码固定是合理的工程取舍；判据约束的是「模型能决定调什么、什么时候调」，不要求每个原子步骤都各占一个模型回合。

这条判据是**可证伪的**，不是口号。验收方式见 §5.4。

### 1.2 三分离原则 🔷

> **确定性装在能力里，自主性装在循环里，不变量装在闸门里。**

| 放哪 | 装什么 | 为什么 |
| --- | --- | --- |
| **能力（Capability）** | 所有确定性计算：ETA、时间预算、可行性筛选、坐标转换、加权排序 | 这些有唯一正确答案，交给模型算就是引入随机错误 |
| **循环（Loop）** | 调哪个能力、什么顺序、要不要再查一次、怎么组合 | 这是真正需要判断力的部分，交给模型 |
| **闸门（Gate）** | 不变量的最终裁决：POI 白名单、绝不凑三个、理由里不许有数字、锁定项不可动 | 模型的输出是**提案**，不是**事实** |

### 1.3 模型权限边界 🔷

**模型可以 read / compute / propose，永远不能 commit 用户状态。**

- read：查灵感库、查行程、查历史、查 POI
- compute：调用确定性能力拿结果
- propose：产出最多三项的提案；仅通过窄工具写**本 radar session 键控**的中间快照与提案（`candidate_pool` / `eta_snapshot` / `proposal`，均为 key=session_id 的 doc family 成员）；**不能**写 `radar_session.validated` 等应用端字段。`rejections` 是带 session/trip 引用的用户级事件集合，由应用端处理用户反馈后写入。
- **用户状态 commit：写入行程、锁定行程项、触发导航 —— 一律由应用端在闸门通过后执行。**

这不是靠提示词约束，是靠**能力注册边界**约束：写入类能力只以应用端函数存在；即使注册成工具，也设 `callers: ["tools"]` 且不进 `modelTools` 白名单，**模型在协议层就看不到它们**。应用端直接调用能力函数，不受 `callers` 约束——`callers` / `modelTools` 只约束模型与嵌套工具。

提案的**校验落点同样不在模型侧**：`candidates.propose` 把提案写进 `nextstop.proposal` doc（作为一次 commit 的一部分），应用端读 doc 后跑纯函数闸门（§9.2）。**不把闸门放在 `onYield`**：1.5.2 的 `terminate` 轮不经过 `onYield`，而 `candidates.propose` 正是 terminate。

### 1.4 「导入形成雷达」的方向问题 🔷

PRD 的核心路径是线性的：

```
行前导入 → 统一确认 → AI 草拟行程 → 行中机会雷达 → 三选一 → 导航与反馈
```

**架构上的依赖方向是反的。** 雷达不是行程的下游产物：

```
灵感库（导入只是它的一个入口）
      +  硬约束（时间 / 路线 / 预订 / 预算）
      +  锁定行程项（行程只是锁定项的来源）
      +  candidate_pool 快照
      +  eta_snapshot 快照
              ↓
        雷达求解（持续可重算）
              ↓
          三选一提案
```

含义：
- **行程不是雷达的前置条件**。PRD 里 P-B「周末轻探索用户」明确要「无需建行程的雷达模式」，线性路径表达不了这个，反向依赖天然支持。
- **导入不是雷达的前置条件**。导入只是往灵感库写数据的一个入口；手工加一个 POI、上一轮拒绝理由，都是同等入口。
- **拒绝重排不需要重新调地图 API**。因为两个快照已经存在（§8.2），重排是纯计算。

依赖方向也决定了构建顺序：**先建能力层 + 闸门 + 雷达求解，导入是后接的入口**。（这是依赖关系，不是排期。）

**第一个端到端验证闭环**：已确认真实 POI（手工添加/策展数据提供，不依赖导入流水线）→ 雷达 → 应用端闸门校验 → 用户接受 → 应用端写入。这条闭环不含视觉抽取与 POI 匹配，先证明「雷达—闸门—写入」主干正确；**闭环跑通后再接导入链路**。全部 P0 保留，变的只是验证顺序（ENGINEERING §3.3 E2E 同序）。

---

## 2. 选型结论

### 2.1 技术栈总表 🔷

| 层 | 选型 | 版本 | 备注 |
| --- | --- | --- | --- |
| 语言 | **TypeScript** | — | 全栈同语言，契约共享 |
| Agent 运行时 | **`@earendil-works/pi-durable`** | **1.5.2 精确锁** | ✅ Experimental，见 §2.3 风险对策 |
| 文本/视觉模型访问 | `@earendil-works/pi-ai` | 1.5.2 | 随 durable 精确锁进来 |
| 有限选项决策访问 | 网关内原生 SystemOne HTTP 适配 | `jev-latest`（用户指定） | Jev 走独立协议，共用预算、校验、记账与 Langfuse 关联 |
| 对象运行时 | `@earendil-works/chord` | 1.5.2 | 随 durable；自带 HTTP / workers / web / terminal 客户端 |
| 契约与校验 | **`@earendil-works/pi-schema`** | 1.5.2 | **不用 Zod**，见 §7.1 |
| 遥测 | `@earendil-works/pi-telemetry` | 1.5.2 | 原生脱敏，见 §10.4 |
| 存储 | durable **内置** SQLite | — | 五种后端可选，见 §8.3 |
| 图片处理 | `@earendil-works/pi-durable/images/node`（Photon WASM） | 1.5.2 | worker 线程，不阻塞事件循环 |
| Web UI | **自己写**（React + Vite） | — | **不用 `pi-web-ui`**，见 §2.5 |
| HTTP | 脚手架用 `node:http`；业务接口设计优先使用 chord 自带 HTTP | — | 目前仅有 `/health/ready` 和 `/health/capabilities`。Hono 按需评估。 |
| 测试 | `fauxProvider()` + `registerStorageConformance()` + Vitest | — | 回放不烧钱；测试矩阵见 ENGINEERING §3.3 |
| Lint / 格式化 | **oxlint + oxfmt** | 1.83.0 / 0.68.0 | 从 `heirloom-lite` 借；不用 ESLint/Prettier |
| 浏览器 E2E | **ego-lite（`ego-browser` CLI）** | 本机已安装版本 | 桌面浏览器验收，连接本地真实 Web/API；见 ENGINEERING §3.3 |
| 模型观测与评测 | **Langfuse** | 复用已有服务，SDK 初始化时核对兼容并锁版 | 数据集、实验、规则/人工评分；第三方图片只本地评测，见 ENGINEERING §3.5 |
| 地图 | 高德 Web服务 REST + JS API | — | 见 §5.2、SETUP §3 |
| 模型 | GLM-5.3-Flash（视觉）+ Doubao 2.1 Lite（生成）+ Jev（有限选项决策） | Jev 用 `jev-latest` | 全部经网关；GLM/火山端点模式见 §6.1.1，Jev 中转见 §6.1.2 |

**明确不用**：AI SDK（任何 `ai` / `@ai-sdk/*` 包）、`pi-agent-core`、`pi-web-ui`、`pi-protocol`、`pi-client`、`pi-session-backend-sqlite-node`、`pi-storage-sqlite-node`、`pi-coding-agent`、`pi-tui`、`pi-env`、Mastra、LangGraph、`@openai/agents`、Temporal、Zod。

### 2.2 为什么是 pi-durable 而不是 pi-agent-core

**✅ 关键结构事实：这两个是平级的两套运行时，不是上下层。**

```
pi-agent-core 1.5.2  ──依赖──>  pi-ai + pi-schema
pi-durable    1.5.2  ──依赖──>  pi-ai + pi-schema + chord + pi-codemode + pi-telemetry + diff + photon
```

`npm view @earendil-works/pi-durable@1.5.2 dependencies` 实测：**依赖里没有 `pi-agent-core`**。durable 直接建在 pi-ai + chord 上。

所以「用 pi agent 还是 pi durable」不是「要不要多加一层」，是**二选一**。选了 durable 就不需要 agent-core。

**✅ 另一个事实：核心家族内部是精确锁版。** durable 的依赖写的是 `"@earendil-works/pi-ai": "1.5.2"`，**没有 caret**。所以核心家族内部不会自己错位；错位只发生在外围包（§2.5）。

#### 机制对照：为什么 durable 赢得压倒性

| 架构需求 | pi-agent-core 1.5.2 | pi-durable 1.5.2 |
| --- | --- | --- |
| 上下文构建 | ✅ `transformContext` | ✅ `beforeRequest` hook |
| 工具前置拦截 | ✅ `beforeToolCall`（参数已校验） | ✅ `beforeTool`（block / 改参数） |
| 工具后置改写 | ✅ `afterToolCall` | ✅ `afterTool`（含 Harness 自写的错误结果） |
| 提案式终止 | ✅ `terminate: true`（整批都要求才停） | ✅ `control: { terminate: true }`（同语义） |
| 循环调度 | ✅ `prepareRequest` / `finishTurn` | ✅ `onYield` / `afterTools` / `afterRun` |
| UI-only 消息类型 | ✅ 声明合并 + `convertToLlm` 过滤 | ✅ Entry 自定义 kind + 结果三通道 |
| **原子提交** | ❌ 自己写 | ✅ `commit(tx => ...)` 全有或全无 |
| **崩溃续跑** | ❌ 自己写 | ✅ `resume()` + `replay:"safe"` + `restartLimit` |
| **幂等键** | ❌ 自己写 | ✅ `requestId` + `harness.submission(id)` |
| **能力注册表热更新** | ❌ 自己写 | ✅ Registry 运行中可换，会话只存**名字** |
| **类型化状态 + 历史回放** | ❌ 自己写 | ✅ `defineDoc` + `history:"rewindable"` + `snapshotAsOf()` |
| **成本追踪** | ❌ 自己写 | ✅ `pi.usage`，按 provider/model **和按工具名** |
| **遥测脱敏** | ❌ 自己写 | ✅ 只记 ID 与控制元数据 |
| **持久化后端** | ❌ 自己写 | ✅ 五种内置 |
| **只读视图分离** | ❌ 自己写 | ✅ `readOnly: true` → `ReadOnlySession` |
| **工具权限分级** | ⚠️ 自己在 hook 里判 | ✅ `callers` + `modelTools` + `deferred` |
| **图片规范化** | ❌ 自己写 | ✅ Photon + EXIF 转正 + 按模型上限缩放 |

agent-core 只覆盖前六行。**其余全部要手写**——而那些恰好是本项目最难写对的部分（原子性、崩溃恢复、幂等、回放）。

🔷 **结论：用 durable。** 「许多 Pi 都实现好了」这个判断成立，但实现好的是 **durable**，不是 agent-core。

### 2.3 版本决策：1.5.2 精确锁

✅ 完整证据与推理链见 [VERIFY §1](./VERIFY_待验证清单.md)。摘要：

**不存在「更稳定的旧版」这条退路。**
- durable **首次发布 2026-09-19**，距今约 2 个月；1.0.0 是 10-01。
- dist-tags **只有 `latest`**，没有 `stable` / `lts` / `beta`。
- `pi-ai` / `pi-agent-core` 上的 `legacy-node20: 0.74.2` 是 **Node 20 兼容线，不是稳定线**，而且 **durable 没有这个 tag**。

**下限是算出来的：**

| 版本 | 判定 | 理由 |
| --- | --- | --- |
| 1.4.0 | ❌ | 无 `beforeProviderRequest`（1.5.0 才加）→ 网关无法改写请求体 |
| 1.5.0 | ❌ | 两个直接影响我们的 bug 到 1.5.1 才修：① 非严格工具 schema 丢失根级 `$defs`/`definitions`，`$ref` 指向空 → 模型产出错误参数（**我们的 POI 契约会用 `$ref`**）；② `strict:"prefer"` 被拒后每轮重发，白烧 400 |
| 1.5.1 | ✅ | 上述修复到位 |
| **1.5.2** | ✅ **选定** | durable `dist/` 与 1.5.1 逐字节相同，仅版本/依赖号变化；按整线 1.5.2 锁定 |

✅ **tarball 实测**：1.5.2 与 1.5.1 只差 `CHANGELOG.md` 和 `package.json`；durable 本体没有代码变更。1.5.2 是最新补丁版，不是“绝对最好”；对本项目与 1.5.1 等价，取整线 1.5.2。

🔷 **选型性质**：这是“单进程 + SQLite + TypeScript + 无外部集群”约束下最合适，不是绝对最好。替代方案与选型代价见 [ENGINEERING §1](./ENGINEERING_工程化基线与Skill分工.md)。

**不用 main**：main 的 `CHANGELOG.md` 是 `[Unreleased]`，含 `hookTask` 改名、工具 park、`pi.tool` v4 / `pi.generation` v3 等破坏性变更；新 DB schema 旧 Harness 不认，且仓库里没有 `dist/`。**只读 main 看方向，不安装。** 证据见 [VERIFY §1.3](./VERIFY_待验证清单.md)。

**✅ Experimental 是真的**：README 头部原话「Experimental. The API changes without notice between releases.」实证：`runEndTask()` 在 main 上已改名 `hookTask()`。

🔷 **三条风险对策（强制）：**

1. **锁精确版本，不用 `^`**。`package.json` 写 `"1.5.2"`。外围包的错位已经证明这个生态的兼容性不是自动的。
2. **业务逻辑不写进 hook**。能力（高德封装、筛选、排序、闸门规则）写成**纯函数**，`defineTool` / `hook` 只做薄适配。API 变了改适配层，纯函数不动。
3. **存储走可移植核心**。`/storage/sqlite` 不依赖 Node API，换部署只换适配器（§8.4）。

运行时要求：✅ `engines.node >= 22.19.0`，MIT。

### 2.4 排除的方案与理由

| 方案 | 排除理由 |
| --- | --- |
| **AI SDK（`ai` 7.x）** | 用户明确否决。另：其 `@ai-sdk/harness-pi` 适配器不支持结构化输出、不支持历史访问——**那是适配器的限制，不是 Pi 的限制**。直接用 Pi 自己的包，这两条不适用 |
| **`@mastra/core`** | 30+ 依赖，打包三个版本的 AI SDK provider、两个 a2a SDK、posthog、croner、hono。它是一个**平台**，会和我们的网关抢职责 |
| **`@langchain/langgraph`** | 显式图 = 控制流写在代码里 = **直接违反 §1.1 判据** |
| **`@openai/agents`** | 0.x，OpenAI 中心，与「统一网关 + 多上游」冲突 |
| **`pi-agent-core`** | 见 §2.2，被 durable 覆盖 |
| **`pi-coding-agent` / `pi-tui`** | 那是编码 CLI 和终端 UI，不是我们要的运行时 |
| **`pi-env`** | SSH 远程执行守护进程，与本项目无关 |
| **Temporal** | 持久执行最强，但需要独立集群 / Worker / 数据库；单机 SQLite 项目 overkill，且它不提供 agent 的 conversation/doc/tool 语义 |
| **完全自研 durable 层** | 原子提交、崩溃续跑、回放、幂等、doc 历史全自己写；可控性最高，正确性风险也最高 |
| **Zod** | 见 §7.1，pi-schema 已是原生路径，多一层桥接就多一处不一致 |

### 2.5 ✅ 外围包版本错位陷阱

核心线在 1.5.2，外围包卡在旧线上，**依赖声明用的是 caret，会在同一进程里拉进重复副本**：

| 包 | 版本 | 依赖声明 | 判定 |
| --- | --- | --- | --- |
| `pi-web-ui` | **0.75.3** | `pi-ai ^0.75.3`、`pi-tui ^0.75.3` | ❌ 严重错位；且它是**聊天 UI**，不是雷达 UI |
| `pi-protocol` | **1.1.0** | `chord ^1.1.0` | ❌ 错位 |
| `pi-client` | **1.1.0** | `chord ^1.1.0`、`pi-protocol ^1.1.0` | ❌ 错位 |
| `pi-session-backend-sqlite-node` | **0.99.2** | `pi-ai ^0.99.2`、`pi-agent-core ^0.99.2` | ❌ 严重错位 |
| `pi-storage-sqlite-node` | **0.83.0** | `pi-ai ^0.83.0`、`pi-agent-core ^0.83.0` | ❌ 严重错位 |
| `pi-evals` | **404** | — | 仓库里有 `evals` 目录，但未以此名发布 |
| `@netzlabor/pi-durable-postgres` | 0.2.0 | 第三方 | ⚠️ 未评估，需要 Postgres 时再看 |
| `@mariozechner/pi` | 0.70.6 | 旧 scope | ❌ 遗留 |

**那三个 SQLite 包尤其别装**：durable **自带**五种存储后端，不需要外部后端包。

**Web UI 自己写**。应用端通过 `harness.watch()` / `observeCommits()` / `watchDoc()` 订阅状态，再通过 HTTP/SSE 只读推给浏览器（§8.3）；浏览器不持有 Harness。远程 RPC 需要时可用 chord 自带的 HTTP / web 客户端，不用 `pi-protocol` / `pi-client`。当前脚手架只实现 Node HTTP 健康接口，尚未接入 SSE 或 chord RPC。

### 2.6 我们自己写的只剩这些 🔷

「许多 Pi 都实现好了」成立。扣掉 durable / pi-ai / chord / pi-schema 已覆盖的部分，**剩下的自研清单**：

| 要写的 | 在哪节 | 性质 |
| --- | --- | --- |
| 高德能力封装（POI / 批量 ETA / 坐标 / 画线） | §5.1–5.2 | 薄适配 + 纯函数 |
| `candidates.screen` 确定性筛选 | §5.1 | **纯函数**，本项目最核心的业务逻辑 |
| `radar.evaluate` 一次编排（recall→screen→detail→rank→diversify） | §5.7 | 应用端固定编排：I/O 适配 + 确定性纯函数 |
| `candidates.rank_by_weights` 加权排序 | §5.1 | **纯函数** |
| `time.compute_deadline` 时间预算 | §5.1 | **纯函数** |
| 闸门不变量规则（白名单 / 不凑三 / 无数字 / 锁定项） | §9.1–9.2 | 应用端 `checkProposal` **纯函数**（可选 `onYield` 打回） |
| 网关九步中间件链 + 任务类映射表 | §6.1–6.2 | 基础设施 |
| 品牌类型（坐标系 / POI ID / 时间戳） | §7.2 | 类型定义 |
| 雷达 UI + 三选一卡片 + 决策过程抽屉 | §3 | React |
| 应用端确认流 + 幂等键 + 图片校验 | §9.3–9.4、§10.3 | HTTP 边界 |
| JS API 安全密钥代理（含路径白名单） | §10.2 | 已有参考实现 |
| 导入流水线（上传/规范化/视觉抽取/POI 匹配/确认） | §5.5、§8.5 | 纯函数 + `vision.extract` 薄适配 |
| 行程草案（贪心排序 + 锁定 + 冲突） | §5.6 | 纯函数 + 可选 `reason.plan` 润色 |
| 数据模型与文档实体映射 | §8.5 | 类型定义 |
| 应用端 API + SSE/轮询 | §3、§8.6 | HTTP 边界 |
| 预约/营业策略表 | §5.1、§8.5 | 策展数据 + 纯函数 |
| 对象存储、留存与删除 | §10.6 | 基础设施 |
| PWA/离线缓存 + 埋点 | §10.7–10.8 | 前端 |

**注意这张表的形状**：核心业务规则仍然全是纯函数（screen / rank / diversify / deadline / rejection / gate / import match / itinerary order）；新增的是导入流水线、对象存储与应用端 API 这些**边界设施**，它们的业务判断也下沉到纯函数，Pi/Web 框架只做薄适配。这正是 §2.3 风险对策 2 的兑现——Pi 的 API 变了，改的是薄适配层，这些纯函数一行不动。

**不需要自己写的**（容易被误以为要手写）：原子提交、崩溃续跑、幂等键、能力注册表热更新、类型化状态与历史回放、成本追踪、遥测脱敏、只读视图分离、工具权限分级、图片规范化、跨提供方消息转换、持久化后端。

---

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Web UI（React + Vite，自己写）                              │
│  雷达 / 三选一 / 决策抽屉 / 地图 / 导入确认                    │
│  订阅：应用端 SSE 或轮询（不跨进程 watch、不直连 SQLite）      │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP + SSE（写入走应用端，不走模型）
┌───────────────▼─────────────────────────────────────────────┐
│  应用端 / HTTP 边界                                           │
│  · 匿名会话识别        · 导入流水线 / 图片校验                │
│  · 提案闸门（读 proposal doc）· 用户确认执行 / 幂等键          │
│  · 高德 JS API 安全密钥代理（路径白名单，防 SSRF）            │
│  · SSE/轮询桥接        · 对象存储读写/删除                    │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│  pi-durable Harness（单写者进程）                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Registry：能力扩展（运行中可热插拔）                    │  │
│  │ Conversation / Entry / Commit / Document / Task        │  │
│  │ Proposal doc（闸门输入）· 快照 doc                     │  │
│  │ Hooks：beforeRequest · beforeTool · afterTool ·        │  │
│  │        onYield（可选打回，不是主闸门）· afterRun        │  │
│  └───────────────────────────────────────────────────────┘  │
│  存储：SQLite（每匿名用户一个文件，WAL, synchronous=NORMAL）  │
│  对象存储：本地卷 / S3 / OSS（图片原图与规范化副本）           │
└──────┬────────────────────────────────────┬─────────────────┘
       │                                    │
┌──────▼──────────────────┐   ┌─────────────▼─────────────────┐
│  能力层（纯函数 + 薄适配）│   │  模型网关（pi-ai provider）    │
│  place.* / geo.* /       │   │  任务类 → 模型映射             │
│  trip.* / time.* /       │   │  九步中间件链                  │
│  candidates.* / import.* │   │  createProvider + compat       │
│  itinerary.* / policy.*  │   │                                │
│  constraints.*           │   │                                │
└──────┬──────────────────┘   └─────────────┬─────────────────┘
       │                                    │
┌──────▼──────────────────┐   ┌─────────────▼─────────────────┐
│  高德 Web服务 REST        │   │  模型网关：智谱/火山          │
│  批量 ETA / POI / 坐标    │   │  OpenAI 兼容；base_url 见 §6.3 │
└─────────────────────────┘   └───────────────────────────────┘
```

### 3.1 每层的职责与禁止事项 🔷

| 层 | 负责 | **禁止** |
| --- | --- | --- |
| Web UI | 渲染、收集确认、展示决策过程；经 SSE/轮询订阅 | 持有任何服务端密钥；直接写状态；直连 SQLite |
| 应用端 / HTTP | 身份、导入、校验、提案闸门、确认执行、幂等键、代理、SSE、对象存储 | 做业务决策；绕过闸门写入；跨进程 watch |
| Harness | 循环、原子提交、持久化、恢复、proposal doc | 装业务规则（规则在能力层和闸门） |
| 能力层 | 确定性计算、外部 API 封装、导入/行程/策略纯函数 | 自己决定调用顺序；持有模型密钥 |
| 网关 | 路由、预算、校验、兜底、记账、脱敏 | 决定业务降级策略（那属于运行时） |
| 对象存储 | 图片原图/规范化副本、留存、删除 | 把对象 key 或存储凭据下发前端 |

### 3.2 先是代码边界，再是部署边界 🔷

网关**先是进程内的一个 pi-ai provider**，不是独立 HTTP 服务。需要拆出去时，把 `baseUrl` 指向自己的网关端点，**应用代码一行不改**。

同理，存储先是本地 SQLite 文件，需要换时只换适配器。

**进程边界先于部署边界。** 默认采用**单写者进程**：同一个 Node 进程里跑 Harness、应用端 HTTP、提案闸门、导入流水线和 SSE；每个匿名用户一个 SQLite 文件，进程内可持有多个 Session。Web UI 经应用端 SSE/轮询订阅，**不跨进程 `harness.watch()`，也不直连 SQLite**。需要拆成 worker + HTTP 时，应用端通过命令通道写 Harness，读侧仍由 worker 桥接；不引入第二个写者（§8.3）。

**部署目标已定**：`heirloom-lite` 项目的阿里云跳板机（Linux ECS）。架构按「单 Node 进程 + 持久盘 + Nginx 反代」设计；OS 版本、Node 版本、持久盘挂载点、端口/域名仍待上机确认（VERIFY V8–V9）。不为假想的托管形态提前抽象。

---

## 4. Pi 机制映射（1.5.2 实测可用性）

### 4.1 ✅ 已发布，直接用

| 架构需求 | Pi 原生机制 | 落点 |
| --- | --- | --- |
| 原子提交闸门 | `conversation.commit((tx) => ...)` 追加 entry + 改 doc + 建 task，**全有或全无**；「nothing is shown before its commit is stored」 | 所有写入 |
| 提案式终止 | 工具返回 `control: { terminate: true }`；**整轮每个结果都要求才停**，混合批次继续。终止后由应用端读 proposal doc 跑闸门 | `candidates.propose` |
| 应用端打回（主路径） | 应用端读 `nextstop.proposal` 跑纯函数闸门；不合格用 `submit` 发修复指令（≤2 次），或走确定性兜底 | 闸门（§9.2） |
| 循环打回（可选） | `onYield` 只在**非终止**最终答案路径可打回；`terminate` 轮不经过它。仅作为补充，不承担主闸门 | §9.2 |
| 上下文构建 | `beforeRequest` hook 替换单次请求的 messages | 注入两个快照 + 硬约束 |
| 网关请求改写 | `beforeProviderRequest` hook 替换单次请求 body | §6.4 |
| 模型看不到的能力 | `callers: ["tools"]` + `modelTools` 白名单 + `deferred` | 写入类、`geo.route` |
| 程序 vs 模型 vs UI 三通道 | 工具结果 `output`（模型）/ `structuredOutput`（程序，Harness 校验）/ `details`（UI）。**transcript 只存 output + details**，`structuredOutput` 不落盘 | 决策过程抽屉 |
| 提案持久化 | `nextstop.proposal` doc（`history:"rewindable"`）保存提案；应用端闸门与前端都读它，不依赖 `structuredOutput` 或最终答案 | §8.1、§9.2 |
| 文档 scope | 1.5.2 只有 `session` / `conversation` / `task`；本项目的用户数据用 `conversation` scope，**一个匿名用户 = 一个长期 conversation + 一个 SQLite 文件** | §8.1、§8.5 |
| 类型化状态 + 回放 | `defineDoc({ scope:"conversation", history:"rewindable" })` + `snapshotAsOf()` | 两个快照（§8.1） |
| 幂等 | `requestId`（同 id 返回同一 submission）+ `harness.submission(id)` 重启后重取 | 应用端生成 |
| 崩溃续跑 | `harness.resume()`；工具声明 `replay:"safe"` 才重跑，否则给模型 `interrupted`；`settings.restartLimit` 默认 5 防崩溃循环 | 所有工具需显式声明 |
| 能力热插拔 | `registry.install()` **运行中可换**；会话只存扩展**名字**不存代码；新工作用新状态 | §5.4 AI-first 验收 |
| 成本追踪 | `pi.usage`：按 `provider/model` **和按工具名**分别累计；失败与中止也计 | 高德调用报 `usage` 计入 |
| 遥测脱敏 | 「Attributes contain IDs and control metadata, never messages, arguments, or results」 | §10.4 |
| 只读视图 | `readOnly: true` → 任何 write / resume / task-run 都 reject `ReadOnlySession` | Web 侧进程 |
| 会话亲和 / 缓存 | 每会话持久化 UUIDv7 存于 `pi.provider`，转发给 pi-ai 作 `sessionId`；跨重开/重试/reset/compaction/换模型存活 | 网关缓存键 |
| 图片规范化 | `createNodePhotonImages()`：EXIF 转正、解码校验（坏图进不了 transcript）、worker 线程、30s 空闲退出释放 WASM 内存 | 截图导入 |
| 时间等待 | `defineTask` + `runtime.sleepUntil(at, {phase}, ctx)`；或 `commit()` 返回 `{status:"sleeping", until, checkpoint}`。**存储化，不占进程，跨重启存活** | 若需要延时任务 |
| 测试回放 | `fauxProvider()` 脚本化响应；`registerStorageConformance()` 存储一致性套件 | §6.6 |

### 4.2 🔴 仅在 main，**1.5.2 没有**——上一轮的更正

✅ 证据：`packages/durable/README.md` 在 v1.5.2 是 **986 行**，main 是 **1154 行**；main 的 `package.json` 仍写 `"version": "1.5.2"` → **未发布的在途代码**。四个章节只在 main：`### Signals`、`### Tools that park`、`### Gates before a tool runs`、`### Work before an answer stands, and after a round`。

| 我曾引用的机制 | 1.5.2 | 替代方案 |
| --- | --- | --- |
| `defineSignal` / `harness.signal()` | ❌ | 不用信号，见下 |
| `api.memo()`（工具内幂等键） | ❌ | 幂等键自己存进 `defineDoc`，在 commit 里读 |
| `beforeTool` 返回 `{sleep}` 挂起等审批 | ❌ 只能 block / 改参数 | **确认放到 agent 之外**（§9.3） |
| 工具返回 `{sleep}` / `{wait}` 挂起 | ❌ | 同上 |
| `onYield` 返回 `{tasks}`，答案不成立就不让 `wait()` resolve | ❌ 只有同步版 | 主闸门移到应用端（§9.2）；`onYield` 只作为非终止轮的可选打回，不再依赖 V6 |
| `terminate` 轮触发 `onYield` | ❌ 1.5.2 源码：`finishToolRound()` 直接 `endRun()`，不经过 `answer()` | 提案 doc + 应用端闸门（§9.2） |
| `afterTools` 返回 `{tasks}` | ❌ | 用应用端闸门；`afterTools` 只做观察 |
| `createFitImagesExtension` / `/images/fit` / `fitImage` | ❌ | `createNodePhotonImages()` **有**；按模型上限自己 fit |
| `hookTask()` | ❌ 1.5.2 叫 **`runEndTask()`** | 用 `runEndTask()`；升级时注意改名 |

✅ **2026-11-16 复核 1.5.2 npm 包源码**（`dist/harness/generation.js`），补三条会影响闸门落点的事实：

1. `onYield` 只在 `answer()` 里调用，也就是**最终答案**路径；`terminate` 轮走 `finishToolRound()` → `endRun()`，**不经过 `onYield`**。
2. `onYield` 在答案提交前调用；返回 `{continue}` 时不会 `endRun`，提交会等到最终答案——所以 `wait()` 不会在首次答案 resolve。
3. 但**被打回的中间答案会 `appendAssistant` 进 transcript**；前端如果订阅 entries 会看到「半个结论」，必须只渲染最终答案/proposal doc。

因此主闸门放应用端（§9.2），V6 从「阻断项」降级为「已知语义」。

🔷 **不采纳「等 Signals 发布」作为当前方案**，只记录为未来简化点。

---

## 5. 能力层

### 5.1 能力清单 🔷

| 能力 | 入参 → 出参 | 谁能调 | 成本 | 说明 |
| --- | --- | --- | --- | --- |
| `place.search_text` | 关键词 + 城市 → POI[] | model | 1 次 REST | `/v5/place/text`，`show_fields=business`；**`opentime_today/week` 在这里返回** |
| `place.search_around` | 中心 + 半径 + 类型 → POI[] | model | 1 次 REST | ✅ 半径 0–50000m（默认 5000）；`page_size` 1–25、`page_num` 1–100；结果由 `candidates.recall` 合并 |
| `place.detail` | 一组 poi_id → 详情 | model | **1 次 REST（实测 ≤35 个 id，按 ≤25 分批留余量）** | `cost` / `rating` / business；**detail 约 4/10 才带 `opentime_today`**，营业时间主源是 `place.search_text` 或 `policy.json` |
| **`geo.batch_walk_eta`** | **origins[]（≤100）+ destination + mode** → ETA[] | model | **1 次 REST** | `/v3/distance`；**方向固定 origins→destination**，不能一次算 current→N 候选（§5.2） |
| `geo.route` | 两点 → 折线 | app only / tools | 1 次 REST（贵） | **仅用于画线**，绝不用于可行性判断 |
| `geo.convert` | WGS-84 / 百度 / mapbar → GCJ-02 | app / model | 1 次 REST（≤40 对） | ✅ 官方只支持**转入高德坐标**，不支持 GCJ-02 → WGS-84；批量上限 40 |
| **`candidates.recall`** | wishlist + 可选 nearby + constraints → pool | model | 0～1 次 REST | 合并收藏与附近、按 provider+poi_id 去重、写本 session 的 `candidate_pool` |
| `place.estimate_stay` | category / poi → `{min,max}` | model | 0 | **纯函数**；标 `estimated`，不伪装实测 |
| `policy.lookup` | poi_id → booking / opening / source / status | model | 0 | 读策展策略表；`verified` / `unknown` / `stale` |
| `trip.read` | conversation → 行程 + 锁定项 | model | 0 | 读 doc |
| `wishlist.read` | conversation → 灵感库 | model | 0 | 读 doc |
| `session.read_history` | conversation → 拒绝理由 / 偏好 | model | 0 | 读 doc |
| `time.compute_deadline` | 当前时间 + 锁定项 + 可选返程 → 可用窗口 | model | 0 | **纯函数** |
| **`candidates.screen`** | 见下 | model | **0 或 2–3 次 REST** | **确定性筛选 + 批量 ETA（三段腿）**；传入新鲜 snapshot 时 0 次 |
| `candidates.rank_by_weights` | feasible[] + 权重 → 排序 | model | 0 | **纯函数** |
| `candidates.diversify` | ranked[] + 类别 → diversified[] | model | 0 | **纯函数**；MMR/类别约束 |
| **`radar.evaluate`** | 池 + 约束 + 时间窗 → feasible + ranked + evidence | model | 0–1 搜索 + 3 批 + N 次 detail | **一次编排**（recall→screen→top-N detail→rank→diversify）；只为压延迟，不写用户状态，只更新快照 |
| `candidates.propose` | diversified[] → 三选一提案 | model | 0 | **写本 session 的 `nextstop.proposal` family 成员**；返回 `terminate: true`；提案阶段独占工具面（§9.2） |
| `constraints.apply_rejection` | rejection + constraints → constraints' | model / app | 0 | **纯函数**；"太远"降阈值，"不想走路"换模式（使 ETA 快照失效） |
| `itinerary.draft` | wishlist + date + locked + ETAs → stops | model / app | 0～N | 贪心排序 + 锁定；`reason.plan` 只润色 |
| `import.parse` / `import.match` / `import.confirm` | batch → candidates / places | app only | vision + N 次搜索 | 见 §5.5 |
| `trip.write` / `trip.lock` / `trip.undo` / `nav.launch` / `data.delete` | — | **app only，且需用户确认** | 0 | **模型永远看不到**（§9.3） |

> **调用边界**：应用端直接调用能力函数，不经过 `defineTool`；`callers` / `modelTools` 只约束模型与嵌套工具。`geo.route`、`trip.write` 等「app only」能力可以注册成工具，也可以完全不注册——模型都看不到。

`candidates.screen` 的契约：

```ts
candidates.screen({
  pool,            // candidate_pool 快照（已由 candidates.recall 合并收藏+附近）
  deadline,        // time.compute_deadline 的结果
  origin,          // 当前位置（品牌类型，见 §7.2）
  next_locked,     // 下一个锁定行程项（可空）
  constraints,     // 硬约束（含 return_to_origin）
  rejected,        // 已拒绝的 poi_id + reason_code
  stay_min,        // place.estimate_stay 的结果
  eta_snapshot?,   // 可选：未过期且 mode/origin 未变时复用，0 次 ETA 调用（§8.2 重排）
  origin_to_next_eta?, // 可选：current→next_locked 已查过则复用，避免重复调用
}) → {
  feasible: [],
  excluded: [{ poi_id, reason_code }],
  eta_snapshot: {  // 存进本 session 的 nextstop.eta_snapshot family 成员
    by_leg: { to_candidate: [], to_next: [], origin_to_next: [] },
    direction: { to_candidate: "reverse|forward" },
    fetched_at,
    status: "estimated|verified|stale",
  },
}
```

> `to_candidate` 在步行模式下用反向调用（candidates→current）近似，标 `reverse` + `estimated`；`to_next` 是自然方向；`deadline` 的 current→next_locked 单独一次调用。绝不在 ETA 上伪装成 `verified`。
>
> 传入 `eta_snapshot` 且仍在 TTL 内、mode 与 origin 邻域未变 → 直接用它筛选，**0 次地图调用**（§8.2 的拒绝重排就是这条路径）；否则 `screen` 自己补齐 2–3 次批量，并返回新的 `eta_snapshot`。`origin_to_next` 这条腿若在 `time.compute_deadline` 前已查过，通过 `origin_to_next_eta` 传入复用。

### 5.2 ✅ `batch_walk_eta` 的方向、调用次数与 `route` 分工

**这是整个性能设计的基石，但方向不能想当然。**

✅ 高德 `/v3/distance` 事实（2026-11-16 实测 + 官方文档）：
- **`origins` 支持 100 个坐标对**（`|` 分隔），**`destination` 只有一个**；传 101 个**静默截断到 100**（`count`=100，不报错）。
- `type`：`0`=直线，`1`=驾车（默认，含路况），`3`=步行（**官方口径仅 5km 内；实测超距也返回数值，不报错**）。
- **必须逐条判 `results[].info`，不能只看顶层 `status`**——部分失败时顶层仍是成功；两个 destination 直返 `INVALID_PARAMS`。
- **实测步行 A→B 与 B→A 同值**（对称）；**QPS 约 5/s**（连续调用触发 `CUQPS_HAS_EXCEEDED_THE_LIMIT`，1s 恢复），所有高德调用要带限速器 + 重试退避。

**关键更正**：这个接口的方向是 **N 个 origins → 1 个 destination**；雷达需要的是 **1 个 origin（当前位置）→ N 个候选**。两者不是同一个方向。

落地方式（Demo 步行）：

| 腿 | 调用 | 方向 | 证据 |
| --- | --- | --- | --- |
| 候选 → 下一锁定项 | `origins = candidates`，`destination = next_locked` | 自然方向 | `estimated` |
| 候选 → 当前位置 | `origins = candidates`，`destination = current` | **反向**；步行近似对称，标 `reverse` | `estimated` |
| 当前位置 → 下一锁定项 | `origins = [current]`，`destination = next_locked` | 自然方向 | `estimated` |

- **最少 3 次批量调用**，不是 1 次；每次仍是 O(1)，不是 O(N)。`eta_snapshot` 必须按 `by_leg` 存，不能只存一个数组。
- **反向腿只在步行模式下成立**；驾车（`type=1`，含路况）不能假定对称，需要逐候选查或改用路径规划接口。Demo 默认步行（PRD D-05）。
- **步行 >5km**：官方口径只支持 5km 内，但**接口不拦截**（实测 97km 也返回值）；超距候选必须由应用侧判 `excluded: WALK_TOO_FAR`，或用户显式切换到驾车后重查。不要把返回值当可行。
- **`route` 是单条、贵、只用于渲染折线**：设成 app only / `callers: ["tools"]`，模型在协议层调不到，不可能拿它做批量判断。
- **`place.detail` 实测一次可传 ≥35 个唯一 id**（官方文档写 ≤10，2026-11-16 实测 35/35 返回；实现按 ≤25 分批留余量）。detail 的 business 约 4/10 带 `opentime_today`；营业时间主源是 `place.search_text` 的 business 字段或 `policy.json` 策展值，缺失标 `unknown`。预约类字段（`ticket_ordering` 等）在高德返回里完全不存在，预约信息只能走策展表（V12 ✅）。

批量验证 curl 见 [SETUP §3.5](./SETUP_平台开通指南.md)。

### 5.3 能力是纯函数，durable 只做薄适配 🔷

```ts
// 纯函数：可单测，不依赖 Pi，API 变了不用改
export function screenCandidates(input: ScreenInput): ScreenResult { /* ... */ }

// 薄适配：只有这一层碰 Pi API
const screen = defineTool({
  name: 'candidates_screen',
  description: '按硬约束筛选候选，返回可行集与排除原因',
  parameters: ScreenInputSchema,          // pi-schema
  structuredOutputSchema: ScreenResultSchema,
  replay: 'safe',                          // 纯计算，可安全重跑
  execute: async (args, api, ctx) => {
    const result = screenCandidates(args);
    return {
      output: [{ type: 'text', text: summarizeForModel(result) }],
      structuredOutput: result,            // 给程序，Harness 校验
      details: { excluded: result.excluded }, // 给 UI 抽屉，模型看不到
    };
  },
});
```

**`replay` 必须逐个显式声明**：纯计算 → `"safe"`；有外部副作用（写行程、发起导航）→ 不声明，崩溃后给模型 `interrupted` 而不是重跑。

### 5.4 AI-first 验收方式 🔷

新增不改变既有硬约束与交互契约的信息能力时，目标是复用既有循环：

1. 实现能力：I/O 走适配层，确定性计算用纯函数，并给 `defineTool` 明确的输入/输出契约。
2. `registry.install(defineExtension({ name: 'queue', tools: [queueTool] }))`，由模型在授权工具面内选择何时调用。
3. 用真实调用与闸门测试确认扩展生效，检查是否意外改变了其他能力。

新增硬约束、字段或交互时，应同步更新闸门、契约和渲染；不能为了「只注册工具」而漏掉校验。`radar.evaluate` 固定组合 I/O 与纯函数以压低延迟，也符合这个目标。

✅ Pi 支持 Registry 运行中替换，为能力扩展提供机制；它不保证任意新能力都无需改应用代码。

### 5.5 导入流水线 🔷

PRD 的 P0 前半段（FR-02 / FR-03 / UJ-01）。导入不交给模型自由编排，是一条**应用端流水线 + 一个视觉模型调用**：

```
上传（multipart）
  → 大小/类型校验
  → 原图存对象存储（key 写 source_asset）
  → Photon 规范化（EXIF 转正、坏图剔除）
  → vision.extract（每张图一次，任务类，不给写入工具）
  → candidate_place 记录（import_batch 内，raw_name / evidence / confidence）
  → place.search_text（按城市+名称，串行限速 ≤4 QPS + 退避重试）
  → matchCandidates / dedupeByProvider（纯函数）
  → 统一确认 UI（已匹配 / 待确认 / 未匹配）
  → 用户一次确认
  → 写 wishlist（Provider + provider_poi_id 唯一）+ 标记 batch confirmed
```

**边界**：

- 视觉抽取的输出**一律当不可信数据**（VERIFY §2.2 多模态静默降级）；只有确认后的 `Place` 进 wishlist。
- **图片只发给 GLM / Doubao。** 视觉抽取只有这两个上游；不通时 `NoModelAvailable`，应用端走手动添加/确定性兜底。
- **抽取结果分两类**（✅ V13 实测）：图里有地点文字 → `places[]`（high/mid conf，进主确认流）；纯照片无文字 → 允许模型给 `guessed:true` 的地标猜测（东方之门/古镇等，2026-11-16 实测 6/7 纯照片图能猜对），进「可能想去」建议位、单独展示、必须用户确认，**不与文字抽取结果混存**。
- `candidate_place` 与 `Place` 分开存；删除来源图不自动删已确认 Place（PRD FR-04）。
- 每张图独立状态与重试；坏图剔除并附说明；导入进度按图上报。
- 图片原文不进 system prompt；抽取调用不注册写入类工具（§10.3）。
- 识别失败/低置信：走手动添加或换候选，不生成虚构地点（PRD TC-03）。

### 5.6 行程草案 🔷

PRD 的 FR-05 / UJ-01 第 6 步。草案是**确定性排序 + 可选模型润色**：

1. 按地理区域聚类 wishlist，锁定项作为不可移动锚点；
2. 用 `place.estimate_stay` 的范围中位数 + `geo.batch_walk_eta`（自然方向）排顺序；
3. 检查开放时间/预约/时间冲突；冲突项标 `conflict`，不静默覆盖锁定项；
4. `reason.plan` 只负责生成解释/备选描述，**不得修改顺序或锁定项**；
5. 输出 `nextstop.trips` 的 draft（`revision`），用户确认后 app 写 active。

不承诺全局最优；PRD D-06 已明确「1 日、有限 POI 的可编辑草案」。

### 5.7 延迟预算 🔷

PRD 目标：雷达中位 ≤12s。当前场景如果按 6 个模型回合走，会超。把预算写成硬约束：

| 段 | 预算 | 做法 |
| --- | --- | --- |
| 上下文/输入 | ≤0.2s | doc 读取；只注入摘要，不注入全池 |
| 召回 | ≤1.5s | `candidates.recall`；附近搜索 1 次 |
| 筛选 + ETA | ≤3s | 2–3 次批量调用，并行发 |
| 详情 top N | ≤2s | `/v5/place/detail` 一次批量（实测 ≤35，按 ≤25 分批）；opening 从 search/policy 补 |
| 排序 + 差异化 | ≤0.1s | 纯函数 |
| 模型 | ≤4s | 必要的 Jev 意图/偏好/理由码决策；结构化输入省分类，普通理由模板省文本生成；不要 6 回合 |
| 渲染/SSE | ≤0.3s | 先出首选，再出备选 |

落地：把 read → screen → rank → diversify 收敛成一个 `radar.evaluate` 编排，纯筛选/排序函数保持不变。Jev 在需要时做意图/偏好理解与理由码选择，普通卡片用受控模板；复杂自由表达才调 `reason.explain`。同一 state 上的独立问题合并请求，依赖后续地图证据的问题等证据齐备再问。独立 I/O 并行；外部调用与 fallback 共用本次总 deadline，不能每跳重置；超时/失败走确定性兜底并标 `estimated/unknown`。`maxTurns` 是安全阀，不是延迟预算。

---

## 6. 模型网关

### 6.1 任务类而非模型名 🔷

**应用代码只认任务类，不认模型名。** 换模型 = 改一张映射表。

| 任务类 | 用途 | 主模型 | 备选 | 约束 |
| --- | --- | --- | --- | --- |
| `vision.extract` | 小红书截图 → POI 候选 | 智谱 `glm-5.3-flash` | 智谱 `glm-4.6v-flash`（备用 Key，429 高发）；火山 `doubao-seed-2-1-lite-260915` | ✅ 2026-11-16 实测：Coding Plan 端点接受 `thinking:{type:'disabled'}`、`max_tokens`、`response_format:{type:'json_object'}` 和强制工具调用；结构化输出走 `json_object` + pi-schema 全量校验，不依赖 `json_schema` |
| `reason.explain` | 复杂自由表达的定性理由（不排序、不算数） | 火山 `doubao-seed-2-1-lite-260915` | 智谱 `glm-5.3-flash`（末位） | 常见卡片先用 `decision.reason` + 受控模板；需要自由表达时才调用；reason 无数字字段 |
| `reason.plan` | 行程草案的润色/备选解释 | 火山 `doubao-seed-2-1-lite-260915` | 智谱 `glm-5.3-flash`（末位） | 同上；不得修改顺序/锁定项 |
| `fast.intent` | 自由文本意图识别 / 拒绝原因分类 | Jev `jev-latest`（用户指定中转） | Doubao 2.1 Lite（网络/协议失败时） | 原生 SystemOne 协议；Chips 直接映射；unknown/含糊表达要求确认，不强制猜分类 |
| `decision.poi_match` | 有歧义的高德候选消歧 | Jev `jev-latest` | 手工确认 / 当前匹配规则 | 仅在给定 POI ID 中选择，保留 none/needs_review |
| `decision.preferences` | 提取环境/节奏/兴趣等有限偏好标签 | Jev `jev-latest` | 表单 / 用户确认 | 未表达字段保持 unspecified；代码映射软权重，长期保存需确认 |
| `decision.reason` | 从已有证据支持的理由码中选择主理由 | Jev `jev-latest` | 确定性理由选择 + 模板 | 代码先限定可选理由；普通卡片可省一次文本生成 |
| `fast.normalize` | POI 名称归一 | 火山 `doubao-seed-2-1-lite-260915`（thinking off） | — | 自由文本归一仍走生成模型；有限候选消歧走 `decision.poi_match` |

> POI 匹配/去重是确定性的：`provider + provider_poi_id` 主键、名称+坐标次判、小红书抽取名走高德 `place.search_*` + 用户确认，PRD 范围内没有语义相似度功能。若将来加「相似地点推荐」这类功能，再按同一张表新增 `embed.text` 任务类即可，网关结构不变。

### 6.1.1 运行时端点：标准按量是默认，套餐模式是用户显式风险选择 🔴

官方条款原文（2026-11-16 复核）：

> **智谱 Coding Plan** 官方快速开始原文：「GLM Coding Plan 仅限在官方支持的指定工具与产品环境中使用」。专属端点是 `/api/coding/paas/v4`、`/api/anthropic`、`/api/v1`，与套餐 Key 绑定。
>
> **火山 Agent Plan** 官方套餐概览原文：「文本生成模型及向量化模型不可用于 API 调用」；「在非 AI 工具中使用 Agent Plan 权益对应的 Base URL 和 API Key 有可能被识别为滥用/违规」；违规「会导致订阅停用或账号封禁」。Agent Plan 端点：`https://ark.cn-beijing.volces.com/api/plan/v3`。
>
> **火山 Coding Plan** 官方概览原文：「套餐额度仅在 AI 编程工具中生效，不可用于 API 调用」。端点：`https://ark.cn-beijing.volces.com/api/coding/v3`。

**结论：合规默认值仍是标准按量 API。** 但 2026-11-16 用户明确选择：本次先按 **plan 模式**跑，配置与 `heirloom-lite` 生产 env 一致（智谱 Coding Plan + 火山 Agent Plan）。这是**用户已知条款风险后的选择，不是「官方允许」**；文档保留风险标记，并保留 standard 模式一键切回。

| 模式 | 智谱 Base URL | 火山 Base URL | 说明 |
| --- | --- | --- | --- |
| `standard`（默认） | `https://open.bigmodel.cn/api/paas/v4` | `https://ark.cn-beijing.volces.com/api/v3` | 合规路径；正式上线/对外演示优先 |
| `plan`（本次选择） | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://ark.cn-beijing.volces.com/api/plan/v3` | 与 heirloom-lite 一致；账号可能被停用/封禁，启动时打 warning |

```bash
MODEL_ENDPOINT_MODE=plan        # standard | plan
```

模型 ID：

| 提供方 | 标准模式 | plan 模式 | 备注 |
| --- | --- | --- | --- |
| 智谱 | `glm-5.3-flash` | `glm-5.3-flash` | 若 Coding Plan 套餐页给的是 `glm-5.3`，以套餐页为准；先按 `glm-5.3-flash` 试 |
| 智谱（备用 Key） | `glm-4.6v-flash` | 同左（标准按量） | `ZHIPU_BACKUP_*`；主 Key 配额耗尽时启用，与主 Key 分开计费；429 高发 |
| 火山 | `doubao-seed-2-1-lite-260915`（或 `ep-...`） | `doubao-seed-2-1-lite-260915` | 与 heirloom-lite env 一致；官方 Agent Plan Pi 文档写 `doubao-seed-2.1-lite`，以实测为准 |
两个主力模型都是 1M 上下文；GLM-5.3-Flash 支持图像/视频/文本输入，Doubao 2.1 Lite 也支持视觉理解。模型 ID 与 Base URL 一律走配置，不写死在业务代码里。

### 6.1.2 TypeSafe AI Jev：有限选项语义决策 🔷

**Jev 是 TypeSafe AI 的决策模型**，不是 Ajv 校验库。它根据 `state` 回答类型化问题：Choice 从给定选项选一项，Score 输出有描述档位上的概率分布与期望分数，Noul 返回肯定答案的概率。类型合法与判断正确是两件事；概率/置信度必须用本项目标注数据校准，不能当事实凭证。

**接入选择（2026-11-16 用户指定）：通过用户提供的中转使用 `jev-latest`。** `JEV_BASE_URL` / `JEV_API_KEY` / `JEV_MODEL` 保存在 Git 忽略的 `.env.jev.local`，凭据不进源码。该选择覆盖此前固定 `jev-1.14.0` 的建议；记录请求别名与响应中的实际模型名，若中转只回显 `jev-latest`，实际解析版本标为未知，不自行推定。

按业务流程分配：

| 优先级 | 任务类 / 使用点 | 输入 → 输出 | 落点与边界 |
| --- | --- | --- | --- |
| 优先接入 | `fast.intent` | 自由文本 + 当次上下文 → 意图/拒绝原因 | 替代这类任务的生成式分类；反馈 Chips 直接映射；不确定时确认；代码执行 `constraints.apply_rejection` |
| 优先接入 | `decision.poi_match` | 抽取名/城市/地址线索 + 高德候选 → 候选 ID / 无匹配 / 待确认 | 辅助 `import.match` 同名门店消歧；先做精确规则匹配，仍有歧义才调用；wishlist 写入仍需用户确认 |
| 优先评估 | `decision.preferences` | “想安静坐会儿”等表达 → 环境/节奏/兴趣等预定义偏好标签 | 代码映射软权重；未表达字段保持 unspecified；长期记忆须单独确认；不从“累”擅自推出不可步行等硬约束 |
| 优先评估 | `decision.reason` | 已验证事实 + 用户偏好 + 允许理由码 → 主理由码 | 代码先排除无证据支持的理由，再由 Jev 选最相关项；模板产出卡片一句话，常见路径可省一次 `reason.explain` 文本生成 |
| 后续评估 | `decision.preference_fit` | 已通过硬筛的 top K + 偏好 → 有锚点描述的匹配评分 | 作为软评分特征交给 `rank_by_weights`；不覆盖时间/预算/预约；`score` 是概率加权期望、可为小数，不把它当整数枚举 |
| 后续评估 | `decision.experience_type` | POI 类别/描述 → 休息/漫步/文化等体验标签 | 补充规则映射无法覆盖的语义标签，供差异化；saved/new 等来源标签由代码确定；不推断营业/预约状态 |
| 后续评估 | Langfuse 自定义 evaluator | 输入证据 + 输出理由/提案 → 支持度/匹配度评分 | 实验脚本调用 Jev 后回传 Langfuse；用于质量评测，不参与生产放行，仍需人工标注基准 |

推荐调用方式：

1. 结构化表单/反馈 Chips 直接进入应用函数；自由文本才调用 `fast.intent`，可在同一请求中同时提取彼此独立的偏好标签。
2. 应用查询高德并完成硬筛；只有存在语义歧义/偏好判断时才调用 Jev。地点评分、体验标签、每个候选的理由选择可共享事实 state，但各问题独立。
3. 编排层调用 decision transport，结果作为纯函数排序/差异化的输入；`screen` / `rank_by_weights` 本体不发模型网络请求。
4. 卡片优先使用受控理由码与模板；复杂自由表达再调用 `reason.explain`。替换现有语义调用，不把 Jev 与生成模型无条件串联两次。

**确定性边界**：ETA、时间窗口、价格计算、预约资格、硬约束闸门、幂等/乐观锁、用户授权和最终写入保持纯函数/事务校验。任意地点名抽取、长文本解释仍由现有视觉/生成模型承担，Jev 的有限选项选择不负责生成未知地点名。

**图片扩展仅作后续候选**：官方 `jev-1.14.0` 支持实验性的 Box，可尝试把已抽取的地名/证据定位成确认 UI 的高亮框。须另测中转图像协议、文字框精度与缺失目标；Box 在目标不存在时仍会返回坐标，不能单独当“确有此证据”。当前截图抽取链仍只用 GLM/Doubao。

接入与验证：

- 原生请求为 `POST /v1/systemone`、`state + questions`；在现有模型网关内加独立 decision transport，不引入 AI SDK，也不伪装成 Chat Completions provider。
- 同一次请求可问多个问题，但各问题独立判断；有依赖的结论由代码组合或分次请求，不能假设问题之间会互相引用答案。
- 用 pi-schema 校验响应结构、问答 ID、候选成员关系、概率范围与 Score 的合法区间；低置信、上下文不适用或网络失败时进入确认/现有路径。拒绝阈值由标注集确定，不全局硬编码一个“可靠”分数。
- 独立 timeout、预算、用量记账；与现有网关共用请求关联 ID，模型别名/实际版本、延迟、成本、fallback 状态统一记录到 Langfuse。
- 优先做意图与 POI 消歧对照；记录包含网络、解析、fallback 的端到端 p50/p95、准确率、错误动作率、需确认率与成本。有限输出预期降低生成开销，尚未实测的比较不写成“一定更快”。
- 小规模协议/合成样例探针见 `scripts/probe-jev.mjs` 与 `evals/jev-smoke-cases.mjs`；本地结果在 `testdata/jev-probe/`（已获授权随仓库入库），不能替代真实样本上的准入评测。

**2026-11-16 中转小样例实测**：`/v1/models` 与 `/v1/systemone` 均返回 200；请求与响应模型名均为 `jev-latest`，解析版本未知。固定套件的 16 个请求全部 HTTP 200，p50 **908ms**、p95 **3348ms**（本机经中转的完整请求，含读取响应）；14 个 Choice 请求的判断和检查均通过。2 个 Score 的高低方向符合样例，但 `score=2.99/0.01` 与返回概率加权值 `3/0` 相差约 0.01，触发严格一致性检查，探针退出码为 1；需确认中转数值精度行为后再启用连续评分。合成小样例不代表生产准确率，也未与同输入 Doubao 做速度对照。

### 6.2 九步中间件链 🔷

```
内部鉴权 → 路由（任务类→模型） → 缓存 → 预算 → 超时调用
        → schema 校验（+1 次修复重试） → 跨提供方兜底 → 记账 → 脱敏
```

**网关返回诚实的 `NoModelAvailable`，不假装成功。降级策略属于运行时，不属于网关。**

理由：网关知道「没有可用模型」，但不知道「这个业务场景能不能降级成纯确定性筛选」。后者是业务判断，放网关就是把业务逻辑塞进基础设施。

### 6.3 落地形态：pi-ai 的 custom provider 🔷

```ts
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const api = openAICompletionsApi();

const endpointMode = process.env.MODEL_ENDPOINT_MODE ?? 'standard';
const plan = endpointMode === 'plan';
if (plan) {
  console.warn('[model] plan endpoint mode: 官方条款不允许后端 API 调用，账号风险由部署者承担');
} else {
  // standard 模式下结构上挡住套餐端点（§6.1.1）
  for (const [name, url] of [
    ['ZHIPU_BASE_URL', process.env.ZHIPU_BASE_URL],
    ['ARK_BASE_URL', process.env.ARK_BASE_URL],
  ] as const) {
    if (url && /\/(api\/coding|api\/plan)(\/|$)/.test(url)) {
      throw new Error(`${name} points at a subscription-plan endpoint: ${url}`);
    }
  }
}

// 智谱端点：standard = /api/paas/v4；plan = /api/coding/paas/v4
const zhipu = createProvider({
  id: 'zhipu',
  name: 'Zhipu',
  baseUrl: process.env.ZHIPU_BASE_URL ?? (plan
    ? 'https://open.bigmodel.cn/api/coding/paas/v4'
    : 'https://open.bigmodel.cn/api/paas/v4'),
  auth: {
    apiKey: {
      name: 'Zhipu',
      resolve: async () => ({ auth: { apiKey: process.env.ZHIPU_API_KEY! } }),
    },
  },
  models: [/* glm-5.3-flash，compat 见 §6.4 */],
  api,
});

// 火山端点：standard = /api/v3；plan = /api/plan/v3
const ark = createProvider({
  id: 'ark',
  name: 'Volcengine Ark',
  baseUrl: process.env.ARK_BASE_URL ?? (plan
    ? 'https://ark.cn-beijing.volces.com/api/plan/v3'
    : 'https://ark.cn-beijing.volces.com/api/v3'),
  auth: {
    apiKey: {
      name: 'Ark',
      resolve: async () => ({ auth: { apiKey: process.env.ARK_API_KEY! } }),
    },
  },
  models: [/* doubao-seed-2-1-lite-260915，compat 见 §6.4 */],
  api,
});

const models = createModels();
for (const provider of [zhipu, ark]) models.setProvider(provider);
```

✅ 2026-11-16 实测：`samplingParams: { response_format: { type: 'json_object' } }` 会被原样合并进 OpenAI 兼容请求体，智谱（Coding Plan）、火山（Agent Plan）都返回 HTTP 200 和合法 JSON。**结构化输出由网关中间件统一设置，业务层不直接拼 `response_format`**（§2.3）。

模型对象至少要写 `id` / `name` / `api` / `provider` / `baseUrl` / `input` / `cost` / `reasoning` / `contextWindow` / `maxTokens`；视觉模型的 `input` 要含 `'image'`。`baseUrl` 在 provider 和 model 两处都有，必须一致。

✅ `createProvider()` 官方定位就是「local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint」。

> **备用智谱 Key 用独立的 `zhipu-backup` provider**：`baseUrl` 和 `auth` 是 provider 级的，不能把标准按量 Key 塞进同一个 provider 的 `models` 数组。主 Key 配额耗尽时按 §6.5 的兜底链切过去。

> **不要用 pi-ai 内置的 `zaiProvider()` 跑运行时**：它的 `baseUrl` 是 `https://api.z.ai/api/coding/paas/v4`，与本次 `open.bigmodel.cn` 的 Coding Plan 账号不是同一套域名。智谱走上面的自定义 provider：plan 指 `open.bigmodel.cn/api/coding/paas/v4`，standard 指 `open.bigmodel.cn/api/paas/v4`。

### 6.4 `compat` 必须显式声明 🔴

✅ **`compat.supportsStrictMode` 对自定义/未知 endpoint 默认 `false`**。智谱、火山都走 OpenAI 兼容路径，都属于「未知 endpoint」，所以：

- `constrainedSampling: { strict: 'require' }` → **直接失败**
- `strict: 'prefer'` → **静默降级成普通 tool calling**，你以为有约束其实没有

🔷 **本项目默认显式 `constrainedSampling: false`**，约束靠闸门不靠提供方。待 VERIFY V2 有结论再改。

两个上游的 `compat` 不能共用一套（✅ V5 已逐项实测）：

| 提供方 | 必设 `compat` | 关键原因 |
| --- | --- | --- |
| 智谱 `glm-5.3-flash` | `thinkingFormat: 'zai'`；`supportsReasoningEffort: true`；`maxTokensField: 'max_tokens'`；`supportsStrictMode: false`；`supportsStore: false`；`supportsDeveloperRole: false`；`supportsUsageInStreaming: true` | ✅ 实测：无 effort → `thinking:disabled` 接受；`reasoningEffort:'max'` 接受；`json_object`、`max_tokens`、强制工具均可用（明细见 VERIFY V5） |
| 火山 `doubao-seed-2-1-lite-260915` | `thinkingFormat: 'deepseek'`；`supportsReasoningEffort: true`；`maxTokensField: 'max_tokens'`；`supportsStrictMode: false`；`supportsStore: false`；`supportsDeveloperRole: false`；`supportsUsageInStreaming: true` | ✅ 实测：`thinking:disabled` 接受，reasoning 归零、约 0.8s；`json_object` 与 `json_schema strict` 都 200（明细见 VERIFY V5） |
火山 Chat API 同时接受 `max_tokens` 与 `max_completion_tokens`，**两者不能同设**；本项目两家统一用 `max_tokens`（只限最终回答，思考长度不占这个额度），结构化调用给足额度；截断按失败处理，不 repair。

**任务类 → 思考策略**（网关按任务类强制，不交给调用方随手传）：

- `vision.extract` → GLM，默认不传 `reasoningEffort`（thinking off；图片 + `json_object` 20 张实测 p50 ≈4.3s，强制工具约 6s）；schema/闸门判失败时同一请求升到 `'max'` 重试一次。备用 Key 的 `glm-4.6v-flash` 429 高发且结构化输出未验证；Doubao 视觉兜底不传 `reasoningEffort`（实测图 + `json_object` 约 2.6–3.2s）。
- `reason.explain` / `reason.plan` → Doubao，默认不传 `reasoningEffort`（思考关闭，省延迟）；GLM 末位兜底时传 `'max'`，先把请求跑通。
- `fast.intent` → Jev 原生 decision transport，不适用 Chat `compat` 或 `reasoningEffort`；网络/协议失败的 Doubao 备选不传 `reasoningEffort`。含糊表达走用户确认。
- `fast.normalize` → Doubao，不传 `reasoningEffort`；自由文本归一仍需要生成模型。GLM 默认不进这条链。
- 跨提供方重试时，`reasoningEffort` 按**目标提供方**重新映射，不沿用上一个提供方的值。

其余还要验：`supportsMidConvoSystemMessages`（durable 会在对话中途插 system message 改工具集，两家认不认）、`supportsUsageInStreaming` 的实际行为。

### 6.5 跨提供方兜底 ✅

pi-ai 原生支持 **Cross-Provider Handoffs**：同一段对话换提供方时自动转换消息——

- user / toolResult 原样透传
- 同 provider+api+model 的 assistant 消息保留（含 thinking）
- **不同模型的 assistant 消息丢弃 thinking 块**（签名与加密推理只对产出它的模型有效；可读 thinking 当纯文本发会让新模型当成回复的一部分）
- tool call 与普通文本原样保留

**但它的触发条件是「运行时更换 model/provider」。** 如果网关只是一个 `createProvider()` 的 custom provider，pi-ai 只看到一个 provider，**不会自动 handoff**。落地二选一：

- **A（本项目）**：网关对每个上游暴露一个 model ID，runtime 在兜底时切 model；pi-ai 负责消息转换。
- **B**：网关内部自己实现 fallback 与消息转换，pi-ai 仍只看到一个 provider。

文本/视觉有智谱、火山两个主上游（智谱另有可选备用 Key），通过 A 方案做 handoff。Jev 使用独立 decision transport，只接收相关 state 与有限问题，不沿用 Chat 的对话转换；下面分别列出任务级兜底：

| 任务类 | 兜底链 | 约束 |
| --- | --- | --- |
| `vision.extract` | GLM-5.3-Flash（首选，`json_object`）→ Doubao 2.1 Lite | 图片只发 GLM/Doubao；两个都不通时 `NoModelAvailable` |
| `reason.explain` / `reason.plan` | Doubao 2.1 Lite → GLM-5.3-Flash（末位） | 每一跳都要能按目标提供方重新映射思考参数；GLM 末位用 `reasoningEffort: 'max'` |
| `fast.intent` | Jev `jev-latest` → Doubao 2.1 Lite（仅网络/协议失败） | Jev 用独立 decision transport；unknown/含糊结果走确认，不强制换模型猜答案；fallback 共用剩余 deadline |
| `fast.normalize` | Doubao 2.1 Lite（thinking off） | 自由文本归一；GLM 默认不进这条链 |
| `decision.poi_match` / `decision.preferences` / `decision.reason` | Jev `jev-latest` | 失败交还应用端走手工确认/结构化输入/确定性理由模板，不默认追加一次生成调用 |

> **`ZHIPU_BACKUP_*` 是可选的同提供方备用 Key，不在默认兜底链里。** 2026-11-16 实测 `glm-4.6v-flash` 连续返回 429（code 1305「该模型当前访问量过大」），只适合在主 Key 配额耗尽时尝试，且必须设短超时；遇 429 立即落到 Doubao，不要重试成主路径。

网关切换前检查目标模型能力（vision / reasoning / tool calling），不把图片或工具历史发给不支持的目标。V5 验证的是每个 `createProvider` 的 `compat` 实际接受哪些字段，不是 handoff 语义。

### 6.6 测试 ✅

`fauxProvider()` 建内存 provider + 脚本化响应 → **回放不烧钱**，可测闸门打回、兜底链、崩溃恢复。另加两类结构化输出测试：① 脚本化一个缺字段/类型错的 `candidates.propose` 参数，断言 Harness 回 `invalid_arguments` 且 `execute()` 不被调用；② 给 `prepareArguments` 塞字符串化数组/数字字符串，断言修复后通过 pi-schema 校验。

完整测试矩阵（单元 / 属性 / 集成 / E2E / 模型评测 / 变异 / 安全）与命令见 [ENGINEERING §3.3](./ENGINEERING_工程化基线与Skill分工.md)；`pnpm test` 必须先过 skip 门禁，防止集成测试没起环境时整组跳过还退 0。

---

## 7. 契约与类型

### 7.1 pi-schema 单一真源，不用 Zod 🔷

✅ `pi-schema` 1.5.2：**零依赖**，JSON Schema 原生，drafts 2020-12 与 7，**编译成普通闭包、无 eval**（keywords 含 `csp`），`Static` 直接推出 TS 类型。**它不是 Zod。**

✅ pi-ai 与 durable 都接受三种写法：pi-schema builders、TypeBox、手写 JSON Schema。`defineTool()` 用 pi-schema builders 时 `args` 有类型；其他 JSON Schema 给 `unknown`。

🔷 **决定：用 pi-schema builders 作为唯一真源。** 工具参数、`structuredOutputSchema`、`defineDoc`、契约全部同一套。

放弃「Zod + `z.toJSONSchema()` 桥接」：少一个依赖、少一次转换、少一处不一致。

```ts
import { obj, str, num, arr } from '@earendil-works/pi-schema';
import { StringEnum } from '@earendil-works/pi-ai';

const PoiSchema = obj({
  poi_id: str(),
  name: str(),
  location: str(),                       // "lng,lat"，GCJ-02
  cost: num(),
  opentime_today: str(),
});
// obj() 默认闭合：additionalProperties: false
```

✅ **用 `StringEnum` 而非 `oneOf`/`const`**：pi-ai README 明确说 Google 拒 `anyOf`/`const`，`StringEnum` 产出 `{type:"string", enum:[...]}`，全提供方通吃。

### 7.1.1 结构化输出：pi-durable 自带什么，什么要自己写 🔷

**结论：pi-durable 自带「工具参数/工具结果」的 schema 校验，不自带「模型自由文本」的 JSON 解析、校验与修复。**

| 层 | pi-durable 1.5.2 | 我们要做什么 |
| --- | --- | --- |
| 工具参数 | ✅ `Tool.parameters` 是 JSON Schema；Harness 在 `execute()` 前用 pi-ai `validateToolArguments` 校验并 coerce（字符串数字、单值转数组等）。失败变成 `invalid_arguments` 工具错误，模型可重试 | 用 pi-schema 定义 `candidates.propose`、`vision.extract` 等工具参数；必要时用 `prepareArguments` 做确定性修复 |
| 工具返回值 | ✅ `structuredOutputSchema` 校验工具返回的 `structuredOutput`，给嵌套工具/程序调用；**不是**模型文本 | 只有程序要读工具结果时才用 |
| 模型自由文本 | ❌ 不自动解析、不自动校验、不自动修复 | `JSON.parse` → pi-schema `compile().validate()` → 业务闸门；语法失败最多 1 次修复 |
| provider 侧 `json_schema` | ⚠️ pi-ai 有 `constrainedSampling: { type:"json_schema" }`，但 custom endpoint 默认 `supportsStrictMode:false`；`require` 直接失败，`prefer` 静默降级 | 不把它当闸门；本项目显式 `constrainedSampling:false`，校验在应用侧 |

**关键设计：能走工具调用就不要让模型吐 JSON 文本。** `candidates.propose` 用工具参数 schema，pi-durable 在 `execute()` 前校验；非法参数直接回 `invalid_arguments`，模型下一轮可改。应用侧 `checkProposal` 继续校验业务不变量（不是类型校验）。只有 `vision.extract` 这种「一次抽取、不写状态」的路径才走 `json_object` + 本地 schema + 一次修复。

⚠️ **校验 API 用 `compile().validate()`，不是 `compile().parse()`**（1.5.2 包类型已核对）：`compile(schema)` 返回的 `Validator` 只有 `check()` / `errors()` / `validate()`——`validate()` 原样校验，不克隆、不填默认值、不做隐式转换。`parse()` 只存在于 `compile(schema, {coerce: true})` 的 `CoercingValidator` 上，会先 coercion（数字字符串→number、单值→数组等）。**本项目不启用隐式 coercion**：模型自报的松散类型按失败处理，不由校验层悄悄「修好」。工具参数路径的 coerce 是 Harness `validateToolArguments` 自己的事，与这条无关。

**heirloom-lite 的做法（对照，不照抄）：**

- `provider-transport.ts` 只发 `response_format: { type: "json_object" }`（Agent Plan Responses 发 `text.format`），**从不发 `json_schema`**。
- `memoir-use-case-strategy.ts` 先 `sanitizeStructuredContent`，再用 `salvageMalformedJson` 做确定性抢救（未转义控制符、尾逗号等免费修好）；仍不是 JSON 对象才发 **1 次**低温 repair，repair prompt 明确禁止改写正文。
- 解析后用 Zod `safeParse`/`parse` 做字段级校验（dynamic outline、correction、audit parsers 等），失败按字段反馈重试或拒稿。
- 对 `doubao-seed-2-1-lite` 显式控制 `thinking.type`（deepseek 分支），不靠混合模型的默认思考档；目录规划等低延迟任务显式关思考。

**判断：方向对，但不是最强。** `json_object` + 本地 schema 是正确姿势，比假装 `json_schema` 生效安全；heirloom 用 Zod 一套 schema 同时定义工具参数和校验器，但 prompt 里的字段说明和 Zod schema 是两套，容易漂移；repair 多一次模型调用。本项目用 pi-schema 一套 schema 同时定义工具参数和校验器，关键写入路径走工具调用，少一层漂移。

**heirloom-lite 的具体改造清单**（公共 helper、关键路径补 Zod、灰度与测试）见 [HEIRLOOM_结构化输出改造建议.md](./HEIRLOOM_结构化输出改造建议.md)。

### 7.2 品牌类型 🔷

**坐标系混用会静默偏移约 500m**，类型系统必须拦住：

```ts
type Gcj02 = string & { readonly __coord: 'gcj02' };   // 高德 / 国内地图
type Wgs84 = string & { readonly __coord: 'wgs84' };   // GPS 原始 / 国际标准
```

`geo.convert` 负责 **WGS-84 / 百度 / mapbar → GCJ-02**（官方 `/v3/assistant/coordinate/convert` 一次最多 40 对）。✅ 官方只支持**转入高德坐标**，不提供 GCJ-02 → WGS-84 的反向接口；本项目不需要反向转换，若未来需要则必须自研并做误差测试。**任何接受坐标的能力都必须在签名里声明坐标系**，不许裸 `string`。

同理品牌化：`PoiId`、`SessionId`、`Revision`、`IsoTimestamp`。

### 7.3 ✅ 关键字黑名单（智谱/火山按最严处理）

| 类型 | **禁用** |
| --- | --- |
| `number`/`integer` | `multipleOf` |
| `array` | `uniqueItems`、`contains`、`minContains`、`maxContains`、`additionalItems` |
| `object` | `patternProperties`、`propertyNames` |

⚠️ 另两条语义陷阱：
- `$defs` + `$ref`：**本地引用支持**（`#/$defs/address`），**外部 URL 引用不报错但不生效**
- **`oneOf` 不严格保证 exactly-one 语义**

🔷 **直接执行**：「绝不凑三个」用 **`maxItems: 2`**（支持）表达备选数量上限，**不用 `uniqueItems`**。

完整支持表见 [VERIFY §2.4](./VERIFY_待验证清单.md)。

### 7.4 证据快照字段 🔷

每条 POI 证据必须带：

```ts
{
  provider: 'amap',
  fetched_at: IsoTimestamp,
  status: 'verified' | 'estimated' | 'unknown' | 'stale',
}
```

**`estimated` 与 `verified` 不许混同展示。** ETA 是估算（`estimated`），POI 存在性是查证（`verified`），营业时间过期是 `stale`。UI 必须能区分，闸门必须拒绝把 `unknown` 当 `verified` 用。证据还要带 `source`（`amap` / `official` / `user`）与 `policy_status`（预约/开放策略）。

### 7.5 提案契约：闸门的唯一输入 🔷

**权威字段定义在 [`packages/core/src/contracts.ts`](./packages/core/src/contracts.ts)**；这里说明边界，不再维护另一套独立 schema。模型输入与服务端结果分别校验，模型最终答案不作为契约。

| 契约 | 当前脚手架的形状与责任 |
| --- | --- |
| `ModelProposalInputSchema` | `{ best, alternatives }`；每项仅 `{ poi_id, reason_code, reason_text }`，最多两个备选。模型不提供时间、证据或版本。 |
| `RecommendationPickSchema` | `{ choice, travel_to_min, travel_to_next_min, stay_min_estimate, buffer_min, evidence }`；`choice` 为模型可提供的定性字段，其余由服务端能力与策略注入。没有下一站时 `travel_to_next_min=null`。 |
| `BindingSchema` | `{ session_id, proposal_id, proposal_revision, pool_revision, eta_revision, trip_id, trip_revision }`；全部由服务端生成。无绑定行程时只允许 `trip_id=null, trip_revision=0`；有行程时必须有 ID 和正整数修订号。 |
| `RadarOutcomeSchema` | `kind:'recommendations'` 带 binding、best、alternatives；`kind:'empty'` 只带 binding 与 `reason_code:'NO_FEASIBLE_OPTION'`，不含 best。 |

- **空结果由应用端确定性生成**：可行集为空时不调用模型凑首选。`empty` 是正常业务响应；只有 `recommendations` 才需要 best。尚未生成结果用 `outcome:null`，与「已计算且无候选」区分。
- 模型输入是闭合对象，额外的 `binding`、时间与证据字段会被拒绝。`reason_text` 仍可能包含虚构数值或断言，因此完整业务闸门还必须检查理由与证据；不能仅靠字段分离保证文本真实。
- 当前 `evidence` 只表达高德 ETA 的估算来源与采集时间，不代表开放/预约政策已验证。完整证据、排除原因、体验类别与历史展示在业务闭环中扩充权威 schema；这部分尚未实现。
- `candidates.propose` 的工具注册、服务端 `buildProposal`、完整 `checkProposal` 与 GET/SSE/accept 都是下文的设计目标。当前仅有共享契约、绑定检查和会话隔离持久化适配，不能据此宣称业务闸门已上线。
- `obj()` 默认闭合；禁用 `multipleOf` / `uniqueItems` / `contains` / `patternProperties` / `propertyNames`（§7.3）。

---

## 8. 状态与存储

### 8.1 快照与提案：按 radar session 键控的 doc family 🔷

**业务实现目标：`candidate_pool` / `eta_snapshot` / `proposal` 都使用 `defineDocFamily`，key = `session_id`。** 雷达每开一次 session 就有自己的池、ETA 快照与提案，验证证明不能跨 session 或修订复用（§9.2）。✅ 1.5.2 有 `defineDocFamily`：family 成员用 `tx.doc(token, conversationId, key, seed)` 访问，`initial(seed)` 只在成员缺席时运行。

**当前脚手架**在 [`apps/server/src/runtime/documents.ts`](./apps/server/src/runtime/documents.ts) 实现 `nextstop.radar_result` family（key=session_id），成员是 `{outcome:null|RadarOutcome, validated:null|ProposalBinding}`。这是契约与持久化的最小落点，尚未拆出下列候选池/ETA/提案工具文档，也未注册任何模型工具。下列代码和表格为后续业务设计；`ProposalState` 的语义为 `{outcome: RadarOutcome|null}`。

```ts
const CandidatePool = defineDocFamily<CandidatePoolState, SessionId>({
  kind: 'nextstop.candidate_pool',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',        // ← 支持 snapshotAsOf() 回放
  fork: 'current',
  initial: (session_id) => ({ session_id, revision: 0, pois: [], evidence: [] }),
  checkpointWhen: () => false,
});

const EtaSnapshot = defineDocFamily<EtaState, SessionId>({
  kind: 'nextstop.eta_snapshot',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: (session_id) => ({ session_id, revision: 0, byOrigin: {}, fetched_at: null }),
  checkpointWhen: () => false,
});
```

```ts
const Proposal = defineDocFamily<ProposalState, SessionId>({
  kind: 'nextstop.proposal',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ outcome: null }), // 尚未计算；真实 empty 结果仍须完整 binding
  checkpointWhen: () => false,
});
```

其余 doc / doc family：

| 文档 | scope | 说明 |
| --- | --- | --- |
| `nextstop.wishlist` | conversation singleton | 已确认地点 + 来源引用 + 状态（wishlist/planned/visited/hidden） |
| `nextstop.trips` family（key=trip_id） | conversation | 行程 + `ItineraryStop` + 锁定项 + `revision`；多行程不新建 conversation |
| `nextstop.import_batch` family（key=batch_id） | conversation | 导入状态机、逐图进度、candidate_place、确认结果 |
| `nextstop.source_asset` family（key=asset_id） | conversation | 对象存储 key、OCR 摘要、retention、删除状态 |
| `nextstop.radar_session` family（key=session_id） | conversation | 一次雷达输入、状态、revision、快照引用；`validated` 证明（应用端字段，见 §9.2） |
| `nextstop.candidate_pool` family（key=session_id） | conversation | 本 session 的候选池 + 证据；闸门 POI 白名单来源 |
| `nextstop.eta_snapshot` family（key=session_id） | conversation | 本 session 的 `by_leg` ETA 快照 + `fetched_at` |
| `nextstop.proposal` family（key=session_id） | conversation | 本 session 的当前提案；闸门输入、前端渲染、推荐历史 |
| `nextstop.rejections` | conversation singleton | 拒绝事件 + reason_code + 当次/长期作用域 |
| `nextstop.preferences` | conversation singleton | 软评分权重 + 长期偏好（显式同意） |
| `policy.json` | **应用侧只读 JSON**（不是 doc） | 策展的预约/开放策略表；全局一份，`policy.lookup` 读取，不随用户数据删除 |
| `nextstop.audit` family（key=event_id） | conversation | 关键写入审计（可选，脱敏） |

**会话与 scope 的硬决定**：**一个匿名用户 = 一个长期 conversation + 一个 SQLite 文件**。HTTP 侧的匿名 cookie 映射到该文件；用户新建行程用 `nextstop.trips` family，不新建 conversation 也不新建文件。所有用户数据用 conversation scope；`policy.json` 不进 SQLite，放应用侧只读 JSON。**不要**把 trip/wishlist 放 session scope，也不要把多个匿名用户塞进同一个库文件——前者会串数据，后者让「删除我的数据」无法真正清掉 transcript。

**这个决定的代价**：conversation 会长期增长，transcript 和 `rewindable` proposal 历史都会膨胀；必须开 compaction、给历史设保留上限。单写者也不能靠多副本水平扩容。容量规划与退出条件见 [ENGINEERING §1.4](./ENGINEERING_工程化基线与Skill分工.md)。

用 `HarnessOptions.conversationCreated(tx, conversation)` 保证**每个新会话都拿到这些单例 doc**。✅ 原文：它在**每个创建或 fork 会话的 commit 里**运行，包括工具直接调 `tx.createConversation()` 的情况。family 文档在第一次使用时创建；`policy.json` 由应用在启动时读，不 seed 进 doc。实体映射见 §8.5。

#### ✅ 这两个快照天然不会被延迟落盘

durable 有「延迟持久化」优化，但**只对「除已有 doc 外什么都没改、且那些 doc 是 `history:"latest"` + `fork:"initial"`」的 commit 生效**。

我们的快照是 **`rewindable` + `current`** → **不满足条件 → 每次 commit 立即落盘**。

含义：**「零 API 重排」依赖的快照是崩溃安全的**，不会踩到官方那句警告——「A crash loses what was not stored yet, so derive nothing durable from such a value outside a commit that reads it.」这是选 `rewindable` 的一个额外收益，不只是为回放。

`fork` 的三个合法取值：✅ `"initial"` / `"current"` / `"asOf"`。

### 8.2 零地图 API 重排 🔷

**拒绝一个候选 → 重排不需要重新调地图。**

因为 `candidate_pool` 和 `eta_snapshot` 已存在 doc 里：

```
用户拒绝 poi_x（reason_code）
  → 写 nextstop.rejections
  → candidates.screen 用同一份 eta_snapshot 重算 feasible
  → candidates.rank_by_weights 重排
  → 新的三选一提案
```

**全程 0 次地图 API 调用**——但有条件，不能无条件宣称：

| 拒绝原因 | 是否 0 次 | 说明 |
| --- | --- | --- |
| 不感兴趣 / 已去过 | ✅ 0 | 写 exclusion，重跑 screen + rank |
| 太远 | ✅ 0 | `constraints.apply_rejection` 降低可接受绕路阈值，快照仍有效 |
| 太贵 | ✅ 0（若价格已知） | 预算过滤；价格未知则不冒充已知，转软评分 |
| 不想走路 | ❌ 需重查 | 换出行方式会使 ETA 快照失效；必须重新批量查 |
| 位置显著移动 | ❌ 需重查 | origin 变了 |
| `fetched_at` 过期（建议 5 分钟） | ❌ 需重查或标 `stale` | 接受前必须复核（PRD TC-15） |

`constraints.apply_rejection(reason, constraints)` 是纯函数（§5.1），把 PRD §8.5 的映射表落成代码；模型只负责把自由文本分类成 `reason_code`（`fast.intent`），不负责改阈值。

**接受前复核**：用户接受某个提案时，app 检查 `eta_snapshot.by_leg.to_candidate/to_next/origin_to_next` 的 `fetched_at` 与 mode；过期/模式变化 → 重新批量查或明确提示「路线未重新校验」，不得直接把 stale ETA 写进行程。

快照失效条件：用户位置显著移动、时间窗口变化、出行方式变化、`fetched_at` 超过 TTL。阈值先按 5 分钟 ETA / 同一天营业时间落地，后续再调。

### 8.3 ✅ 五种存储后端与单写者约束

| 后端 | 导入 | 备注 |
| --- | --- | --- |
| Memory | `MemoryStorage`（包根） | 不持久化，测试用 |
| IndexedDB | `pi-durable/storage/indexeddb` | 浏览器；**一个持有者**，用 Web Lock；`navigator.storage.persist()` |
| **SQLite** | `pi-durable/storage/sqlite/node` | **每匿名用户一个文件；WAL + `synchronous=NORMAL`：进程崩溃可存活，断电/宿主故障可能丢最新一条** |
| JSONL | `pi-durable/storage/jsonl/node` | 追加文件；**整个历史也驻内存**，长跑用 SQLite |
| Cloudflare DO | `pi-durable/storage/sqlite/cloudflare` | 一个 SQLite-backed Durable Object；commit 即其存储事务 |

**✅ 硬约束：一个存储同时只能一个进程写，没有跨进程锁。**

🔷 **进程划分（默认单进程，按用户分片）：**
- **写者 + HTTP + SSE 同进程**：一个 Node 进程持 Harness，跑循环、闸门、导入流水线、对象存储读写；应用端直接 `commit`，不跨进程。
- **存储分片**：**每个匿名用户一个 SQLite 文件**（`data/users/{guest_id}.sqlite`），该文件里只有一个长期 conversation。一个进程可以同时持有多个文件的 Session，但每个文件仍只有一个写者。这样「删除我的数据」才能删掉整个文件（含 transcript），也天然隔离多用户。
- **读者进程只在确需拆分时使用**：`readOnly: true` 打开 → 任何 write / resume / task-run 都 reject `ReadOnlySession`。但**它看不到写者进程的内存提交**；跨进程实时性要靠写者进程的 SSE/轮询桥接，不是 `harness.watch()`。
- ⚠️ `readOnly` 覆盖的是 **Harness**，不是它之前的 storage open：**JSONL 必须另外传 `{readOnly:true}`**（可写打开会修复写者正在追加的文件）；**SQLite 照常打开即可**（文件锁保证与写者共存安全）。

订阅：`harness.watch()` / `watchDoc()` / `observeCommits()` 是**进程内**观察者；应用端把它们桥接成 SSE（或 500ms 轮询 doc revision）。需要与 chord 视图同步时用同步观察者 `observeConversation` / `observeDoc` / `observeTaskGraph`（**`advance` 只记录变更：无 await、无 Harness 调用、不抛异常、要快**，因为每个 commit 都等它）。**浏览器不直接打开 harness，也不读 SQLite。**

表名可加前缀共享数据库：`{ prefix: "pi_" }`。⚠️ **改前缀不迁移已有数据。**

**对象存储**：图片原图与规范化副本放本地卷（Demo）或 S3/OSS（生产）；`source_asset` doc 只存 key + 元数据。删除/留存见 §10.6。**默认按匿名用户分片 SQLite**：一个用户一个文件、一个写者；不要多个用户共用一个文件，也不要多个进程写同一个文件。

### 8.4 部署可移植性 🔷

✅ `/storage/sqlite` 与 `/storage/jsonl` 的**可移植核心不依赖 Node API**，给一个异步 `SqliteDatabase` facade 或 `FileSystem`（来自 `pi-durable/env`）就能跑 Bun / Cloudflare Durable Object。

| 部署形态 | 适配器 |
| --- | --- |
| 云服务器（有持久卷） | `openNodeSqliteStorage(file)` |
| Cloudflare Durable Object | `openDurableObjectSqliteStorage(ctx.storage)` + `onWake` + `ctx.storage.setAlarm`（README 有完整示例） |
| 无持久卷的其他 SaaS | 外部数据库 + 自定义 facade，跑 `registerStorageConformance()` |

🔴 **`heirloom-lite` 跳板机的持久卷可用性未验（VERIFY V9）。** 默认按第一行（云服务器 + 持久卷）设计；上机实测后若不成立，只换适配器，不动架构。

### 8.5 实体映射：PRD 数据模型 → doc / 对象存储 🔷

| PRD 实体 | 落点 | 约束 |
| --- | --- | --- |
| `UserOrGuest` | 匿名 cookie → guest_id → 一个 SQLite 文件 + 一个 conversation | 不建账号；服务端随机 ID |
| `Trip` | `nextstop.trips` family（key=trip_id） | 一个 conversation 多 trip；`revision` |
| `ImportBatch` | `nextstop.import_batch` family（key=batch_id） | 状态 uploaded/parsing/needs_review/confirmed/failed |
| `SourceAsset` | `nextstop.source_asset` family（key=asset_id）+ 对象存储 | 原图/规范化副本；`retention_deadline`；删除状态 |
| `PlaceCandidate` | `import_batch` 内的 `candidates[]` | raw_name / evidence / confidence；**不等于 Place** |
| `Place` | `nextstop.wishlist` 的 `places[]` | 唯一性 `provider + provider_poi_id`；坐标品牌类型 |
| `SavedPlace` | `wishlist.places[]` 的状态字段 | 多来源指向同一 Place；来源删除不自动删 Place |
| `ItineraryStop` | `trips` 内的 `stops[]` | `is_locked` / `origin=radar\|import` / `status` |
| `RadarSession` | `nextstop.radar_session` family（key=session_id） | 输入、状态、revision、快照引用 |
| `Recommendation` | `nextstop.proposal` + `eta_snapshot`（均 key=session_id） | 排名/证据/排除原因/时间构成 |
| `PreferenceEvent` | `nextstop.rejections` + `nextstop.preferences` | `scope=current_trip\|long_term`，长期需确认 |
| `AuditEvent` | `nextstop.audit` family（key=event_id） | 关键写入；脱敏；可选 ring buffer |
| （策展）预约/开放策略 | 应用侧只读 `policy.json` | `source` + `verified_at`；不是用户数据，不随用户删除 |

**POI 去重**：`provider + provider_poi_id` 优先；名称+坐标只作次级匹配。`candidates.recall` 合并收藏与附近时保留 `source` 与 `fetched_at`，不覆盖已验证证据。

### 8.6 应用端 API 与 SSE 🔷

浏览器只和应用端说话；应用端是唯一能读 Harness/写 doc 的进程。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/sessions` | 匿名会话；Set-Cookie → guest_id（映射到该用户的 SQLite 文件与 conversation） |
| `POST` | `/api/v1/import-batches` | 上传（multipart）/创建批次 |
| `GET` | `/api/v1/import-batches/{id}` | 进度与 candidate/place 列表 |
| `POST` | `/api/v1/import-batches/{id}/confirm` | 统一确认；幂等键 |
| `POST` | `/api/v1/trips` | 创建行程（可带锁定项） |
| `POST` | `/api/v1/trips/{id}/draft` | 生成草案；返回 draft revision |
| `POST` | `/api/v1/trips/{id}/lock` | 锁定/解锁；乐观锁 revision |
| `POST` | `/api/v1/radar/sessions` | 启动雷达；返回 session_id |
| `GET` | `/api/v1/radar/sessions/{id}` | 当前状态 + 通过闸门且**绑定本 session** 的 proposal（含 `kind=empty` 空态） |
| `GET` | `/api/v1/radar/sessions/{id}/events` | **SSE**：status/proposal.updated/import.progress/error；`proposal.updated` 携带验证证明绑定（§9.2） |
| `POST` | `/api/v1/radar/sessions/{id}/reject` | 拒绝原因；服务端 `constraints.apply_rejection` 后重排 |
| `POST` | `/api/v1/radar/sessions/{id}/accept` | 用户确认；`Idempotency-Key`；**事务内核对** session_id + proposal revision + 快照版本 + trip revision，防陈旧接受（§9.2/§9.4）；写 trip + 返回导航入口 |
| `DELETE` | `/api/v1/trips/{id}` | 删除行程（含图片/派生数据，见 §10.6） |
| `DELETE` | `/api/v1/me/data` | 删除当前匿名用户全部数据 |

约定：请求/响应带 schema 版本与 `request_id`；写操作带 `Idempotency-Key`；失败码沿用 PRD（`VALIDATION_ERROR` / `POI_AMBIGUOUS` / `ROUTE_UNAVAILABLE` / `NO_FEASIBLE_OPTION` / `PROVIDER_RATE_LIMIT` / `CONSENT_REQUIRED`）。**SSE 只推通过闸门且属于本 session 的 proposal**；未通过闸门的模型输出不进入前端。GET/SSE/accept 读取的都是 `proposal` family 里 `key={id}` 的成员，绝不把别的 session 或旧 revision 的 `validated` 结果当成当前结果下发。

---

## 9. 提交闸门与不变量

### 9.1 不变量清单 🔷

闸门必须**确定性重验**以下每一条，不信任模型输出：

| 不变量 | 校验方式 |
| --- | --- |
| **提案来源唯一** | 只校验 `nextstop.proposal` family 中 `key=session_id` 的成员；最终答案/`structuredOutput` 不作为契约 |
| **提案归属本会话** | `proposal.outcome.binding.session_id` 必须等于当前 radar session；`candidate_pool`/`eta_snapshot` 也只读本 session 的 family 成员——旧 session 的提案、快照、`validated` 一律不认 |
| **POI 白名单** | 提案里每个 `poi_id` 必须在本 session 的 `candidate_pool` 快照里存在，且 `provider_poi_id` 能对上 |
| **空结果是合法判别分支** | `kind=empty` 不要求 `best`，确定性确认可行集为空并校验 binding / reason_code；`kind=recommendations` 才要求 `best` + ≤2 备选。排除明细契约待扩充 |
| **绝不凑三个** | 1 个最佳 + **最多** 2 个备选；可行集不足就少给，`maxItems: 2` |
| **理由里不许出现数字** | 结构上 `reason_text` 没有数字字段；数值由能力层填；再做一次「分钟/元/公里/阿拉伯数字」文本断言作为兜底 |
| **数值来源可追溯** | `travel_*` / `stay_*` / `buffer` 必须来自 `eta_snapshot` / `place.estimate_stay`，且带 `fetched_at` |
| **锁定项不可动** | 提案不得修改 `trips.stops[].is_locked` 的任何项 |
| **硬约束优先于软评分** | 时间/路线/预约/预算不满足 → 直接排除，不进排序 |
| **类型差异** | 可行集类型数 ≥2 时，提案至少覆盖 2 个体验类型；由 `candidates.diversify` 保证 |
| **证据状态诚实** | `unknown` 不得当 `verified` 展示；`stale` 必须在 UI 可见 |
| **预约/开放策略** | `policy.lookup` 为 `required` 且用户无凭证 → 不得推荐「直接入内」；`unknown` 不得当 `not_required` |
| **ETA 新鲜度** | 接受前若 `eta_snapshot` 超过 TTL 或模式变化 → 重查或显式提示「未重新校验」 |
| **验证证明绑定** | `radar_session.validated` 记录 `{session_id, proposal_id, proposal_revision, pool_revision, eta_revision, trip_id, trip_revision}`；GET/SSE/accept 只认与当前提案完全匹配的证明 |
| **不执行支付/订位/联系第三方** | 本阶段一律不执行（PRD 硬约束） |
| **导航与行程插入需用户确认** | 见 §9.3；app 执行，模型不可见写入工具 |

### 9.2 闸门落点：应用端 + `proposal` doc 🔷（取代 `onYield` 主路径）

**主路径不是 `onYield`。** 闸门是应用端的一个纯函数，输入是本 session 的 `nextstop.proposal` family 成员，不是模型的最终答案。

```
应用端收窄 modelTools 到只剩 candidates.propose（见下「单工具轮是运行时约束」）
  → 模型调 candidates.propose
  → 同一个 commit 里写 nextstop.proposal[key=session_id]
  → 工具返回 control: { terminate: true }（单独一轮），run 结束
  → 应用端读本 session 的 proposal / candidate_pool / eta_snapshot 成员
  → checkProposal(proposal, pool, trip, eta)   // 纯函数
       ├─ 合格 → radar_session.validated = 验证证明（§9.1）→ SSE 推前端 / 等用户确认
       └─ 不合格 → submit 修复指令（≤2 次）
                   或 确定性兜底（screen → rank → diversify，不经模型润色）
```

```ts
// 工具只写提案，不写行程；参数里没有任何数值/证据/版本字段（§7.5 输入 schema）
const propose = defineTool({
  name: 'candidates_propose',
  parameters: ModelProposalInputSchema, // 只有 best / alternatives；空集由应用端处理
  structuredOutputSchema: RadarOutcomeSchema, // 服务端注入后的结果
  replay: 'safe',
  execute: async (args, api, ctx) => {
    // buildProposal 在服务端注入 travel_*/stay_*/buffer/evidence 与
    // proposal_id/session_id/revision——模型自报的一律不采用
    const proposal = await api.commit(async (tx) => {
      // 伪代码：只用 tx 读取本 session 的池/ETA/trip，核对预期修订后构造结果。
      // 不在 commit 回调内调用 harness 读 API，避免读写队列相互等待。
      const current = await readProposalInputs(tx, api.conversationId, sessionId);
      const result = buildProposal(args, current);
      // ✅ 1.5.2 的 Tx 没有 set()：修改 Draft<T>。
      const draft = await tx.doc(Proposal, api.conversationId, sessionId, sessionId);
      draft.outcome = result;
      return result;
    }, ctx);
    return {
      output: [{ type: 'text', text: '提案已写入，等待应用端校验。' }],
      structuredOutput: proposal,
      details: { proposal_id: proposal.binding.proposal_id },
      control: { terminate: true },
    };
  },
});

// 应用端闸门（不是 hook）
export function checkProposal(
  proposal: RadarOutcome,
  pool: CandidatePoolState,
  trip: TripState,
  eta: EtaState,
): Violation[] { /* 纯函数，逐条 §9.1 */ }
```

⚠️ **`terminate` 是整轮语义**：同一轮里**每个**工具结果都要求 `terminate` 才结束；混合批次会继续跑。所以 `candidates.propose` 必须单独占一轮，不能和其他工具并行调用。

🔷 **单工具轮必须由运行时强制，不能只靠提示词。** 提案阶段把 `modelTools` 收窄到**只剩** `candidates.propose`；这只收窄工具面，不能保证模型恰好调用一次，也不能阻止它返回未声明的工具名。实现时必须在**整轮批次执行前**检查：恰好一次 propose 才执行；长度不为 1 或出现其他工具名则整批拒绝，不执行任何成员。单次 `beforeTool` 钩子不能代替整批检查；接入 pi-durable 时须验证具体批次拦截点。若发布版缺少该扩展点，就在模型传输适配层拒绝非法批次，不能只用单工具白名单宣称已保证。当前脚手架尚未接入这条执行路径。`radar_session.validated` 仍只由应用端 commit 写入，没有模型可见工具能更新它。

**应用端何时读 doc**：应用端 `submit()` 拿到 `Submission`，`await submission.wait(ctx)`；terminate 结束 run 后 promise 落定，再读 `nextstop.proposal`。**不要靠轮询 doc 猜 run 是否结束**；SSE 只负责把进度推给前端。run 失败/中止则不读旧 proposal，按 §9.4 兜底。

**为什么不用 `onYield` 当主闸门**：

1. **`terminate` 轮不经过 `onYield`**。1.5.2 源码：`finishToolRound()` 直接 `endRun()`；`onYield` 只在 `answer()`（最终答案）里调用。`candidates.propose` 正是 terminate。
2. **`onYield` 只拿到 assistant message**；提案在 tool result / doc 里，必须 `api.entries()` 反查，契约不如 doc 直接。
3. **被打回的中间答案会进 transcript**；前端订阅 entries 会看到「半个结论」，需要额外过滤。
4. **应用端闸门与「模型不能写用户状态」同一边界**：模型写 proposal（允许的 propose），app 校验并决定是否展示/写入；不依赖 hook 语义，V6/V7 不再是架构未定点。

**`onYield` 的保留用途**：只在**非终止**的最终答案路径做可选打回（例如答案里出现未授权的断言）；如果用，必须自己设上限（建议 2），并读 `api.entries()` 拿工具结果。它不是主闸门。

**打回上限**：应用端的修复循环也必须设上限（建议 2 次），存进 `nextstop.radar_session`；超限走确定性兜底。`maxTurns` 只约束工具轮次，不约束应用端 submit 循环，所以上限由我们自己记。

✅ 已查证（1.5.2 README + 源码）：
- `maxTurns` 触顶时该轮工具仍会跑完，run 以 `unanswered` + `turn_limit` 结束；答案不会被截断。
- `afterRun` 在最终答案或 terminate 轮之后运行，`onYield` 续跑期间不运行。
- `onYield` 在答案提交前调用；`{continue}` 时不会 `endRun`，提交等到最终答案；但中间答案会 `appendAssistant` 进 transcript。
- `terminate` 轮不经过 `onYield`；这是主闸门必须移出 hook 的直接原因。

#### 闸门的输入/输出

- 输入：本 session 的 `proposal` / `candidate_pool` / `eta_snapshot` family 成员、`trips.locked`、`policy` 证据。
- 输出：`Violation[]`；每条形如 `{ code, poi_id?, field?, repair_hint }`。
- 合格：应用端在 `nextstop.radar_session[key=session_id]` 写 `validated` **证明**——绑定 `{session_id, proposal_id, proposal_revision, pool_revision, eta_revision, trip_id, trip_revision}`，SSE 推 `proposal.updated`（携带该绑定）；用户确认后 app 执行写入。**validated 只由应用端 commit 写入，模型工具面没有任何入口。提案通过受限工具或应用端确定性兜底生成；验证证明与模型输入保持分离。**
- 不合格：应用端 `submit` 一条修复指令（带 `requestId`），或直接走确定性兜底；**不把未通过闸门的 proposal 推给前端**。
- **GET / SSE / accept 不得套用旧证明**：`validated` 只对 `{session_id, proposal_revision, 快照版本, trip_revision}` 完全匹配的当前提案有效；任一维度变了（新 session、修复出新 revision、快照重取、trip 被改）证明即作废，必须重新过闸门。
- **接受在事务内防陈旧**：`POST /accept` 在同一个 commit 里核对——`radar_session.validated` 与当前 proposal revision 匹配、`eta_snapshot` 未过期且 mode 未变、`trip.revision` 与请求期望一致；不匹配则拒绝（`VALIDATION_ERROR` 或显式「提案已变化，请重新确认」），不写半个行程。

### 9.3 用户确认放在 agent 之外 🔷（已定为设计，不是未决项）

1.5.2 的 `beforeTool` **不能 sleep**，`defineSignal` / `harness.signal()` 未发布。所以确认必须放在 agent 之外：

```
模型写 proposal doc + terminate
      ↓
应用端闸门通过
      ↓
SSE 推给前端（不写入）
      ↓
用户确认（接受 / 拒绝 / 改条件）
      ↓
应用端自己执行 trip.write / trip.lock / trip.undo / nav.launch
      ↓
（可选）submit 一条新输入告知结果
```

**保证「模型碰不到行程与用户数据写入」的机制**：

- 模型**可以**通过窄工具写本 session 的中间快照与方案态：`candidate_pool`、`eta_snapshot`、`proposal`（均 key=session_id），以及明确开放的进度字段。用户拒绝事件与长期偏好由应用端处理确认后写入；不向模型开放通用 doc 写入接口。
- 模型**不能**写 `radar_session.validated` 等应用端字段：`validated` 证明只由应用端 commit 写入，模型工具面没有任何入口（§9.2）。
- 模型**不能**写 `trip` / `wishlist` / 锁定项 / 用户凭据 / 策展 `policy`：这些是应用端函数，默认不注册成工具；模型在协议层看不到。
- 即使注册，也设 `callers: ["tools"]` 且不进 `modelTools` 白名单。✅ `modelTools` 只能收窄不能扩宽（`tools` 决定什么根本启用）。
- `proposal` doc 只是数据；模型没有 `trip.write` 的调用路径。

🔷 **V7 不再是未决项**：这是选定设计。需要验的只是应用端写 `trip` 的幂等键/乐观锁/HTTP 错误处理，不是 Pi 的 park/signal 能力。备选的「自定义 task + `sleepUntil` 轮询 doc」**不用做**。

### 9.4 幂等与并发 🔷

- **幂等键**：应用端为每次用户动作生成 `requestId`，`submit({..., requestId})`。✅ 同 id 返回同一 submission，重启后 `harness.submission(id)` 重取。
- **提案幂等**：`proposal.proposal_id` + `session_id` + `revision`；同一个 `requestId` 的修复不能生成两个 proposal。应用端读 doc 时以 `revision` 去重。
- **工具内幂等**：`api.memo()` 未发布 → 需要外部副作用幂等时，**把键存进 doc，在 commit 里读**。（当前设计里写入都在 agent 之外，所以这条压力很小。）
- **乐观锁**：`trip` doc 带 `revision`，写入时比对。✅ `commit(tx => ...)` 原子串行提交；串行化只防止提交相互穿插，不能消除陈旧读取。应用端仍须在同一事务内读取并核对所有预期修订，验证成功证明也必须绑定实际参与校验的快照。
- **接受/确认幂等**：`POST /radar/sessions/{id}/accept` 与 `/import-batches/{id}/confirm` 必须带 `Idempotency-Key`；app 在同一个 commit 里写 trip + 记录 key，重复请求返回同一结果（PRD TC-11）。accept 同时在事务内核对验证证明绑定（§9.2）：`session_id` + proposal `revision` + 快照版本 + `trip.revision` 全部匹配才写，任一不匹配拒绝——旧提案/旧 trip revision 的「接受」不会被当成当前接受。
- **修复循环**：app 的 `submit` 修复最多 2 次，次数存 `radar_session`；每次带新的 `requestId`；超限走确定性兜底，不再调模型。
- **会话忙**：✅ `whenBusy: "reject"` 时重复提交抛 `ConversationBusy`；应用端要处理这个错误并给用户明确反馈，不要静默重试。

---

## 10. 安全边界

### 10.1 密钥 🔷

| 凭据 | 持有方 | 下发前端 |
| --- | --- | --- |
| `ZHIPU_API_KEY` | 网关 | ❌ 绝不 |
| `ZHIPU_BACKUP_API_KEY` | 网关 | ❌ 绝不 |
| `ARK_API_KEY` | 网关 | ❌ 绝不 |
| `AMAP_SERVER_KEY`（Web服务） | 地图适配层 | ❌ 绝不 |
| `AMAP_JS_CODE`（JS API 安全密钥） | 服务端代理 | ❌ 绝不 |
| `AMAP_JS_KEY`（Web端） | 前端 | ✅ 唯一允许，`VITE_AMAP_JS_KEY` |
| `COOKIE_SECRET` | 应用端 | ❌ 签匿名 guest cookie |
| `GATEWAY_INTERNAL_TOKEN` | 网关自身 | ❌ |

✅ 智谱/火山同样把 API Key 视为服务端凭据；两家 Key 都不得进前端构建产物、日志或错误上报。

完整环境变量清单见 [SETUP §5](./SETUP_平台开通指南.md)。

### 10.2 JS API 安全密钥代理 + SSRF 防护 ✅

2021-12-02 之后创建的 JS API key 必须配 securityJsCode，且 `_AMapSecurityConfig` 必须在 JS API 脚本加载**之前**设置。生产走服务端代理，**代理必须做路径白名单**（完整代码见 [SETUP §4.2](./SETUP_平台开通指南.md)）：

```ts
const SAFE_PATH = /^\/v[345]\/[a-z0-9/_-]+$/;
```

**服务端禁止任意 URL 内网请求。** 代理只允许固定上游 host + 白名单路径，否则就是 SSRF 与配额滥用入口。

### 10.3 图片与提示词注入 🔷

- **上传校验**：大小、类型（PRD 硬要求）。✅ Photon 会解码每张图，**坏图进不了 transcript**；无法准备的图被剔除并附说明。
- **提示词注入隔离**：截图里读出的原文**只作为数据**，不作为指令。工具权限由**可信应用端**授予（`callers` / `modelTools`），不由图片内容决定。
- 🔷 具体做法：抽取结果进 `candidate_pool` 前经闸门校验；图片原文不进 system prompt；抽取用的模型调用**不给写入类工具**。

### 10.4 日志与埋点 🔷

- ✅ Pi 遥测原生：「Attributes contain IDs and control metadata, never messages, arguments, or results; IDs point to the transcript.」失败分类 `task_faulted` / `task_failed` / `task_orphaned`，诊断截断 500 字符，`aborted` 保持 status ok。
- 🔷 我们自己加的埋点：**不含精确经纬度、不含完整来源截图**（PRD 硬要求）。
- 🔷 `afterTool` 若改写 schema 工具的 `output` 做脱敏，**必须同时脱敏 `structuredOutput`**（✅ README 明确要求）。

### 10.5 位置隐私 🔷

不默认持续后台定位；MVP 默认不采集连续轨迹（PRD 硬要求）。位置只在用户主动触发雷达时取一次，进 `eta_snapshot` 时按埋点规则降精度。

### 10.6 对象存储、留存与删除 🔷

- **存哪里**：原图与规范化副本存对象存储；Demo 用本地持久卷，生产用 S3/OSS。`source_asset` doc 只存 `object_key`、`content_type`、`bytes`、`fetched_at`、`retention_deadline`、`deleted_at`。
- **key 规则**：`source/{conversation_id}/{batch_id}/{asset_id}.{ext}`；规范化副本 `.../normalized.jpg`。key 不进日志、不下发前端（前端用应用端代理或短签名 URL）。
- **留存**：原图默认 7 天（Demo 可更短），OCR 摘要 30 天，提案/ETA 快照随 conversation 保留；策略可配置。PRD D-07 的 TTL 在这里落。
- **删除分两级，语义不同，别用同一套流程**：

  **`DELETE /trips/{id}`（删一个旅行）= 按引用清理，不关库、不删文件：**
  1. 停止/取消该 trip 进行中的 radar run；
  2. `retireDoc` 该 `trips[key=trip_id]` 成员与其独占派生数据：该 trip 的 `radar_session` / `proposal` / `candidate_pool` / `eta_snapshot` family 成员、该 trip 专属 `import_batch` / `source_asset` 及对应对象存储原图/规范化副本；
  3. **按引用计数/引用检查清理**：只删「只被这个 trip 引用」的对象；`wishlist` 里经用户确认的 Place、`nextstop.preferences`、长期 `rejections`、别的 trip 的 family 成员与共享引用**一律不动**——一个地点被多个行程/收藏引用时，删一个 trip 不波及其它；
  4. 客户端缓存同步清：前端删该 trip 的本地缓存条目（SW cache / IndexedDB / 离线快照中该 trip 的部分），不整库清；
  5. 重复删除幂等返回成功。

  **`DELETE /me/data`（删当前匿名用户全部数据）= 整户清理，这才关库删文件：**
  1. 停止该用户所有进行中的 run；
  2. 删除对象存储里 `source/{conversation_id}/` 前缀下全部原图/规范化副本；
  3. **关闭该用户的 Session，再删除整个 SQLite 文件**（`data/users/{guest_id}.sqlite*`，含 WAL/SHM）——transcript 里也有用户输入，只 retire doc 清不干净；
  4. **客户端缓存清理是硬性要求**：前端清掉该用户的 SW cache、IndexedDB、localStorage 中全部 NextStop 数据并注销登录态 cookie 映射——否则离线缓存里还留着已「删除」的行程/提案；
  5. 写一条脱敏 audit（不含图片内容/精确坐标）；若 audit 在该用户库里，随文件一起删除；
  6. 重复删除幂等返回成功。

- **不删除**：应用侧 `policy.json`（全局策展数据，非用户数据）。删除失败要报告给用户，不假装成功（PRD FR-12）。

### 10.7 PWA 与离线 🔷

- Vite + `vite-plugin-pwa`；manifest、图标、`display: standalone`；HTTPS 才可安装。
- Service worker 缓存 app shell + **最近一次通过闸门的 trip/proposal**；离线时展示缓存并标 `stale`。
- 离线**不做** ETA/营业推断；导航跳转需要在线（或已有官方 URL）；恢复网络后重新校验（PRD §13 浏览器离线）。
- 地图 JS 加载失败时提供纯卡片列表作为等价路径（PRD §6.5）。

### 10.8 埋点 🔷

- 事件沿用 PRD §16.1：`import_started/completed`、`candidate_reviewed`、`itinerary_generated`、`radar_opened`、`recommendations_rendered`、`recommendation_rejected/accepted`、`navigation_opened`、`feedback_submitted`。
- 服务端采集；字段不含精确经纬度（用城市/距离分桶）、不含完整截图、不含模型原文；`session_id` 可关联但不可反查用户。
- 留存与删除跟随 `nextstop.audit`/用户删除接口；埋点失败不阻塞主流程。

---

## 11. 场景走查：14:10 提前结束 → 17:30 锁定晚餐

PRD 的验收场景。逐层走一遍，验证架构闭合。

| 步 | 谁 | 做什么 | 地图 API |
| --- | --- | --- | --- |
| 1 | 用户 | 「我提前结束了，现在 14:10，晚上 17:30 在 X 吃饭（已锁定）」 | 0 |
| 2 | 应用端 | 生成 `requestId`，`submit` 输入；创建 `radar_session` | 0 |
| 3 | 模型 | 调 `trip.read` → 拿到锁定项 17:30@X | 0 |
| 4 | 模型 | 调 `time.compute_deadline` → 纯函数算出可用窗口；**current→X 的 ETA 单独查一次** | **1** |
| 5 | 模型 | 调 `wishlist.read` + `session.read_history` → 灵感库 + 已拒绝理由 | 0 |
| 6 | 模型 | 调 `candidates.recall` → 收藏 + 附近合并、去重、写 `candidate_pool` | 0–1（附近） |
| 7 | 模型 | 调 `candidates.screen`：**candidates→X** 自然方向一次 + **candidates→current** 反向一次（步行标 estimated）；对 top N 用 `/v5/place/detail` 批量查（一次，≤25）| **2–3**（批量）+ **1**（详情） |
| 8 | 模型 | 调 `candidates.rank_by_weights` + `candidates.diversify` → 纯函数排序 + 类型差异 | 0 |
| 9 | 模型 | 调 `candidates.propose` → 写 `nextstop.proposal` doc，1 最佳 + ≤2 备选，返回 `terminate: true` | 0 |
| 10 | **应用端闸门** | 读 proposal doc，`checkProposal` 重验 §9.1。合格 → SSE 推前端；不合格 → `submit` 修复（≤2）或确定性兜底 | 0 |
| 11 | 用户 | 拒绝最佳，理由「不想排队」 | 0 |
| 12 | 模型/应用端 | 写 `rejections`；`constraints.apply_rejection`。若是排除/阈值调整 → 用同一份快照重跑 screen + rank + diversify（**0 次**）；若是换出行方式 → 快照失效，重查 | **0 或 2–3** |
| 13 | 用户 | 接受某个备选 | 0 |
| 14 | **应用端** | 检查 ETA TTL/mode；过期则重查或提示；`trip.write`；`geo.route` 画折线（app only） | 1（仅画线） |
| 15 | 用户 | 点导航 → 应用端确认后 `nav.launch` | 0 |

**验证点：**
- **延迟优先路径**：第 3–8 步收敛为一次 `radar.evaluate`（recall→screen→top-N detail→rank→diversify），第 9 步 `candidates.propose`；模型从 7 回合降到 2 回合，语义与证据不变（§5.7、VERIFY V14）。
- 地图 API 是 **O(1) 批量**，不是 O(N)：deadline 1 次 + screen 2 次 + 详情 1 次（批量 id）+ 画线 1 次；不是文档早先写的「2 次」。
- **拒绝重排 0 次地图调用**只在「不感兴趣 / 太远 / 价格已知的太贵」成立；「不想走路」换模式必须重查（§8.2）。
- 模型**从未**写入行程或触发导航；提案在 doc，闸门在应用端（§1.3、§9.2、§9.3 成立）。
- 时间计算是纯函数；数值字段由能力层填，模型只写定性理由（§1.2、§7.5 成立）。
- 若可行集只有 1 个，就只给 1 个，**不凑三个**；可行集为空时走 `kind=empty` 分支，同样是过闸门的合法产出（§7.5、§9.1 成立）。
- 前端只渲染通过闸门的 proposal doc；中间答案/未校验输出不进 UI（§4.2、§9.2 成立）。

---

## 12. 未决项

全部指向 [VERIFY_待验证清单.md](./VERIFY_待验证清单.md)，**不在本文重复**：

| 编号 | 未决什么 | 影响本文哪节 |
| --- | --- | --- |
| ✅ V1 | base_url：两家的 plan/standard 端点都实测 200；按 Key 归属选 | §6.3 |
| ✅ V2 | 工具参数 strict：两家接受字段不报 400，诱导未越界；仍按不支持处理 | §6.4 |
| 🟡 V3 | json_schema strict：诱导测试未越界，无法区分约束与自觉；仍按不生效处理 | §6.1 |
| ✅ V4 | 多模态降级：官方已确认 `json_schema` → `json_object`，schema 不生效 | §6.1 `vision.extract` |
| ✅ V5 | pi-ai `compat`：智谱/火山逐项实测通过（thinking off、`json_object`、`max_tokens`） | §6.4 |
| ✅ V6 | `onYield`/`terminate` 语义：源码 + 真实 Harness 实测（被打回中间答案确实进 transcript）；主闸门改应用端，UI 只渲染最终答案/proposal | §4.2、§9.2 |
| ✅ V7 | 用户确认放 agent 之外：**已定为设计**，不是未决项；只需验 app 写入的幂等/HTTP | §9.3 |
| 🟡 V8 | 部署目标已定：`heirloom-lite` 跳板机（阿里云 ECS/Linux）；OS/Node/反代/端口待上机确认 | §3.2、SETUP §7 |
| 🟡 V9 | 跳板机持久盘：待实测重启/更新后 SQLite 与对象是否保留 | §8.4、SETUP §7 |
| ✅ V10 | `/v3/distance` 方向：官方确认 100 origins → 单个 destination；实测 101 静默截断到 100、步行 A↔B 同值、>5km 接口不拦（应用侧判 `WALK_TOO_FAR`）、QPS ~5/s | §5.2 |
| ✅ V11 | POI detail/批量/营业覆盖/QPS 全部实测（2026-11-16） | §5.1、§5.2 |
| ✅ V12 | 预约数据源：高德无任何预约字段（实测），策展 `policy.json` 是唯一解 | §5.1、§8.5 |
| ✅ V13 | 视觉抽取质量：20/20 全量实测——文字地点图 13/13 全抽到，纯照片 7 张无文字可抽走 guessed 通道；p50 4.3s | §5.5、§6.1 |
| 🟡 V14 | 端到端时延：模型侧已实测（Doubao 0.84s/图 3s，GLM 图 p50 4.3s/工具 6.1s）；应用端 p50 待跑 | §5.7 |
| 🟡 V15 | 对象存储/删除/PWA：本地卷或 S3/OSS；删除 SQLite 文件+对象；离线缓存 | §10.6–10.7 |
| 🟡 V16 | **套餐合规**：官方禁止后端 API 调用；用户选择 plan 模式（风险接受），standard 模式保留 | §6.1.1 |

**V6/V7 不再是架构未定点**；当前真正需要外部输入的未决项只剩 V8/V9（跳板机环境与持久盘）、V14 应用端时延与 V15 对象存储/PWA；V1–V7、V10–V13 已定案。V16 的官方条款已确定，但用户选择 **plan 模式**并接受账号风险；standard 模式随时可切回。**Key 已齐（plan 模式）；模型侧与高德侧探针全部跑完，下一步是上跳板机（V8/V9）与实现后跑应用端时延（V14）。**

---

## 附：一手来源

- Pi 仓库：`github.com/earendil-works/pi`（MIT，122,083 star，核心线 1.5.2，`pushed_at 2026-11-15`）
- README：`raw.githubusercontent.com/earendil-works/pi/<tag>/packages/{durable,ai,agent}/README.md`
- 版本 / 依赖 / 发布时间：`npm view @earendil-works/<pkg> {versions,time,dist-tags,dependencies}`
- 发布说明：`gh api repos/earendil-works/pi/releases`
- 智谱结构化输出：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
- 火山结构化输出：https://docs.volcengine.com/docs/ark/model-list?lang=zh
- 智谱 GLM-5.3-Flash 模型页：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
- 智谱 Coding Plan 快速开始（套餐限制原文）：https://docs.bigmodel.cn/cn/coding-plan/quick-start
- 智谱 Coding Plan Key 管理：https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management
- 火山 Agent Plan 套餐概览（API 调用限制原文）：https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh
- 火山 Agent Plan Pi 接入（`/api/plan/v3`）：https://docs.volcengine.com/docs/ark/agent-plan-personal-pi?lang=zh
- 火山 Coding Plan 套餐概览（不可用于 API 调用）：https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh
- 火山方舟模型列表（`doubao-seed-2-1-lite-260915`）：https://docs.volcengine.com/docs/ark/model-list?lang=zh
- Langfuse 评测与 CI：https://langfuse.com/docs/evaluation/overview · https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd
- TypeSafe Jev 模型与 API：https://docs.typesafe.ai/models · https://docs.typesafe.ai/api
- TypeSafe Choice / confidence / 能力边界：https://docs.typesafe.ai/primitives/choice · https://docs.typesafe.ai/confidence · https://docs.typesafe.ai/model-jaggedness.md
- 高德 Web服务 API：https://lbs.amap.com/api/webservice/guide/api/direction
- pi-durable 1.5.2 包源码（`dist/harness/generation.js`，`dist/documents.d.ts`，`dist/types.d.ts`）：核对 `onYield`/`terminate`、doc scope、`Tx` API、transcript 存储通道
- chord 1.5.2（`dist/delta/draft.d.ts`）：`Draft<T>` 是事务内可变视图，doc 写入靠改 draft，不是 `tx.set()`
- 高德距离测量 API：https://lbs.amap.com/api/webservice/guide/api/direction（`v3/distance` 段）

---

## 附：修订记录

- **2026-11-17（评审修订二）**
  - `candidate_pool` / `eta_snapshot` / `proposal` 从 conversation 单例改为 `defineDocFamily`（key=session_id）；`radar_session.validated` 为仅应用端可写的证明，绑定 session_id + proposal revision + 快照版本 + trip revision；GET/SSE/accept 不套用旧证明，accept 在事务内核对防陈旧接受。
  - 提案结果改 `kind=empty|recommendations` 判别联合：空结果是一等合法产出，不要求 `best`；模型输入 schema（ID/理由码/文字）与存储输出 schema（数值/证据/ID/版本由服务端注入）分离。
  - 删除分级：`DELETE /trips/{id}` 按引用清理（不动其他 trip 的收藏/偏好/共享引用）；`DELETE /me/data` 才关 Session 删整库（含 WAL/SHM）并要求客户端缓存清理。
  - 提案单工具轮由运行时强制：提案阶段 `modelTools` 收窄到只剩 `candidates.propose`，运行时拒绝混合批次，不再仅靠提示词。
  - 更正：AI-first 判据不约束「新增不变量」（硬约束本就要改闸门），固定 `radar.evaluate` 编排是延迟优化不算违反；`compile().parse()` 更正为 `compile().validate()`（不启用隐式 coercion）；testdata 已获授权入库；Jev `fast.intent` 为意图首选（结构化 Chips 0 调用），首验证闭环为真实 POI→雷达→闸门→接受；工具链统一 Node 24（`>=24.18.0 <25`）+ pnpm monorepo（apps/server、apps/web、packages/core、packages/model-gateway）。
- **2026-11-16（Langfuse 与 Jev 范围）**
  - 用户决定模型观测与评测统一用已有 Langfuse；移除 promptfoo 选型，规则/人工评分先行，实验脚本负责发布门禁。
  - 补充 TypeSafe AI Jev 候选边界：自由文本意图、POI 候选消歧、偏好软评分、Langfuse 自定义 evaluator；待标注集对照后决定是否接入，硬约束与最终写入仍由代码执行。
- **2026-11-16（探针全量）**
  - 高德实测更正：`/v5/place/detail` 批量上限远超官方文档（35/35 唯一 id 全返回，实现按 ≤25 分批）；`/v3/distance` 传 101 个 origins 静默截断到 100；步行 >5km 接口不拦（应用侧判 `WALK_TOO_FAR`）；步行 A↔B 同值；个人开发者 QPS 约 5/s。
  - 高德营业/预约覆盖：search 的 `opentime_today` 约 5/12 POI 有值、`cost` 全缺；detail business 约 4/10 带 `opentime_today`；预约字段（`ticket_ordering` 等）12 个 POI 全无——营业时间主源 search/policy，预约只能策展表。
  - 视觉抽取 20 张全量：13/13 有文字的图全抽到（46 个地点，high 35/mid 9/low 2，误抽 1 个）；7 张纯照片无文字走 `guessed:true` 地标通道（6/7 猜对，单独展示不混存）；GLM p50 4.3s、Doubao 兜底 2.6–3.2s 实测可用。
  - `strict` 诱导实测：两家 `strict:true` 不报 400、诱导加字段未越界；`json_schema strict` 诱导也未越界——无法区分约束与自觉，`supportsStrictMode:false` 不变。
  - `onYield` 真实 Harness 实测：`{continue}` 时被拒中间答案确实进 transcript（`pi.assistant` 条目 + `pi.user` continue），UI 必须过滤中间答案。
- **2026-11-16（端点实测）**
  - 两家统一走 OpenAI 兼容端点；智谱改用 Coding Plan 的 `/api/coding/paas/v4`，实测 `thinking:{type:'disabled'}`、`reasoning_effort:'max'`、`json_object`、`max_tokens`、强制工具调用均可用。
  - 新增 `ZHIPU_BACKUP_API_KEY` / `ZHIPU_BACKUP_BASE_URL` / `ZHIPU_BACKUP_MODEL`，作为同提供方视觉备用；实测 `glm-4.6v-flash` 429 高发，不放进默认兜底链。
- **2026-11-16（评审修订）**
  - 闸门从 `onYield` 移到应用端：`candidates.propose` 写 proposal doc + terminate，应用端 `checkProposal`；`terminate` 轮不经过 `onYield`，中间答案不进 UI。
  - 更正 `/v3/distance` 方向：origins→单个 destination，不能一次算 current→N；改为 3 次批量 + 反向步行近似 + 两阶段 detail。
  - 补齐导入流水线、行程草案、数据模型、API/SSE、对象存储/删除、PWA/埋点；明确 `Tx` 没有 `set()`，doc 写入用 `Draft<T>`。
  - 明确一个匿名用户 = 一个长期 conversation + 一个 SQLite 文件；单写者 + SSE；`DELETE /me/data` 连 transcript 一起清。
  - 模型网关定为两上游：GLM-5.3-Flash（视觉主）→ Doubao 2.1 Lite（文本/意图主）；补齐 `compat`、思考参数、兜底链。
  - 补结构化输出边界：durable 只校验工具参数/结果，不校验模型自由文本；关键写入走工具调用，`vision.extract` 走 `json_object` + pi-schema + 1 次 repair。
  - 记录 plan 模式合规风险；保留 `MODEL_ENDPOINT_MODE=standard|plan`，standard 为合规默认。
  - 部署目标定为 `heirloom-lite` 跳板机；V6/V7 降级，新增 V10–V16。
- **2026-11-16（工程化复核）**
  - durable 1.5.2 与 1.5.1 的 `dist/` 相同，仅版本/依赖/CHANGELOG 不同；main 为 `[Unreleased]`、无 `dist/`，只读不依赖。
  - 新增 [ENGINEERING_工程化基线与Skill分工.md](./ENGINEERING_工程化基线与Skill分工.md)：工具链、测试矩阵、CI、Skill 分工；§2.1 增补工具链行，§2.4 增补 Temporal/自研，§6.6 指向测试矩阵。