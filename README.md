# 下一站 NextStop

旅行机会雷达的 TypeScript 工程脚手架。当前提供可启动的 Web/API、共享契约、pi-durable + SQLite 适配和 Jev 原生意图传输；真实雷达、截图导入、行程写入和 Langfuse 实验仍待接入。

## 启动

使用 Node **>=24.18.0 <25** 和 pnpm **11.9.0**：

```sh
nvm use
pnpm install --frozen-lockfile
pnpm dev
```

Web：<http://127.0.0.1:5173>。API 默认：<http://127.0.0.1:3000/health/ready>。若 3000 已被其他服务占用，使用 `PORT=3108 pnpm dev`，Vite 的 API 代理会同步切换。

本机 Homebrew 的默认 Node 如果是 26，可先执行 `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`。服务端启动器按顺序加载根目录 `.env`、`.env.jev.local`，已有进程环境变量优先；仅加载环境不会触发模型调用。不需要 Key 也能启动脚手架。新环境可从 `.env.example` 复制模板；保留现有本地配置。

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

`core` 不依赖 durable、HTTP、SQLite 或模型网关。前端只使用 `core` 的公开契约，lint 禁止导入服务端和模型客户端。生产构建使用各 package 的 `dist/`；`pnpm dev` 先构建共享包，再启动包监听器、API 和 Vite。

HTTP 目前只实现 `GET /health/ready` 和 `GET /health/capabilities`；使用 Node 内置 HTTP，尚未暴露 chord RPC。capabilities 如实返回 `stage: scaffold` 和未接入业务能力；其余 API 返回 `NOT_IMPLEMENTED`。

## 已编码的架构约束

- `RadarOutcome` 区分 `kind: empty` 与 `kind: recommendations`，无候选时不生成首选。
- 模型提案输入只允许候选 ID 与定性理由；数值、证据和版本由服务端输出契约承载。
- 验证引用绑定雷达会话、提案 ID/版本、候选池版本、ETA 版本及行程 ID/版本。`checkProposalBinding` 只检查绑定，不能代替完整业务闸门。
- durable 结果文档以雷达会话为 family key。SQLite 每用户一文件；进程内阻止同一路径重复打开写者。部署仍要求单进程，禁止多副本同时写同一用户文件。
- 尚未注册模型工具和行程写入 API；完整闸门、提案阶段的单工具约束、接受幂等事务和按引用删除将在业务闭环中实现。
- Jev 使用 `/v1/systemone`，传输不跟随重定向，遵守调用方传入的总 deadline。`unknown` 原样交还应用；业务 fallback、预算账本、Langfuse 观测和置信阈值尚未接入。Score 暂不启用。

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

单元/集成测试继续使用 Vitest + fast-check；集成测试使用真实 Node HTTP 与每用例独立目录的 SQLite，不调用外部服务，模型传输测试 mock fetch。其门禁拒绝跳过、待办、零用例或无法解析的测试报告。

**浏览器验收使用 ego-lite（`ego-browser` CLI）**，连接已启动的本地应用与真实 API，不再安装另一套浏览器测试 SDK 或 Chromium。`pnpm test:e2e` 校验 390×844 页面、服务断线提示和恢复重试，使用 CDP 只阻断本页面的健康请求；结果和截图存入 Git 忽略的 `test-results/ego-*/`。必须完成全部 3 项并取得本次运行的新报告才算通过；CLI 缺失、浏览器未连接、应用未启动或报告缺失都会失败。查看 `mobile.png` 完成视觉确认。可用 `E2E_BASE_URL=http://127.0.0.1:5174 pnpm test:e2e` 指定其他本地端口，脚本只接受 loopback origin。

GitHub 托管 Linux CI 执行安装、lint、格式、类型、单元/集成测试、构建、依赖审计和 gitleaks；桌面浏览器验收在本机通过 `pnpm test:e2e` 执行，CI 通过不代表浏览器验收已通过。`pnpm secrets:scan` 需要单独安装 gitleaks；CI 使用固定版本容器。

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
