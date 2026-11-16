# NextStop 工程化基线与 Skill 分工

日期：2026-11-16  
定位：ARCH 管业务架构；本文只管网关之外的运行时版本、工具链、测试、CI 与 Skill。不复述能力层和数据模型。

---

## 0. 结论

- **`pi-durable` 锁 `1.5.2` 精确版本**；它是当前单进程 + SQLite + TypeScript 约束下最合适的运行时，不是“绝对最好”。
- **1.5.2 的 durable 本体与 1.5.1 代码相同**：tarball 只差 `CHANGELOG.md` 和 `package.json` 的版本/依赖号；1.5.2 是整线同步发布。
- **不用 main**：main 是 `[Unreleased]`，含破坏性 API 与 DB schema 变更，且仓库里没有 `dist/`。
- **从 `heirloom-lite` 借**：oxlint + oxfmt、改动文件格式化、Vitest + fast-check、Playwright、promptfoo、skip 门禁、gitleaks/audit、QA/acceptance 入口。
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
| 运行时 | Node | 推荐 24 LTS；最低 `>=22.19.0` |
| 包管理 | pnpm | `11.9.0` |
| 语言 | TypeScript | `5.9.3` |
| Lint | oxlint / `@oxlint/plugins` | `1.83.0` |
| 格式化 | oxfmt | `0.68.0` |
| 单测/集成 | Vitest | `4.1.10` |
| 属性测试 | fast-check | `4.10.2` |
| HTTP 测试 | supertest | `7.1.4`（可选；Hono 可用 `app.request()`） |
| 变异测试 | Stryker | `9.6.1` |
| 浏览器 E2E | Playwright | `^1.63.0` |
| 模型评测 | promptfoo | `0.124.1` |
| 密钥扫描 | gitleaks | 外部 CLI |

### 2.2 借 / 改 / 不借

| 项 | 采用方式 |
| --- | --- |
| **oxlint + oxfmt** | 直接用；`correctness: error`；TS/unicorn/oxc/vitest 插件；不用 ESLint/Prettier |
| **改动文件格式化** | 复制 `scripts/format-changed.mjs`，范围限定 `apps/server`、`apps/web`、`packages`、`scripts`、`e2e` |
| **Vitest + fast-check** | 单测 + 集成两个 project；核心纯函数用 fast-check 测不变量 |
| **Playwright** | PWA 主流程；Amap JS 和模型全部 `page.route` mock；移动视口 390×844 |
| **promptfoo** | `vision.extract` / `reason.*` / `fast.*` 模型回归；20 张小红书图仅本地 |
| **skip 门禁** | 复制 `check-test-skips.mjs`：`.only` 直接失败；skip 超 baseline 失败；解析不到摘要也失败 |
| **gitleaks + audit** | CI 每次跑 `secrets:scan`、`audit:prod`；`.env.example` 和测试桩进 allowlist |
| **QA / acceptance** | `pnpm qa` 串 lint/format/typecheck/test/build/e2e；验收要求 `ACCEPTANCE_CONFIRM_WRITES=1`，默认拒绝写 |
| **baseline lint** | 新项目基线设为 0；只有引入遗留代码时才建 baseline |
| **Stryker** | 只对 `packages/core` 纯函数跑；每周/手动，不进 PR 必跑 |
| **全仓 `oxfmt .`** | ❌ 会产生大量无关 churn；用 changed-file 脚本 |
| **NestJS/MySQL/Redis/BullMQ** | ❌ 会把单进程 + SQLite + durable task 拉回传统后端 |
| **43 文件 eval 矩阵、formal、anti-slop 全套** | ❌ 先建 3 组评测；只写 3–5 条 NextStop 真会犯的 lint 规则 |

### 2.3 架构模式（比工具更值得借）

| 模式 | 采用 |
| --- | --- |
| **单一 provider transport** | 所有模型调用走 `model-gateway/transport.ts`；业务层不拼 `response_format` |
| **结构化输出边界** | `sanitize → salvage → 最多一次低温 repair → pi-schema`；截断不 repair；repair 只修语法 |
| **思考策略集中** | `thinkingPolicy(taskClass, provider)` 一张表；禁止调用点散落 `reasoningEffort` / `enable_thinking` |
| **用量结算** | 成功/失败/中止/fallback 的 usage 都计；预算超限诚实报错 |
| **健康与能力端点** | `/health/ready`、`/health/capabilities`；只返回布尔/模式，不返回值 |
| **启动时 env 校验** | 必填 Key（智谱主 / 火山 / 高德 / 应用密钥）、`MODEL_ENDPOINT_MODE`、Base URL、`DATA_DIR` 可写；缺必填直接失败；`ZHIPU_BACKUP_*` 可选，为空时跳过视觉兜底 |
| **测试命名即调度边界** | `*.integration.test.ts` 串行、`*.test.ts` 并行；SQLite 每用例独立目录 |

