# 下一站 NextStop

旅行机会雷达的 TypeScript 工程脚手架。当前提供可启动的 Web/API、共享契约、pi-durable + SQLite 适配和 Jev 原生意图传输；真实雷达、截图导入、行程写入和 Langfuse 实验仍待接入。

## 开发者接手

### 安装与启动

| 工具 | 要求 |
| --- | --- |
| Git | 获取仓库并识别格式检查的改动范围。[Git 下载](https://git-scm.com/downloads) |
| Node.js | **>=24.18.0 <25**。使用 nvm 时，在仓库根目录运行 `nvm install` 和 `nvm use`，按 `.nvmrc` 切到 Node 24。[Node.js 下载](https://nodejs.org/en/download) |
| pnpm | **11.9.0**。可用 `npm install --global pnpm@11.9.0` 安装，版本以根目录 `package.json` 为准。 |

使用 Homebrew 的 `node@24` 时，可按 `brew info node@24` 的提示把它加入 `PATH`。在克隆后的仓库根目录确认版本并启动 Web 和 API。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
git config --local core.hooksPath .githooks
pnpm dev
```

每次克隆后只需设置一次 `core.hooksPath`。提交前 Git 通过 `node --run lint` 直接运行与 `pnpm lint` 相同的全仓检查，其中一条规则会拦截生产 TS/TSX 的双重类型断言（如 `value as unknown as T`）。推送分支或标签更新时运行一次 `pnpm test`（单元和集成测试）。空推送或仅删除远端引用时直接结束。检查失败会阻止对应操作。Git 客户端的 `PATH` 需要能找到上表要求的 Node 和 pnpm。

TypeScript、Vite、Vitest、fast-check、Oxlint 和 Oxfmt 随仓库依赖安装。SQLite 使用 Node 内置模块。

打开 <http://127.0.0.1:5173>，首页应显示“服务连接正常”。API 默认健康地址是 <http://127.0.0.1:3000/health/ready>。若 3000 已被占用，macOS 和 Linux 可用 `PORT=3108 pnpm dev`，Vite API 代理会同步切换。

脚手架支持无密钥启动。需要配置外部服务时，以 `.env.example` 为模板创建本地配置。服务端与 Vite 依次加载根目录 `.env` 和 `.env.jev.local`，同名值以后一个文件为准，已有进程环境变量优先。

### 按任务安装工具

| 任务 | 安装和确认方式 |
| --- | --- |
| 浏览器验收 | 下载并打开 **ego lite** 桌面应用，完成首次引导以配置 `ego-browser` CLI 和 Skill。在新终端运行 `ego-browser skill` 确认可用。保持应用和浏览器运行，再执行 `pnpm test:e2e` 或 `pnpm qa`。[ego lite 下载](https://lite.ego.app/download) |
| 本地密钥扫描 | 安装 **gitleaks**，建议与 CI 使用同一版本 **8.28.0**。确认 `gitleaks version` 后运行 `pnpm secrets:scan`。[gitleaks 发布页](https://github.com/gitleaks/gitleaks/releases/tag/v8.28.0) |
| 本地代理独立审查 | 需要派发时，使用团队配置的 **Herdr** 与 **Devin CLI**，按约定的范围、超时和审查模型执行。[审查与执行边界](./AGENTS.md#64-审查与执行边界) |

### 安装 AI 协作 Skill

用 AI 接手开发时，安装 **pstack**，并在新会话让 Agent 先读根目录 `AGENTS.md`。先确定本轮交互、异常状态和验收标准，再定接口契约、分批实现、运行真实应用并独立审查。每阶段按实际任务选一个主 Skill。[开发流程](./AGENTS.md#6-skill-选择与开发流程)

在 Claude Code **会话内**执行官方插件安装命令。

```text
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
```

Cursor 可在会话内用 `/add-plugin pstack` 安装。其他客户端可按各自的 Skill 导入方式载入所需的上游 Skill 目录，并从 `SKILL.md` 读取规则。[pstack 官方安装说明](https://github.com/cursor/plugins/tree/main/pstack#install)

| 工作场景 | pstack 官方 Skill 名称 |
| --- | --- |
| 设计领域类型、状态和 API 契约 | `principle-type-system-discipline` |
| 阅读或编写 TypeScript / TSX | `typescript-best-practices` |
| 同类错误复发，按历史案例补结构约束 | `correct`、`principle-encode-lessons-in-structure` |

`AGENTS.md` 使用 `pstack-*` 名称。Claude Code 的官方插件使用 `pstack:` 命名空间，例如 `pstack-correct` 对应 `/pstack:correct`。安装后在会话的 Skill 列表核对入口。

- 需要原型、实跑或独立审查时，按阶段选择 `artifact-design`、`run`、`code-review` 或 `security-review` 等客户端提供的 Skill。浏览器操作使用 ego lite 提供的 `ego-browser`。[阶段分工](./AGENTS.md#61-日常功能开发)
- 团队自定义的 `plan-refactor`、`refactor-code`、`review-refactor` 和 `refactor-repository` 仅在对应重构任务中使用。需要安装时向维护者获取 Skill 说明，也可直接按仓库的重构流程执行。[重构流程](./AGENTS.md#62-按需重构)
- 需要澄清产品交互时，可从 Matt Pocock 系列选装 `grill-with-docs`，并把确认结果写回同一份 PRD 和验收标准。[Matt Pocock Skill 安装说明](https://github.com/mattpocock/skills)

## 目录与边界

```text
apps/server/             Node HTTP 入口、配置校验、pi-durable / SQLite 薄适配
apps/web/                React + Vite 移动端页面、PWA app shell
packages/core/           pi-schema 契约、提案版本绑定、时间约束纯函数
packages/model-gateway/  任务类路由表、pi-ai 模型注册入口、Jev SystemOne 意图传输
scripts/                 Node 版本、改动格式化、测试门禁、已有 Jev 探针
evals/                   合成用例与待接通的 Langfuse 实验入口
e2e/                     移动端启动和服务失败/重试测试
```

`core` 不依赖 durable、HTTP、SQLite 或模型网关。前端只使用 `core` 的公开契约；lint 约束依赖方向，禁止跨包相对导入、深导入、循环依赖及缺少 `node:` 前缀的内置模块导入。协作规则见 [AGENTS.md](./AGENTS.md)。生产构建使用各 package 的 `dist/`；`pnpm dev` 先构建共享包，再启动包监听器、API 和 Vite。

HTTP 目前只实现 `GET /health/ready` 和 `GET /health/capabilities`；使用 Node 内置 HTTP，尚未暴露 chord RPC。capabilities 如实返回 `stage: scaffold` 和未接入业务能力；其余 API 返回 `NOT_IMPLEMENTED`。

## 已编码的架构约束

- `RadarOutcome` 区分 `kind: empty` 与 `kind: recommendations`，无候选时不生成首选。
- 模型提案输入只允许候选 ID 与定性理由；数值、证据和版本由服务端输出契约承载。
- 验证引用绑定雷达会话、提案 ID/版本、候选池版本、ETA 版本及行程 ID/版本。`checkProposalBinding` 只检查绑定，不能代替完整业务闸门。
- durable 结果文档以雷达会话为 family key。SQLite 每用户一文件；进程内阻止同一路径重复打开写者。部署仍要求单进程，禁止多副本同时写同一用户文件。
- 尚未注册模型工具和行程写入 API；完整闸门、提案阶段的单工具约束、接受幂等事务和按引用删除将在业务闭环中实现。
- Jev 使用 `/v1/systemone`，传输不跟随重定向，遵守调用方传入的总 deadline。`unknown` 原样交还应用；`ATTEMPT_TIMEOUT` 与总 `DEADLINE_EXCEEDED` 分开，非法 JSON / schema / 概率分布通过受控 `reason` 区分；业务 fallback、预算账本、Langfuse 观测和置信阈值尚未接入。Score 暂不启用。

## 检查与测试

```sh
pnpm lint
pnpm format                      # 仅格式化改动代码与配置
pnpm format:check --all           # 检查所有工程代码，不处理 PRD / testdata
pnpm typecheck
pnpm test                        # AST 检查 only/skip/todo，再运行 unit + integration
pnpm build
pnpm test:e2e                    # 先在另一个终端启动 pnpm dev，并连接 ego-lite
pnpm qa                          # 含 ego-lite 验收；同样需要运行中的应用与桌面浏览器
```

单元/集成测试继续使用 Vitest + fast-check；集成测试使用真实 Node HTTP 与每用例独立目录的 SQLite，不调用外部服务，模型传输测试 mock fetch。`apps/`、`packages/`、`scripts/`、`e2e/` 中的 `*.test.ts(x)` / `*.spec.ts(x)` 共用扫描和收集范围，其中 `*.integration.test.ts(x)` / `*.integration.spec.ts(x)` 串行执行。`pnpm test`、`test:unit`、`test:integration` 都先构建共享包，跨包测试与生产使用同一公开入口。服务端和共享包的生产构建排除 `*.test.*` 与 `*.spec.*`。其门禁拒绝跳过、待办、零用例、无法解析的测试报告及扫描到但未执行的文件。

**浏览器验收使用 ego-lite（`ego-browser` CLI）**，连接已启动的本地应用与真实 API，不再安装另一套浏览器测试 SDK 或 Chromium。`pnpm test:e2e` 校验 390×844 页面、服务断线提示和恢复重试，使用 CDP 只阻断本页面的健康请求；结果和截图存入 Git 忽略的 `test-results/ego-*/`。必须完成全部 4 项并取得本次运行的新报告才算通过；CLI 缺失、浏览器未连接、应用未启动或报告缺失都会失败。查看 `mobile.png` 完成视觉确认。可用 `E2E_BASE_URL=http://127.0.0.1:5174 pnpm test:e2e` 指定其他本地端口，脚本只接受 loopback origin。取消探针覆盖网络拒绝、HTTP 503 和响应不符合契约三种情况，验证任一接口失败后，另一项悬挂请求随即取消，页面可重试。每次探针结束后重新加载页面，恢复真实 HTTP 客户端。

GitHub 托管 Linux CI 执行 lint、全量格式检查、类型检查、单元/集成测试、构建和依赖审计。同一分支有更新时会取消旧的代码检查。密钥检查独立并行运行，用固定版本的 Gitleaks 同时扫描检出的文件和 push/PR 引入的提交。新建分支或找不到原提交时，扫描新提交可达的全部历史。真实 `.env` 的本地目录豁免仅用于工作区扫描，提交历史使用完整规则。本地 `pnpm secrets:scan` 需要安装 Gitleaks。桌面浏览器验收在本机通过 `pnpm test:e2e` 执行。

```sh
pnpm test:model
pnpm test:model:local
```

这两个命令当前会明确退出 **1**：Langfuse 实验尚未实现。它们不进入 `qa`；接入真实数据集、应用网关、评分器和质量阈值后才能用于发布放行。

现有中转探针仍可单独运行，会产生真实 API 调用：

```sh
node --env-file=.env.jev.local scripts/probe-jev.mjs
node --env-file=.env.jev.local scripts/probe-jev.mjs --suite
```

`.env*` 真实配置、运行时 `data/`、依赖和构建产物不入库；`.env.example` 与用户已授权的 `testdata/` 入库。第三方截图和精确坐标不上传 Langfuse。

## 下一段实现

先使用用户确认的真实 POI 跑通“雷达筛选 → 提案 → 校验 → 用户接受 → 行程写入”，包含无候选、陈旧版本和重复接受分支。然后接多图导入、POI 消歧、行程草案及导航；全部 P0 范围保留。

详细设计见 [ARCH](ARCH_技术架构与选型.md)、[工程基线](ENGINEERING_工程化基线与Skill分工.md) 与 [待验证清单](VERIFY_待验证清单.md)。
