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
| **改动文件格式化** | 复制 `scripts/format-changed.mjs`，范围限定 `apps/server`、`apps/web`、`packages`、`scripts`、`e2e` |
| **Vitest + fast-check** | 单测 + 集成两个 project；核心纯函数用 fast-check 测不变量 |
| **ego-lite** | `pnpm test:e2e` 经 `ego-browser nodejs` 操作已启动的本地应用；390×844 页面、断线和重试，报告与截图存 `test-results/ego-*/`；不依赖浏览器测试 SDK |
| **Langfuse** | 复用已有观测/评测服务；官方 SDK 运行 `vision.extract` / `reason.*` / `fast.*` 数据集实验；20 张小红书图仅本地，不上传原图/原文到 Langfuse |
| **skip 门禁** | `check-test-skips.mjs`：拒绝 only / skip / todo / 条件跳过；零用例、非成功或无法解析的 JSON 报告都失败 |
| **gitleaks + audit** | CI 每次跑 `secrets:scan`、`audit:prod`；`.env.example` 和测试桩进 allowlist |
| **QA / acceptance** | `pnpm qa` 串 lint/format/typecheck/test/build/ego-lite 验收；本地需先启动应用并连接桌面浏览器。未来真实写入验收另需 `ACCEPTANCE_CONFIRM_WRITES=1` |
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
| **启动时 env 校验** | 必填 Key（智谱主 / 火山 / 高德 / 应用密钥）、`MODEL_ENDPOINT_MODE`、Base URL、`DATA_DIR` 可写；缺必填直接失败；`ZHIPU_BACKUP_*` 可选，为空时跳过视觉兜底 |
| **测试命名即调度边界** | `*.integration.test.ts` 串行、`*.test.ts` 并行；SQLite 每用例独立目录 |

---

## 3. 落地基线

### 3.1 `package.json`

当前命令以根 [`package.json`](./package.json) 为准，启动说明见 [`README.md`](./README.md)。本地 `pnpm qa` 依次执行 lint、改动文件格式检查、类型检查、单元/集成测试、构建和 ego-lite 浏览器验收，需先启动应用并连接桌面浏览器。托管 Linux CI 执行代码检查、构建、审计与密钥扫描；浏览器验收另在本机执行。

**脚手架与目标分开**：目前已实现健康 API、Web 外壳、共享契约、Jev 意图传输和 SQLite 适配。下文完整测试矩阵是业务开发目标；`kill -9` 恢复、accept 幂等、导入/雷达端到端和真实模型质量尚未由脚手架证明。Langfuse 实验入口尚未接通，会明确非零退出；Stryker 与真实写入验收脚本在对应业务落地后接入。

- `.nvmrc` 写 `24`；`engines` 锁 `>=24.18.0 <25`，本地与部署机统一 Node 24 线，不留 22 分支。所有第三方依赖精确锁版（不用 `^`/`~`），提交 lockfile。
- `pnpm test` 先构建共享包，做 AST 跳过检查，再一次运行 Vitest 的 unit / integration 两个 project 并校验 JSON 报告。CI 使用同一入口。
- 模型评测和 Stryker 不进 `qa`，避免每次提交烧钱/变慢。

**Monorepo 布局（pnpm workspace）**：

```text
apps/server        # 应用端：HTTP/SSE、闸门、导入流水线、Harness 持有方（单写者进程）
apps/web           # React + Vite PWA；只经 HTTP/SSE 与应用端说话
packages/core      # 共享 pi-schema 契约 + 纯函数；不依赖 durable、HTTP、SQLite 或模型网关
packages/model-gateway  # 当前：任务路由表、pi-ai 注册入口、Jev 意图传输；provider/fallback/预算/观测链待接入
scripts/ evals/ e2e/ testdata/
```

`packages/core` 是唯一被 server/web 共用的包——契约与纯函数放这里，server 与 web 各自只依赖它，不互相 import；`packages/model-gateway` 只在 server 侧使用，密钥不出这个包。

### 3.2 lint / 格式化

```json
{
  "plugins": ["typescript", "unicorn", "oxc", "vitest"],
  "categories": { "correctness": "error" },
  "rules": {
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  },
  "ignorePatterns": ["**/node_modules/**", "**/dist/**", "coverage/**", "testdata/**"]
}
```

- 前端 override 禁止 `node:*` 和服务端模块 import；只加真会犯的规则。
- `format-changed.mjs` 从 heirloom 复制，改 `FORMATTED_DIRS`；`testdata/`、`docs/` 不默认格式化。
- CI 跑 `--check`，本地默认写入；不要跑 `oxfmt .`。

### 3.3 测试矩阵