---

## 3. 落地基线

### 3.1 `package.json`

```json
{
  "engines": { "node": ">=22.19.0" },
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "build": "pnpm -r build",
    "lint": "oxlint --deny-warnings",
    "lint:fix": "oxlint --fix",
    "format": "node scripts/format-changed.mjs",
    "format:check": "node scripts/format-changed.mjs --check",
    "typecheck": "pnpm -r typecheck",
    "test": "node scripts/check-test-skips.mjs",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "playwright test",
    "test:model": "promptfoo eval -c evals/promptfooconfig.yaml",
    "test:model:local": "promptfoo eval -c evals/promptfooconfig.local.yaml",
    "qa": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e",
    "secrets:scan": "gitleaks git --redact --config .gitleaks.toml .",
    "audit:prod": "pnpm audit --prod --audit-level high"
  }
}
```

- `.nvmrc` 写 `24`；`engines` 保持 `>=22.19.0`，部署机 22.19+ 也能启动。
- `pnpm test` 内部串 `test:unit` + `test:integration`；CI 不要直接跑 `vitest` 绕过门禁。
- 模型评测和 Stryker 不进 `qa`，避免每次提交烧钱/变慢。

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
| E2E | Playwright | 导入 → 确认 → 雷达 → 三选一 → 接受/拒绝 → 离线 | 每个 PR |
| 模型 | promptfoo | 视觉抽取、理由无数字、意图分类、延迟/成本 | 每日/手动 |
| 变异 | Stryker | 核心纯函数测试能否杀死变异 | 每周 |
| 安全 | gitleaks + audit | 密钥、生产依赖高危 | 每个 PR |
| 验收 | `scripts/acceptance.mjs` | 真实 API + 模型 + 独立数据目录 | 发布前 |

**必测 10 条**：非法 `candidates.propose` 参数 → `invalid_arguments`；`prepareArguments` 修复；闸门打回 ≤2 次；`kill -9` 后续跑；同 `requestId` 幂等；删除用户连 WAL/SHM 清干净；高德批量方向；拒绝重排 0 次地图调用；前端产物无服务端 Key；PWA 离线只显示通过闸门的 proposal。

### 3.4 CI

- PR：`install --frozen-lockfile` → lint → format:check → typecheck → unit → integration → build → e2e → gitleaks/audit。
- PR 不跑真实模型；用 `fauxProvider()` 和 Playwright mock。
- `model-eval` 手动/定时，设预算上限；失败不阻塞合并，阻塞发布。
- Node 24 + pnpm 11；缓存 pnpm store。

### 3.5 promptfoo

- `evals/promptfooconfig.yaml`（CI：合成/公开图或仅文本） + `promptfooconfig.local.yaml`（20 张小红书图）。
- 断言：JSON 过 pi-schema；POI 名称 fuzzy match；不出现输入里没有的价格/营业时间；延迟/成本在预算内。
- 第三方图片只本地评测：不提交 Git、不打包前端、不对外分发；CI 用合成图或公开授权图。

---

## 4. Skill 分工

> Matt 用 mattpocock 系列；下面不重复。原则：**一个阶段一个主 skill，实现与审查分离，Skill 不是 CI。**

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

**冲突规避**：Matt 的 skills 管 TS 风格/idiom；pstack 管领域类型与重构纪律；同一轮不要让两边改同一文件。写代码的 agent 不自审，`code-review` / `review-refactor` 另起一轮。

---

## 5. 一句话

**1.5.2 精确锁，不碰 main；工具链借 heirloom 的“快 lint/格式、真测试、假绿门禁、密钥扫描、单入口 QA”，不借重后端和全量评测；Skill 按阶段分工，Matt 管 TS 风格，pstack 管类型/重构，review 管独立审查，run/ego-browser 管真实验证。**
