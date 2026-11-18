# NextStop 工程化基线与 Skill 分工

日期：2026-11-16  
定位：ARCH 管业务架构；本文只管网关之外的运行时版本、工具链、测试、CI 与 Skill。不复述能力层和数据模型。

---

## 0. 结论

- **`pi-durable` 锁 `1.5.2` 精确版本**；它是当前单进程 + SQLite + TypeScript 约束下最合适的运行时，不是“绝对最好”。
- **1.5.2 的 durable 本体与 1.5.1 代码相同**：tarball 只差 `CHANGELOG.md` 和 `package.json` 的版本/依赖号；1.5.2 是整线同步发布。
- **不用 main**：main 是 `[Unreleased]`，含破坏性 API 与 DB schema 变更，且仓库里没有 `dist/`。
- **从 `heirloom-lite` 借**：oxlint + oxfmt、改动文件格式化、Vitest + fast-check、skip 门禁、gitleaks/audit、QA/acceptance 入口。浏览器验收按用户 2026-11-17 决定使用 ego-lite（`ego-browser` CLI）。
- **模型观测与评测统一用 Langfuse**（2026-11-16 用户决定）：复用已有服务，数据集、实验、评分与调用观测共用一套；不引入 promptfoo。
- **不借**：NestJS/MySQL/Redis 栈、43 文件 eval 矩阵、全仓 Stryker、baseline allowlist、anti-slop 插件原样。

---

## 1. `pi-durable` 版本判定

### 1.1 事实

| 项 | 1.5.1 | 1.5.2 | main |
| --- | --- | --- | --- |
| npm | 旧版 | ✅ `latest`（2026-11-10） | ❌ 未发布 |
| `package.json` 版本 | 1.5.1 | 1.5.2 | **仍写 1.5.2** |
| `dist/` | — | **与 1.5.1 逐字节相同** | 大量未发布改动 |
| `CHANGELOG` | 116 行，含两个关键修复 | 1.5.2 段为空 | `[Unreleased]`，破坏性变更 |
| DB schema | 现行 | 现行 | `pi.tool` v4 / `pi.generation` v3，旧 Harness 不认 |
| 判定 | 可用兜底 | ✅ **选定** | 只读参考 |

1.5.2 的 GitHub Release 说明全是 coding-agent 的 session fork / TUI / Anthropic OAuth；durable 本体没有用户可见变更。兄弟包 `chord` 1.5.2 新增 `./compression` 子路径，按整线锁定即可，不混装 1.5.1/1.5.2。

### 1.2 为什么不用 main

- main 的 `CHANGELOG.md` 是 `[Unreleased]`，已含 `runEndTask` → `hookTask`、工具 park、`until` 可选、codemode namespace 重写等破坏性变更。
- 新版本写出的数据库不保证旧 Harness 能打开，旧 Harness 会以 `task_too_old` 拒绝任务。
- main 仓库的 `packages/durable/dist/index.js` 是 404，只有 `src/`；`github:` 依赖要么找不到构建产物，要么得在安装时编译整个 monorepo。
- **规则：main 只读来看方向，不作为依赖。** 需要 main 上的修复时，等发布或 vendor 固定 commit 的补丁。

### 1.3 替代方案

| 方案 | 判断 |
| --- | --- |
| **Temporal** | 持久执行最强，但要独立集群 / Worker / 数据库；单机 SQLite 项目 overkill，也不提供 agent 的 conversation/doc/tool 语义 |
| **LangGraph JS** | 显式图 = 控制流写死，违反 AI-first 判据；checkpoint 不等于 doc + task + entry 原子提交 |
| **Mastra** | 30+ 依赖，平台会和网关抢职责 |
| **AI SDK + 自研 store** | 模型层成熟，但原子提交、续跑、幂等、doc 历史都要自己写；用户已否决 AI SDK |
| **`pi-agent-core`** | 只有 agent loop，durable 原语全要手写，已被 durable 覆盖 |
| **完全自研** | 可控性最高，崩溃/并发/幂等/回放的正确性风险也最高 |