| 层 | 工具 | 测什么 | 频率 |
| --- | --- | --- | --- |
| 单元 | Vitest | `screen` / `rank` / `deadline` / `gate` / `itinerary` | 每次提交 |
| 属性 | fast-check | 不返回锁定/排除项；排序单调；时间窗口非负；行程不重叠 | 每次提交 |
| 集成 | Vitest + 真 SQLite + `fauxProvider()` | 原子提交、崩溃续跑、`requestId` 幂等、doc 历史、SSE 重连 | 每次提交 |
| 契约 | pi-schema + prompt/schema 契约 | 工具名/字段名一致；非法参数回 `invalid_arguments` | 每次提交 |
| E2E | ego-lite / `ego-browser` | 当前：页面、断线、重试；业务目标：雷达 → 闸门 → 接受写入，再接导入/拒绝/离线 | 每个 PR 本地验收 |
| 模型 | Langfuse 数据集实验 + 自定义规则/人工评分 | 视觉抽取准确率/召回率、理由证据支持、意图分类、延迟/成本 | 每日/手动 |
| 变异 | Stryker | 核心纯函数测试能否杀死变异 | 每周 |
| 安全 | gitleaks + audit | 密钥、生产依赖高危 | 每个 PR |
| 验收 | `scripts/acceptance.mjs` | 真实 API + 模型 + 独立数据目录 | 发布前 |

**业务闭环必测项**：非法 `candidates.propose` 参数 → `invalid_arguments`；`prepareArguments` 修复；闸门打回 ≤2 次；`kill -9` 后续跑；同 `requestId` 幂等；**过期/他 session 的 `validated` 不得被 GET/SSE/accept 套用，accept 在事务内核对绑定**；`kind=empty` 过闸门且前端空态正常；删除用户连 WAL/SHM + 客户端缓存清干净；**删单 trip 不动其它 trip 的收藏/偏好/共享引用**；高德批量方向；拒绝重排 0 次地图调用；前端产物无服务端 Key；PWA 离线只显示通过闸门的 proposal。

### 3.4 CI

- 托管 Linux CI：`install --frozen-lockfile` → lint → format:check → typecheck → unit → integration → build → gitleaks/audit。
- 本机桌面验收：先启动 Web/API 并连接 ego-lite，再运行 `pnpm test:e2e`；浏览器步骤失败、报告缺失或未完成全部断言均不通过。截图另做视觉确认；CI 绿不代表浏览器已验收。
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

> pstack 主流程与各阶段的 Skill 选择以 [AGENTS.md 第 6 节](./AGENTS.md#6-skill-选择与开发流程) 为准。

| 阶段 | Skill | 用途 |
| --- | --- | --- |
| 初始化 | `init` | 生成 `CLAUDE.md`：命令、目录、禁止事项、Key 边界 |
| 权限/钩子 | `update-config`、`fewer-permission-prompts` | 只读/测试/格式化命令权限 |
| 领域建模 | `pstack-principle-type-system-discipline` | `PoiId` / `Gcj02` / `Minutes` / `RequestId`；边界解析 |
| TS 实现 | `pstack-typescript-best-practices` | 日常 `.ts` / `.tsx` |
| 架构分析 | `plan-refactor` | 首个垂直切片后评估模块边界与变更成本 |
| 小步重构 | `refactor-code` | 按计划改一个模块，保持行为 |
| 重构审查 | `review-refactor` | 行为回归、兼容性、过度设计 |
| 正确性审查 | `code-review` | 每 PR；闸门、幂等、崩溃恢复、SSE |
| 安全审查 | `security-review` | 部署前；Key、上传、SSRF、路径穿越、删除接口 |
| 简化 | `simplify` | 合并前清理重复/过度抽象 |
| 规律固化 | `pstack-correct` | 同类错误第二次 → lint / 测试 / 类型 |
| 规律编码 | `pstack-principle-encode-lessons-in-structure` | 把“记得要……”变成结构约束 |
| 真实验证 | `run` | 启动 server + web，确认改动生效 |
| 浏览器 QA | `ego-browser` | 导入、雷达、三选一、离线、删除数据 |
| 长任务 | `loop` | 等 CI、部署、评测 |
| 文档/图表 | `artifact-design`、`artifact-diagramming` | 架构图、评审页 |

**不用/暂不用**：`claude-api`（非 Anthropic）、`plugin-authoring`、`pstack-bro`、Sentry 系列（未接入）、`refactor-repository`（项目还小）。

TS 实现采用表中的 pstack Skill。产品决策需要澄清时，按 AGENTS.md 选用 Matt Pocock 的单项 Skill，并将结论写回 PRD。`code-review` 或 `review-refactor` 由独立审查者针对最终差异执行。

---

## 5. 一句话

**1.5.2 精确锁，不碰 main；工具链借 heirloom 的“快 lint/格式、真测试、假绿门禁、密钥扫描、单入口 QA”，不借重后端和全量评测。** 功能开发遵循 AGENTS.md 的 pstack 主流程。
