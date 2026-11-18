# 下一站 NextStop

在苏州旅行时，选择出发地、想去的地点和可用时间，查看步行估算，并确认把地点加到行程末尾。雷达和行程通过 Node HTTP 与每位匿名用户独立的 SQLite 文件连接。产品场景与验收标准见 [PRD](./PRD.md)。

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
| 本地代理独立审查 | 安装团队使用的 Herdr 和 Devin CLI。派发要求见[验证与授权](./AGENTS.md#验证与授权)。 |

### 安装 AI 协作 Skill

使用 AI 协作时，安装 **pstack**，从[项目协作入口](./AGENTS.md)找到当前任务的代码与测试。各阶段所需的 Skill 见[工程基线](./ENGINEERING_工程化基线与Skill分工.md#4-skill-分工)。

在 Claude Code **会话内**执行官方插件安装命令。

```text
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
```

Cursor 可在会话内用 `/add-plugin pstack` 安装。其他客户端可按各自的 Skill 导入方式载入所需的上游 Skill 目录，并从 `SKILL.md` 读取规则。[pstack 官方安装说明](https://github.com/cursor/plugins/tree/main/pstack#install)

工程基线中的 `pstack-*` 名称对应官方插件的 `pstack:` 命名空间，例如 `pstack-correct` 对应 `/pstack:correct`。安装后在会话的 Skill 列表核对实际入口。团队定制的重构 Skill 由维护者提供。产品澄清工具 `grill-with-docs` 可按需选装。[Matt Pocock Skill 安装说明](https://github.com/mattpocock/skills)

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

`GET /health/ready` 与 `GET /health/capabilities` 支持无密钥启动。要启用雷达，在本地环境中设置高德 Web 服务 `AMAP_SERVER_KEY` 和至少 32 字节的随机 `COOKIE_SECRET`（可用 `openssl rand -hex 32` 生成）。生产环境通过 HTTPS 发送会话 Cookie。配置完成后，首页可搜索苏州地点并确认追加到行程。`radar` 表示已配置，地图临时故障或限流会在具体请求上返回错误。

| 接口 | 用途 |
| --- | --- |
| `POST /api/v1/sessions` | 建立签名匿名 Cookie。同一浏览器刷新时继续使用原行程。 |
| `GET /api/v1/places?q=…` | 搜索可选地点，服务端保管地图密钥。 |
| `POST /api/v1/radar/sessions` · `GET /api/v1/radar/sessions/{id}` | 按出发地与时间生成或读取提案。默认联合召回未去收藏与附近地点，也支持指定一个 `poi_id`。 |
| `POST /api/v1/radar/sessions/{id}/accept` | 提交绑定、选中的 POI 和 `Idempotency-Key`。 |
| `GET /api/v1/trip` | 返回本人的行程，尚无行程时返回 `null`。 |

## 已编码的架构约束

- `RadarOutcome` 区分 `kind: empty` 与 `kind: recommendations`，无候选时不生成首选。
- 模型提案输入只允许候选 ID 与定性理由；数值、证据和版本由服务端输出契约承载。
- 验证引用绑定雷达会话、提案 ID/版本、候选池版本、ETA 版本及行程 ID/版本。`checkProposalBinding` 只检查绑定，不能代替完整业务闸门。
- durable 结果文档以雷达会话为 family key。SQLite 每用户一文件；进程内阻止同一路径重复打开写者。部署仍要求单进程，禁止多副本同时写同一用户文件。
- 确认选中的 POI 时，在同一事务中复核幂等、候选、ETA、时间窗口和行程版本，再写入停靠点及回执。联合召回最多核验六个候选，展示最多三个。配置 `ARK_API_KEY`、`ARK_MODEL_TEXT` 和 `ARK_BASE_URL` 后，pi-durable 只允许模型查询筛选结果和提出定性理由。
- 可选的 `RADAR_POLICY_PATH` 指向应用侧策展 JSON 数组。每项包含 `poi_id`、`state`（`required` 或 `not_required`）、`source`、`verified_at` 和 `valid_until`。缺少预约证据时页面显示待核验。
- Jev 使用 `/v1/systemone`，传输不跟随重定向，遵守调用方传入的总 deadline。`unknown` 原样交还应用；`ATTEMPT_TIMEOUT` 与总 `DEADLINE_EXCEEDED` 分开，非法 JSON / schema / 概率分布通过受控 `reason` 区分；业务 fallback、预算账本、Langfuse 观测和置信阈值尚未接入。Score 暂不启用。

## 检查与测试

```sh
pnpm lint
pnpm format                      # 仅格式化改动代码与配置
pnpm format:check --all           # 检查所有工程代码，不处理 PRD / testdata
pnpm verify:code                 # 一次构建，再做类型检查和单元/集成测试
pnpm test:e2e                    # 打开 ego-lite，脚本自启隔离的 Web/API
pnpm qa                          # 包含静态检查、生产构建、测试与浏览器验收
```

单独验证时可运行 `pnpm typecheck`、`pnpm test` 或 `pnpm build`。CI 与本地 `qa` 共用 `verify:code`，先生成生产产物，再用同一份共享包执行类型检查和测试门禁。

单元/集成测试继续使用 Vitest + fast-check；集成测试使用真实 Node HTTP 与每用例独立目录的 SQLite，不调用外部服务，模型传输测试 mock fetch。`apps/`、`packages/`、`scripts/`、`e2e/` 中的 `*.test.ts(x)` / `*.spec.ts(x)` 共用扫描和收集范围，其中 `*.integration.test.ts(x)` / `*.integration.spec.ts(x)` 串行执行。`pnpm test`、`test:unit`、`test:integration` 都先构建共享包，跨包测试与生产使用同一公开入口。服务端和共享包的生产构建排除 `*.test.*` 与 `*.spec.*`。其门禁拒绝跳过、待办、零用例、无法解析的测试报告及扫描到但未执行的文件。

**浏览器验收使用 ego-lite（`ego-browser` CLI）**。`pnpm test:e2e` 自启本地 Web/API 和临时 SQLite，用受控的高德协议响应验收地点选择、空态、回执丢失后的重试、刷新持久化和过期恢复。浏览器使用独立的 loopback 主机名与匿名 Cookie。健康检查覆盖断线、重试，以及网络拒绝、HTTP 503 和无效响应导致的同组请求取消。可用 `E2E_BASE_URL=http://127.0.0.1:5174 pnpm test:e2e` 指定健康检查所用的本地服务。业务写入始终进入临时数据库。每次运行在 `test-results/ego-*/` 留下新报告和 390×844 截图。

GitHub 托管 Linux CI 执行 lint、全量格式检查、`verify:code` 和依赖审计。同一分支有更新时会取消旧的代码检查。密钥检查独立并行运行，用固定版本的 Gitleaks 同时扫描检出的文件和 push/PR 引入的提交。新建分支或找不到原提交时，扫描新提交可达的全部历史。真实 `.env` 的本地目录豁免仅用于工作区扫描，提交历史使用完整规则。本地 `pnpm secrets:scan` 需要安装 Gitleaks。桌面浏览器验收在本机通过 `pnpm test:e2e` 执行。

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

## 雷达确认验收

本切片支持主动定位或手选出发地，计算至一个手选候选点的步行时间。同日锁定安排使用旅行时区，取固定截止与手选上限中较早的一项。固定安排场景暂用 40 分钟估计停留与 10 分钟缓冲，并核验候选地至固定地点的步行估算。无固定点时，新界面只计算去程与 20 分钟估计停留。普通去程步行上限为 5 公里，选「轻松步行」时为 1.5 公里。证据最长有效 5 分钟，确认后写入一项行程，固定安排保留。上次结果以只读方式回看，位置预览使用高德坐标示意。营业、预约和价格留待用户确认。以下场景使用真实 HTTP 和 SQLite 验收，详见[需求](./PRD.md#53-关键旅程-uj-02提前结束--机会雷达)与[写入约束](./ARCH_技术架构与选型.md#9-提交闸门与不变量)。

| 场景 | 可观察结果 |
| --- | --- |
| 用户确认当前有效提案 | 行程新增一项 |
| 同一确认请求重复提交 | 仍只有一项，返回同一次接受的结果 |
| 提案、候选池、ETA 或行程版本已变 | 拒绝旧提案，本次请求写入零项 |
| 确认可行候选为零 | 显示 `kind: empty` 对应的空态，行程保持原样 |

完整 P0 范围见 PRD。

## 单张截图与灵感库契约

使用 `POST /api/v1/sessions` 建立匿名会话。以下接口均使用同一访客 Cookie。苏州 POI 来自已有高德城市搜索。

| 接口 | 输入与结果 |
| --- | --- |
| `POST /api/v1/imports` | `multipart/form-data` 的单个 `image` 文件（PNG/JPEG，最多 5 MiB）。返回 `201 ImportReview`。 |
| `GET /api/v1/imports/:id` | 读当前 `ImportReview`，其中 `extraction` 区分文字、照片猜测和失败，`match` 区分候选、未查找和地图不可用。 |
| `GET /api/v1/imports/:id/image` | 返回访客自己的规范化来源图。 |
| `POST /api/v1/imports/:id/search` | JSON `{ query }` 搜索苏州 POI，替换当前候选，提升 `revision`，保留原来源。 |
| `POST /api/v1/imports/search` | JSON `{ query }` 创建手动补录核对记录，返回 `201 ImportReview`。 |
| `POST /api/v1/imports/:id/confirm` | JSON `{ revision, provider, poi_id }` 显式确认当前候选，返回 `200 WishlistPlace`。原请求重试回放回执。过期版本、无效候选和已确认的不同选择返回 `409`。 |
| `GET /api/v1/wishlist` | 返回 `200 { places: WishlistPlace[] }`，仅含已确认收藏。用 `(provider, poi_id)` 标识地点，用 `sources[].import_id` 引用来源。 |

共享类型与运行时校验从 `@nextstop/core` 导出，见 [wishlist-api.ts](packages/core/src/wishlist-api.ts)。来源区分图片与手动补录，图片来源可带文字片段。地点详情和草案可读取 `WishlistPlace`。图片识别使用 `.env.example` 中现有的智谱和火山配置。自动识别不可用时，仍可在地图服务已配置的情况下手动选择 POI。

### 批量导入与统一核对

批次使用同一匿名访客会话，契约见 [import-batch-api.ts](packages/core/src/import-batch-api.ts)。页面支持继续添加至 15 张后上传，可在当前标签页刷新后继续上次导入。

| 接口（前缀 `/api/v1/import-batches`） | 输入与结果 |
| --- | --- |
| `POST /` | multipart 重复 `images` 字段，1–15 张 PNG/JPEG，每张最多 5 MiB。返回 `202 ImportBatch`，有效图送入后台处理。 |
| `GET /:batch` | 读取批次修订与逐图状态。处理中可以读取已完成结果。服务中断后，未完成项在下次读取时可重试。 |
| `GET /:batch/items/:image/image` | 读取有权限的规范化来源图。 |
| `POST /:batch/items/:image/retry` | `{ revision }`，只重新处理选中的失败图，返回 `202 ImportBatch`。 |
| `POST /:batch/items/:image/search` | `{ revision, query }`，用苏州地图候选替换该图的匹配结果，返回 `200 ImportBatch`。 |
| `POST /:batch/items/:image/skip` 或 `/remove` | `{ revision }`，跳过当前项或移除未保存项及其原图与副本，返回 `200 ImportBatch`。 |
| `POST /:batch/confirm` | `{ revision, new_count, selections: [{ import_id, poi_id }] }`。服务端复核修订、当前候选和新增数，在同一事务保存所选来源，返回 `200 ImportBatch`。待处理项仍可继续核对。 |

本地回归使用合成截图、受控供应商和临时 SQLite。运行 `pnpm build:packages && pnpm exec vitest run apps/server/src/import-http.integration.test.ts apps/server/src/import-batch-http.integration.test.ts`。

详细设计见 [ARCH](ARCH_技术架构与选型.md)、[工程基线](ENGINEERING_工程化基线与Skill分工.md) 与 [待验证清单](VERIFY_待验证清单.md)。