`pi-durable` 不是 coding-agent 专用层：带 TUI/CLI 的是 `pi-coding-agent`；durable 只提供 conversation / task / document 运行时、存储、工具注册表和图片处理。

### 1.4 选型代价

| 代价 | 表现 | 对策 |
| --- | --- | --- |
| **单写者** | 同一用户不能多进程同时写；不能简单多副本扩容 | 按用户分片；一个用户一个写者；读走只读视图/SSE |
| **每用户一个 SQLite** | 文件数随用户增长；备份、归档、删除按文件处理 | `DATA_DIR/users/{id}.sqlite`；删除连 WAL/SHM |
| **conversation 增长** | 一用户一长期 conversation，transcript 与 rewindable doc 膨胀 | 开 compaction；历史设保留上限；超预期再评估按 trip 分 conversation |
| **Experimental** | API 无预告变更；升级要回归 | 精确锁版；薄适配层；升级门禁 |
| **不自带 HTTP/鉴权** | durable 是运行时，不是 Web 框架 | 应用端自己写 HTTP/SSE、匿名会话、限流、上传校验 |

### 1.5 升级规则

1. `package.json` 写 `"@earendil-works/pi-durable": "1.5.2"`，不用 `^` / `~`；提交 lockfile。
2. 升级前：读 changelog → `npm pack` 新旧版本 `diff -qr` → 跑 `registerStorageConformance()` → 跑崩溃/续跑/幂等/回放 → 用旧库文件做打开测试。
3. 单独分支升级，保留一键回退；API 改名只改薄适配层，纯函数不动。
4. **退出条件**：连续两个版本都影响闸门/存储，或需要多节点写入，停止追版本，评估 Temporal 或自研薄层。

---

## 2. `heirloom-lite` 工具链

### 2.1 版本

| 层 | 工具 | 版本 |
| --- | --- | --- |
| 运行时 | Node | **统一 24 线**：`.nvmrc` 写 `24`，engines `>=24.18.0 <25`（pi-durable/pi-ai 自身只要求 `>=22.19.0`，本项目取更严的 24 线） |
| 包管理 | pnpm | `11.9.0` |
| 语言 | TypeScript | `5.9.3` |
| Lint | oxlint / `@oxlint/plugins` | `1.83.0` |
| 格式化 | oxfmt | `0.68.0` |
| 单测/集成 | Vitest | `4.1.10` |
| 属性测试 | fast-check | `4.10.2` |
| HTTP 测试 | supertest | `7.1.4`（可选；Hono 可用 `app.request()`） |
| 变异测试 | Stryker | `9.6.1` |
| 浏览器 E2E | ego-lite / `ego-browser` CLI | 使用本机已安装并连接的桌面浏览器 |
| 模型观测与评测 | Langfuse（已有服务 + 官方 JS/TS SDK） | 初始化时核对现有服务与 SDK 兼容并精确锁版 |
| 密钥扫描 | gitleaks | 外部 CLI |

### 2.2 借 / 改 / 不借

| 项 | 采用方式 |
| --- | --- |
| **oxlint + oxfmt** | 直接用；`correctness: error`；TS/unicorn/oxc/vitest 插件；不用 ESLint/Prettier |
| **改动文件格式化** | 按 Git 改动筛选工程文件，实际范围与 CI 入口见[规则与执行入口](#32-规则与执行入口)。 |
| **Vitest + fast-check** | 单测 + 集成两个 project；核心纯函数用 fast-check 测不变量 |
| **ego-lite** | `pnpm test:e2e` 自启隔离的本地 Web/API，通过 `ego-browser nodejs` 实测 390×844 页面、断线重试和雷达确认。报告与截图存 `test-results/ego-*/` |
| **Langfuse** | 复用已有观测/评测服务；官方 SDK 运行 `vision.extract` / `reason.*` / `fast.*` 数据集实验；20 张小红书图仅本地，不上传原图/原文到 Langfuse |
| **skip 门禁** | `check-test-skips.mjs`：拒绝 only / skip / todo / 条件跳过；零用例、非成功或无法解析的 JSON 报告都失败 |
| **gitleaks + audit** | CI 扫描工作区和本次提交历史，包含 `.env.example` 与测试桩，并执行 `audit:prod` |
| **QA / acceptance** | `pnpm qa` 运行[本地质量检查](./README.md#检查与测试)和 ego-lite 验收，需先启动应用并连接桌面浏览器。未来真实写入验收另需 `ACCEPTANCE_CONFIRM_WRITES=1`。 |
| **baseline lint** | 新项目基线设为 0；只有引入遗留代码时才建 baseline |
| **Stryker** | 只对 `packages/core` 纯函数跑；每周/手动，不进 PR 必跑 |
| **全仓 `oxfmt .`** | ❌ 会产生大量无关 churn；用 changed-file 脚本 |
| **NestJS/MySQL/Redis/BullMQ** | ❌ 会把单进程 + SQLite + durable task 拉回传统后端 |
| **43 文件 eval 矩阵、formal、anti-slop 全套** | ❌ 先建 3 组评测；只写 3–5 条 NextStop 真会犯的 lint 规则 |

### 2.3 架构模式（比工具更值得借）

| 模式 | 采用 |
| --- | --- |
| **统一模型调用边界** | 所有调用走模型网关；文本/视觉用 pi-ai transport，Jev 用原生 decision transport；共用预算/校验/记账，业务层不拼 provider 请求体 |
| **结构化输出边界** | `sanitize → salvage → 最多一次低温 repair → pi-schema`；截断不 repair；repair 只修语法 |
| **思考策略集中** | `thinkingPolicy(taskClass, provider)` 一张表；禁止调用点散落 `reasoningEffort` / `enable_thinking` |
| **用量结算** | 成功/失败/中止/fallback 的 usage 都计；预算超限诚实报错 |
| **健康与能力端点** | `/health/ready`、`/health/capabilities`；只返回布尔/模式，不返回值 |
| **启动时 env 校验** | 当前脚手架支持无密钥启动。业务接入目标是在启动边界校验启用服务所需的 Key、端点模式、Base URL 和数据目录可写性。`ZHIPU_BACKUP_*` 可选。当前实现见[服务端配置](./apps/server/src/config.ts)。 |
| **测试命名即调度边界** | `*.integration.test.ts` 串行、`*.test.ts` 并行；SQLite 每用例独立目录 |

---

## 3. 落地基线

### 3.1 `package.json`

当前命令以根 [`package.json`](./package.json) 为准，启动说明见 [`README.md`](./README.md)。本地 `pnpm qa` 依次执行 lint、改动文件格式检查、`verify:code` 和 ego-lite 浏览器验收，需先启动应用并连接桌面浏览器。`verify:code` 构建所有工作区一次，再用本次产物做类型检查和单元/集成测试。托管 Linux CI 执行代码检查、构建、审计与密钥扫描；浏览器验收另在本机执行。

单候选雷达已覆盖真实 HTTP、SQLite 事务和移动端确认。地图协议在本地受控响应下验证。下文的进程强杀恢复、多图导入与真实模型质量仍是后续验收目标。Langfuse 实验入口目前会明确非零退出。

- `.nvmrc` 写 `24`；`engines` 锁 `>=24.18.0 <25`，本地与部署机统一 Node 24 线，不留 22 分支。所有第三方依赖精确锁版（不用 `^`/`~`），提交 lockfile。
- 独立运行 `pnpm test` 或 `pnpm typecheck` 时会先构建共享包。`verify:code` 与 `pnpm test` 共用同一测试门禁，执行 AST 检查、Vitest 的 unit / integration 两个 project 和 JSON 报告校验。
- 模型评测和 Stryker 不进 `qa`，避免每次提交烧钱/变慢。

各工作区的当前能力见 [README](./README.md#目录与边界)，依赖方向见[模块边界](./AGENTS.md#模块边界)。

### 3.2 规则与执行入口

| 已生效的检查 | 执行入口与规则来源 |
| --- | --- |
| 依赖方向、跨包导入、循环依赖、Node 内置模块前缀、生产 TS/TSX 双重断言 | `pnpm lint` 执行 [Oxlint 配置](./.oxlintrc.json) 和[工作区规则](./scripts/oxlint-rules.mjs)。规则级别与适用文件以配置为准。 |
| 格式检查 | `pnpm format:check` 检查改动，CI 加 `--all`。文件范围见[筛选脚本](./scripts/format-changed.mjs)。写入时只处理本轮改动。 |
| 测试修饰符、收集范围、被扫描的测试文件实际执行 | `pnpm test` 共用[测试策略](./scripts/test-policy.ts)与 [Vitest 配置](./vitest.config.ts)，由[测试门禁](./scripts/check-test-skips.mjs)核对运行报告。 |
| Git 索引中的真实环境文件、工作区及提交历史中的密钥 | `pnpm secrets:scan` 先查 [Git 索引](./scripts/check-env-boundary.mjs)，再按[目录规则](./.gitleaks-dir.toml)扫描工作区，包含 `.env.example`。CI 另按[历史规则](./.gitleaks.toml)扫描 push/PR 引入的提交。 |
| 生产依赖审计 | `pnpm audit:prod`。托管作业与放行条件见 [CI 配置](./.github/workflows/ci.yml)。 |

### 3.3 测试矩阵

| 层 | 工具 | 测什么 | 频率 |
| --- | --- | --- | --- |
| 单元 | Vitest | `screen` / `rank` / `deadline` / `gate` / `itinerary` | 每次提交 |
| 属性 | fast-check | 不返回锁定/排除项；排序单调；时间窗口非负；行程不重叠 | 每次提交 |
| 集成 | Vitest + 真 SQLite + `fauxProvider()` | 原子提交、崩溃续跑、`requestId` 幂等、doc 历史、SSE 重连 | 每次提交 |
| 契约 | pi-schema + prompt/schema 契约 | 工具名/字段名一致；非法参数回 `invalid_arguments` | 每次提交 |
| E2E | ego-lite / `ego-browser` | 单候选雷达、确认重放、过期、空态、刷新持久化和断线重试。导入、拒绝与离线为后续目标 | 每个 PR 本地验收 |
| 模型 | Langfuse 数据集实验 + 自定义规则/人工评分 | 视觉抽取准确率/召回率、理由证据支持、意图分类、延迟/成本 | 每日/手动 |
| 变异 | Stryker | 核心纯函数测试能否杀死变异 | 每周 |
| 安全 | gitleaks + audit | 密钥、生产依赖高危 | 每个 PR |
| 验收 | `scripts/acceptance.mjs` | 真实 API + 模型 + 独立数据目录 | 发布前 |

**业务闭环必测项**：非法 `candidates.propose` 参数 → `invalid_arguments`；`prepareArguments` 修复；闸门打回 ≤2 次；`kill -9` 后续跑；同 `requestId` 幂等；**过期/他 session 的 `validated` 不得被 GET/SSE/accept 套用，accept 在事务内核对绑定**；`kind=empty` 过闸门且前端空态正常；删除用户连 WAL/SHM + 客户端缓存清干净；**删单 trip 不动其它 trip 的收藏/偏好/共享引用**；高德批量方向；拒绝重排 0 次地图调用；前端产物无服务端 Key；PWA 离线只显示通过闸门的 proposal。

### 3.4 CI

- 托管 Linux CI 在安装依赖后依次运行 lint、全量格式检查、`verify:code` 和依赖审计。环境文件与密钥扫描作为独立作业并行运行。
- 本机桌面验收：连接 ego-lite 后运行 `pnpm test:e2e`，脚本自启 Web/API 并使用临时数据库；浏览器步骤失败、报告缺失或未完成全部断言均不通过。截图另做视觉确认；CI 绿不代表浏览器已验收。
- PR 自动测试不调用真实模型；模型响应由 mock fetch / `fauxProvider()` 提供。ego-lite 验收连接真实本地 API，故障分支用 CDP 仅阻断该页面的健康请求。
- `model-eval` 手动/定时运行 Langfuse 实验，设预算上限；实验脚本显式断言阈值并在失败时退出非零，失败不阻塞合并、阻塞发布。仅在 Langfuse 记录结果不算门禁通过。
- Node 24 + pnpm 11；缓存 pnpm store。

### 3.5 Langfuse：统一观测与模型评测

**决定：复用已有 Langfuse，不另引入 promptfoo。** 先用规则与人工评分；需要语义自动评分时再评估裁判模型。TypeSafe AI 的 Jev 优先用于生产流程的有限选项决策，也可作为 Langfuse 自定义 evaluator 的后续候选（ARCH §6.1.2），接入它不代表新增评测平台。

协议与小样例验证：`node --env-file=.env.jev.local scripts/probe-jev.mjs`；加 `--suite` 运行固定的 16 个合成请求（会调用真实中转）。凭据文件权限设为 600 且由 Git 忽略，结果写入 `testdata/jev-probe/`。该探针用于验证协议和业务假设，不代替 Langfuse 的版本化准入实验。

运行时观测：

- 在模型网关边界关联 `request_id`、任务类、真实 provider/model、重试/repair/fallback 次数、耗时、token/成本与失败状态；pi-telemetry 保留运行时遥测职责。
- 失败、中止和 repair 的使用量都计入统一账本；Langfuse 用于观察与比较，不代替业务预算检查，也不重复累计同一笔 usage。
- 默认不上传完整截图、base64、图片原文或精确坐标；只上报脱敏元数据和必要评分。Langfuse 凭据仅在服务端/评测环境持有。

初始数据集如下；Jev 优先对照意图分类和 POI 消歧两组：

| 组 | 输入与金标 | 评分 |
| --- | --- | --- |
| 视觉抽取 | 图片 fixture + 人工标注地点清单；区分文字抽取与地标猜测 | JSON/schema 合法性、地点级 precision/recall、误抽率；“每图抽到至少一个”不是地点级召回率 |
| 推荐理由 | 已排序候选 + 证据 + 理由 | 数字/价格/营业时间规则断言、引用证据支持、人工评价；排序与锁定项用确定性契约检查 |
| 意图分类 | 自由文本 + 当次上下文 + 标注意图 | Jev 与 Doubao 使用同一数据集与上下文；分类准确率、错误动作率、拒答/需确认率，以及包含 fallback 的端到端 p50/p95 |
| POI 消歧 | 抽取名/城市/地址线索 + 高德候选 + 人工确认 ID 或无匹配 | 正确匹配率、错误门店选择率、需确认率；记录 Jev/现有路径的端到端延迟、fallback 比例与全部调用成本 |

执行与门禁：

- `evals/run-model-evals.mjs` 已提供明确失败的占位入口，尚未接通 Langfuse。模型准入前须通过官方 SDK 组织实验，任务调用真实应用网关/解析路径，共用思考策略、修复和兜底；脚本是评测入口，不是另一套平台。
- `test:model` 用合成/公开授权数据；`test:model:local` 加载 `testdata/xhs-suzhou/`。第三方图已获授权随仓库入库；仍仅本地评测、不打包前端产物，也**不上传 Langfuse 原图/原文**；实验只记录 fixture 标识、版本与汇总分数。
- 截图实验走 SDK；初始化时核对已有 Langfuse 服务与 SDK 的兼容性、媒体支持并锁版，不假设 UI experiments 可以运行图片数据集。
- 每次实验关联数据集版本、提示词版本、应用 commit、实际模型版本；统计 p50/p95、失败率、修复率和全部调用成本。
- 发布门禁由实验脚本断言质量/延迟/预算阈值，失败或无法取得必需实验结果时退出非零；凭据缺失不能静默跳过后仍放行。普通 PR 保持 mock 测试。
- Langfuse 服务异常不阻塞在线用户主流程；发布所需评测失败则由发布门禁报告。

一手来源：[评测总览](https://langfuse.com/docs/evaluation/overview) · [数据集实验](https://langfuse.com/docs/evaluation/experiments/overview) · [CI 集成](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd)。

---

## 4. Skill 分工

功能开发按用户场景、交互、契约、实现、真实验收和最终审查的顺序推进。每阶段按任务选一个主 Skill，先读当前环境提供的说明。入口缺失时记录情况，沿用该阶段的验收要求。安装步骤见 [README](./README.md#安装-ai-协作-skill)。

| 何时使用 | Skill | 交付 |
| --- | --- | --- |
| 产品交互影响验收 | `grill-with-docs`（可用时） | 把确认的正常流程、异常状态和验收标准写回同一份 [PRD](./PRD.md)。 |
| 需要独立可点击原型 | `artifact-design` | 用 `ego-browser` 走查移动端正常和异常流程。生产 React 页面单独验收。 |
| 设计类型或接口契约 | `pstack-principle-type-system-discipline` | 明确合法状态、业务不变量和信任边界。 |
| 阅读或编写 TS/TSX | `pstack-typescript-best-practices` | 先应用上一行的类型原则，再按可独立验证的切片实现并测试。 |
| 本轮改动需要简化 | `simplify` | 清理有实际维护成本的重复，完成后重新验证。 |
| 验证真实功能 | `run` | 启动应用并操作目标流程。页面交互用 `ego-browser` 检查本轮报告与截图。 |
| 审查功能或修复 | `code-review` | 基于最终差异检查调用方、失败路径、事务、幂等及并发。 |
| 涉及身份、上传、外部 URL、密钥、删除或部署 | `security-review` | 核对此次变更涉及的安全边界，部署前复核适用项。 |

### 实现与错误处理

按变化原因组织业务模块，说明新接口、依赖或抽象服务于哪个现有调用方。通过参数或小对象在装配入口传入依赖。类型由 schema 派生，禁止用 `any`、双重断言或非空断言掩盖契约问题。仅合并语义相同的重复，注释解释业务约束与取舍。

HTTP、环境、第三方响应和重新读入的不可信持久化数据在各自入口校验。必填字段缺失时明确失败。外部适配保留网络失败、JSON 解析、schema 不匹配和超时等诊断。只在可恢复、转换错误语义或释放资源处捕获异常，由合适的一层记录。

重试、repair、备用模型或缓存回退需要产品契约或可复现的失败。明确触发条件、唯一负责者、次数上限与终止结果，各次尝试共用剩余 deadline 和预算。模型格式修复须有真实失败样例，修复后重新校验，禁止补造事实或把截断内容当作成功。并发任务的创建者负责取消和清理，持久任务按其业务语义决定是否随请求断开。

### 重构与重复错误

结构诊断用 `plan-refactor` 只读梳理调用链与变更成本。局部实施用 `refactor-code`，先记录公开契约、返回值、异常、顺序和副作用，关键路径缺少保护时先补行为测试。`review-refactor` 针对准确的 base/head 检查回归。明确要求全仓或多模块重构时才用 `refactor-repository`。将重构、功能、缺陷修复、依赖升级和大范围格式化分开交付。

同类错误已有两次真实发生，或已有规则再次被违反时，用 `pstack-correct` 找到提交、审查意见或失败用例。再次准备给出同一提醒时用 `pstack-principle-encode-lessons-in-structure`，依次考虑收紧状态所有权、类型与 schema、lint/CI、行为测试，最后才补文档。用历史错误和正常用例检验新规则，落地后更新[执行入口](#32-规则与执行入口)，删除失效的提醒。测试应覆盖可观察结果与副作用，并确认新用例实际被收集执行。

审查者核对最终差异，修正后复验受影响部分。派发和操作权限见[验证与授权](./AGENTS.md#验证与授权)。
