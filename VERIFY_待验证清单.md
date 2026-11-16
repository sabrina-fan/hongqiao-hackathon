# NextStop 待验证清单

查证日期：2026-11-15（初版） · 2026-11-16（复核 1.5.2 包源码、补齐 V10–V16）
标记：✅ 已查证（一手来源，可直接当约束用） · 🔴 阻塞项（开工第一天必须验） · 🟡 待验（不阻塞起步）

规则：**✅ 之外的任何一条，都不许在代码里当成已知事实。** 探针跑通并把实际输出贴回本文件，才升级为 ✅。

配套文档：[ARCH_技术架构与选型.md](./ARCH_技术架构与选型.md)（架构与选型） · [SETUP_平台开通指南.md](./SETUP_平台开通指南.md)（账号开通）。
本文件的 V1–V16 对应 ARCH §12 的未决项表。

---

## 1. ✅ 已查证：Pi 版本与特性矩阵

### 1.1 发布时间线（npm registry + GitHub Releases）

| 版本 | 发布时间 | 说明 |
| --- | --- | --- |
| durable 0.0.1 | 2026-09-19 | **首次发布，距今约 2 个月** |
| 1.0.0 | 2026-10-01 | |
| 1.4.0 | 2026-10-21 | |
| 1.5.0 | 2026-11-02 | 工具参数校验从 TypeBox 换成 pi-schema（破坏性）；新增 `beforeProviderRequest` |
| 1.5.1 | 2026-11-09 23:42 | **实质性发布**，116 行说明 |
| 1.5.2 | 2026-11-10 12:21 | 1.5.1 之后 **12.6 小时**；GitHub Release 说明全是 coding-agent；durable tarball 与 1.5.1 仅差版本/依赖/CHANGELOG |

dist-tags：`pi-durable` / `chord` / `pi-schema` **只有 `latest`**。`pi-ai` / `pi-agent-core` 多一个 `legacy-node20: 0.74.2`。

**结论：不存在"更稳定的旧版"这条退路。**
- 没有 `stable` / `lts` / `beta` 通道，`latest` 就是唯一发布线。
- `legacy-node20` 是 **Node 20 兼容线**，不是稳定线；而且 **durable 没有这个 tag**。
- 整个包 2 个月大，任何版本都没有"经过长期生产验证"这回事。

### 1.2 特性下限（grep 各 tag 的官方 README）

| 特性 | 1.4.0 | 1.5.0 | 1.5.1 | 1.5.2 | main（未发布） |
| --- | --- | --- | --- | --- | --- |
| `beforeProviderRequest` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `onYield`（同步版） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `structuredOutputSchema` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `callers` / `modelTools` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `defineDoc` `history:"rewindable"` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `requestId` 幂等 | ✅ | ✅ | ✅ | ✅ | ✅ |
| `runEndTask()` | ✅ | ✅ | ✅ | ✅ | **改名 `hookTask()`** |
| `createNodePhotonImages` | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`### Signals`** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **`### Tools that park`** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **`### Gates before a tool runs`** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **`### Work before an answer stands`** | ❌ | ❌ | ❌ | ❌ | ✅ |
| `defineSignal` / `harness.signal()` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `api.memo()` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `beforeTool` 返回 `{sleep}` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `createFitImagesExtension` / `/images/fit` | ❌ | ❌ | ❌ | ❌ | ✅ |

证据：`packages/durable/README.md` 在 v1.5.2 是 **986 行**，在 main 是 **1154 行**；main 的 `package.json` 仍写 `"version": "1.5.2"` → 那批功能是**未发布的在途代码**。

pi-ai 侧：`constrainedSampling` / `createProvider` / `supportsStrictMode` / `fauxProvider` / `thinkingFormat` / Cross-Provider Handoffs / `classify` **在 1.4.0 就全部存在**。约束来自 durable，不是 pi-ai。

### 1.3 版本选定：1.5.2（精确锁，不用 `^`）

推理链：
1. `beforeProviderRequest` 是网关改写请求体的钩子 → **下限 1.5.0**，1.4.0 出局。
2. 1.5.1 修了两个直接影响我们的 bug：
   - Anthropic 非严格工具 schema 丢失根级 `$defs` / `definitions`，导致 `$ref` 指向空 → 模型产出错误参数（我们的 POI 契约会用 `$ref`）。
   - `strict:"prefer"` 工具被拒后每次请求仍重发 strict，每轮白烧一个 400。
   → **1.5.0 出局**。
3. 1.5.2 的 GitHub Release 说明全部是 coding-agent 的 session fork / TUI 高亮 / Anthropic OAuth 版本号 → **durable 本体没有用户可见变更**。
4. 所以 1.5.1 与 1.5.2 对我们等价，取 1.5.2。
5. **tarball 实测（2026-11-16）**：`npm pack @earendil-works/pi-durable@1.5.1` 与 `@1.5.2` 解包后 `diff -qr` 只有 `CHANGELOG.md`、`package.json` 两处差异；`dist/` 逐字节相同。`package.json` 只改版本号和 `chord` / `pi-ai` / `pi-codemode` / `pi-schema` / `pi-telemetry` 五个依赖号。**durable 本体在 1.5.2 没有代码变更。** 兄弟包 `chord` 1.5.2 新增 `./compression` 子路径，`pi-ai` 只改版本/Anthropic stealth 版本/provider 数据；按整线 1.5.2 锁定，不混装 1.5.1/1.5.2。
6. **main 不是候选**：main 的 `packages/durable/package.json` 仍写 `"version": "1.5.2"`，`CHANGELOG.md` 是 `[Unreleased]`，含 `HookTask` 改名、tool park、`until` 可选、`pi.tool` v4 / `pi.generation` v3、codemode namespace 重写等破坏性变更；新 DB schema 旧 Harness 不认（`task_too_old`）。另外 `raw.githubusercontent.com/.../main/packages/durable/dist/index.js` 返回 **404**，main 只有 `src/`，没有 npm tarball 里的 `dist/`；`github:` 依赖需要自行构建整个 monorepo。**只读 main，不安装。**

**1.5.1 和 1.5.2 都不含 Signals / park / memo / fit。** 上一轮推荐里引用了这些，属于把 main 当成已发布，已更正。

### 1.4 Experimental 的实证

`runEndTask()` → `hookTask()` 的改名发生在 1.5.2 之后的 main 上，README 头部原话「API changes without notice between releases」不是免责套话。对策不变：锁精确版本 + 业务逻辑写纯函数 + durable 只做薄适配。

### 1.5 ✅ 已查证的 1.5.2 机制细节（逐条 grep v1.5.2 README + dist 类型确认）

写架构文档时逐个核对过的 API 名与取值，**全部在已发布版本里存在**：

| 项 | 确认内容 |
| --- | --- |
| `defineDoc` 的 `fork` | 三个合法取值：`"initial"` / `"current"` / `"asOf"` |
| `defineDoc` 的 `scope` | 三种：`"session"` / `"conversation"` / `"task"`；`history`/`fork` 只属于 conversation doc |
| doc 写入 API | `Tx` **没有** `set()`；`tx.doc(token, conversationId)` 返回 `Draft<T>`（chord 的事务内可变视图），在 `commit(tx => ...)` 回调里原地改字段。`retireDoc` 用于删除 |
| `defineTool.execute` 签名 | `(args, api, context)`；`api.commit(change, context)` 的第二个参数就是该 `context` |
| `HarnessOptions.conversationCreated(tx, conversation)` | 在**每个创建或 fork 会话的 commit** 里运行，含工具直接调 `tx.createConversation()` |
| 延迟持久化的生效条件 | **仅**「除已有 doc 外什么都没改，且那些 doc 是 `history:"latest"` + `fork:"initial"`」的 commit。`rewindable` + `current` 的快照**永不延迟，每次 commit 立即落盘** |
| transcript 存储通道 | **只存 `output` + `details`**；`structuredOutput` 给调用工具的程序，不落 transcript。提案必须另写 doc |
| `onYield` 调用路径 | 只在 `answer()`（最终答案）里调用；**`terminate` 轮走 `finishToolRound()` → `endRun()`，不经过 `onYield`** |
| `onYield` 时序 | 在答案提交前调用；`{continue}` 不会 `endRun`，提交等到最终答案；但中间答案会 `appendAssistant` 进 transcript |
| `afterRun` 时机 | 最终答案或 terminate 轮之后；`onYield` 续跑期间不运行；失败/中止后不运行 |
| 图片模块路径 | `@earendil-works/pi-durable/images/node`（另有 `/images/cloudflare`、`/images` 的 `createPhotonImages(wasm)`） |
| Photon worker | `/images/node` 在 worker 线程准备图片，不阻塞事件循环；30s 无图退出释放 WASM 内存，可配 `{ worker: false, idleMs }` |
| `whenBusy: "reject"` | 抛 `ConversationBusy`；另有 `whenIdle: "reject"` 抛 `ConversationIdle` |
| 同步观察者 | `observeConversation` / `observeDoc` / `observeTaskGraph`；`advance` **只记录变更：无 await、无 Harness 调用、不抛异常、要快**（每个 commit 都等它）。抛异常会被报告、detach、以 `listener_error` 结束 |
| `maxTurns` 与 `onYield` | **`maxTurns` 不约束 `onYield` 循环**，每次打回计数重新开始，扩展必须自己设上限。详见 V6 |

---

## 2. ✅ 已查证：智谱/火山结构化输出（官方文档 + 实测）

### 2.1 两套机制，别混

| | 工具参数严格约束 | 回复体严格 JSON Schema |
| --- | --- | --- |
| 参数 | `tools[].function.strict` | `response_format.json_schema.strict` |
| 智谱文档 | 官方未确认 strict | 未确认 |
| 火山文档 | 官方未确认 strict | 未确认 |
| 结论 | **不可依赖** | **不可依赖** |

pi-ai 的 `constrainedSampling` 走的是**左边那列**。所以：
- `strict: 'require'` → `compat.supportsStrictMode` 对未知 endpoint 默认 `false` → **直接失败**。
- `strict: 'prefer'` → 静默降级成普通 tool calling，**你以为有约束其实没有**。
- **本项目默认显式 `constrainedSampling: false`**，靠闸门保证，不靠提供方。

### 2.2 🔴 多模态静默降级（最重要的一条）

智谱 GLM-5.3-Flash 官方文档只写「支持 JSON 等结构化格式输出」，没有列 `json_schema` strict；火山 Doubao 的 Chat API 也未确认工具/响应格式的 `strict`。两家统一按 `supportsStrictMode: false` 处理：schema 只当提示，**闸门仍做全量校验**，不把「模型说它符合 schema」当事实。

对策：截图抽取的输出**一律**当不可信数据，闸门做完整确定性校验 + 一次修复重试。

### 2.3 ✅ Schema 关键字黑名单（按最严处理）

| 类型 | **禁用** |
| --- | --- |
| `number`/`integer` | `multipleOf` |
| `array` | `uniqueItems`、`contains`、`minContains`、`maxContains`、`additionalItems` |
| `object` | `patternProperties`、`propertyNames` |

公共关键字：
- `$defs` + `$ref`：本地引用支持；外部 URL 引用不生效
- `anyOf`/`oneOf`/`allOf`/`not`：支持，但 `oneOf` 不严格保证 exactly-one 语义
- `if`/`then`/`else`：支持
- `enum`/`const`：支持
- `title`/`description`/`default`/`examples`：只作语义提示，**不参与硬校验**

**直接执行，不用验**：契约里禁用 `multipleOf`、`uniqueItems`、`contains`、`patternProperties`、`propertyNames`；"绝不凑三个"用 `maxItems: 2` 表达（支持），不用 `uniqueItems`。

### 2.4 ✅ 其他硬约束

- **开启结构化输出时 `max_tokens` 要给足** —— 设置后可能导致 JSON 字符串被截断，产生无效 JSON。本项目统一用 `max_tokens`（pi-ai `maxTokensField: 'max_tokens'`），但按任务类给足额度；**截断不 repair，直接判失败**。
- **智谱/火山不支持 `tool_choice: "required"`** —— 非思考模式下无法保证一定调用工具，思考模式下直接不支持。→ 不能靠强制工具调用来保证模型走 `submit_proposal`，要靠闸门 + `onYield` 打回。
- JSON Object 模式要求提示词含 "JSON" 关键词，否则 400：`'messages' must contain the word 'json' in some form`。JSON Schema 模式无此要求。
- 官方自己建议：JSON Object 模式的输出**必须**下游校验（点名 Ajv / jsonschema），失败走重试或大模型改写。→ 与我们的闸门设计一致。

### 2.5 ✅ base_url：新旧都可用，默认用业务空间专属域名

智谱标准端点：`https://open.bigmodel.cn/api/paas/v4`；Coding Plan 端点：`https://open.bigmodel.cn/api/coding/paas/v4`。火山标准端点：`https://ark.cn-beijing.volces.com/api/v3`；Agent Plan 端点：`https://ark.cn-beijing.volces.com/api/plan/v3`。

[SETUP_平台开通指南.md](./SETUP_平台开通指南.md) 第 78 行保留旧域名作为对照。最终用哪个由 Key 的归属决定，见 V1。

---

## 3. 🔴 阻塞项：开工第一天必须跑通

### V1 — base_url 到底用哪个 ✅（2026-11-16 实测 200）

**✅ 实测（2026-11-16）**：智谱 `https://open.bigmodel.cn/api/coding/paas/v4`（Coding Plan）与 `https://open.bigmodel.cn/api/paas/v4`（标准）都返回 200；火山 `https://ark.cn-beijing.volces.com/api/plan/v3`（Agent Plan）与 `https://ark.cn-beijing.volces.com/api/v3`（标准）都返回 200。

**结论**：Coding Plan Key 配 Coding Plan 端点；标准 Key 配标准端点；plan 模式风险自担。

**影响**：网关 provider 的 `baseUrl`、开通指南 §1 / §2 / §5。

---

### V2 — 工具参数 strict 是否真的不支持 ✅（2026-11-16 实测：接受字段，诱导未越界，仍按不支持处理）

**已查官方文档（2026-11-16）**：智谱/火山的 Function Calling 文档未确认 `strict`；工具参数只写 `type/properties/required`，没有「严格校验」的承诺。

**✅ 实测（2026-11-16，curl，Coding Plan / Agent Plan）**：

| 上游 | `strict:true` 正常调用 | `strict:true` + 诱导加字段 | 无 strict + 诱导 |
| --- | --- | --- | --- |
| 智谱 `glm-5.3-flash` | 200，工具调用正常（`{"city":"苏州","name":"金鸡湖"}`） | 200，**args 仍只有两个字段**，模型在 content 里解释「不支持 score」 | 200，同样没加字段 |
| 火山 `doubao-seed-2-1-lite` | 200，正常 | 200，同样没加字段 | 200，同样没加字段 |

**结论**：两家都接受 `strict:true` 不报 400；诱导测试里模型自身也没越界（不能区分是 strict 约束还是模型自觉）。**按不支持处理的决定不变**：`constrainedSampling` 默认 false，`compat.supportsStrictMode: false`，闸门承担全量校验。
**影响**：所有工具的 `constrainedSampling` 取值；`compat.supportsStrictMode` 是否设 true。

---

### V3 — json_schema strict 在目标模型上真的生效 🟡（诱导测试未越界；无法区分约束与自觉，仍按不生效处理）

**已查官方文档（2026-11-16）**：智谱 GLM-5.3-Flash 模型页只写「支持 JSON 等结构化格式输出」，没有列 `json_schema` strict；火山 Doubao 的 Chat API 也未确认工具/响应格式的 `strict`。两家统一按 `supportsStrictMode: false` 处理：schema 只当提示，**闸门仍做全量校验**，不把「模型说它符合 schema」当事实。

**为什么重要**：`reason.explain` / `reason.plan` 打算用它。清单上有名字 ≠ 我们的账号/地域能调；两家上游的 strict 能力也不能互相推定。

**怎么验**：

```bash
curl -sS -X POST "${BASE_URL}/chat/completions" \
  -H "Authorization: Bearer $ZHIPU_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "model":"glm-5.3-flash",
    "messages":[{"role":"user","content":"给出苏州姑苏区两个适合傍晚去的地方，只要名字"}],
    "response_format":{"type":"json_schema","json_schema":{
      "name":"picks","strict":true,
      "schema":{"type":"object","properties":{
        "picks":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"maxItems":2}
      },"required":["picks"],"additionalProperties":false}
    }}
  }'
```

**判据**：输出是否严格符合 schema；`maxItems: 2` 是否被遵守。逐个模型记录，形成**我们自己账号的可用矩阵**，不照抄文档。

**补充（本项目实际形态）**：把 `response_format` 换成 `{"type":"json_object"}` 再打一次，确认 `glm-5.3-flash` 返回 200 且是 JSON 对象。我们**不依赖** `json_schema` strict；`json_object` 只保证语法，字段校验由 pi-schema 在应用侧做（ARCH §7.1.1）。

**✅ 实测（2026-11-16，诱导越界）**：两家 `json_schema strict` 在诱导「返回 4 个地点 + 额外字段 score/note」时都仍返回 2 个地点、0 个越界字段（智谱首跑 `max_tokens` 给小了截断，加大到 2048 后合规输出）。**仍无法区分是 strict 真生效还是模型自觉**；结论不变：`supportsStrictMode: false`，schema 只当提示，闸门全量校验。
**影响**：任务类 → 模型映射表；`vision.extract` 的请求体。

---

### V4 — 多模态降级是静默的，实测确认 🟡（官方已确认降级）

**已查官方文档（2026-11-16）**：智谱/火山均未明确列出多模态 + `json_schema` 的支持矩阵；按最严处理，假定多模态输入不支持 `json_schema`，会自动降级为 `json_object`，schema 约束不生效。

**怎么验**：V3 的请求体加一个 `image_url` 内容块，其余不变，用 GLM-5.3-Flash 或 Doubao 2.1 Lite 打。

**判据**：是否仍返回 200；输出是否还符合 schema；响应里有无任何降级标记。**若 200 且 schema 不再被遵守 → 确认静默降级**，`vision.extract` 路径必须全量闸门校验。
**影响**：截图抽取的校验强度；是否需要在网关侧主动拒绝"带图 + json_schema"的组合并显式降级。

---

### V5 — pi-ai 的 compat 对两家上游该怎么配 ✅（2026-11-16 实测通过）

**已查 1.5.2 包（2026-11-16）**：✅ `OpenAICompletionsCompat` 有 `supportsStrictMode?: boolean`；`thinkingFormat` 的合法值包含 `"qwen"`、`"zai"`、`"deepseek"`。源码映射：

| `thinkingFormat` | 有 `reasoningEffort` | 无 `reasoningEffort` |
| --- | --- | --- |
| `zai` | `thinking: { type: 'enabled', clear_thinking: false }` +（若 `supportsReasoningEffort`）`reasoning_effort` | `thinking: { type: 'disabled' }` |
| `deepseek` | `thinking: { type: 'enabled' }` +（若 `supportsReasoningEffort`）`reasoning_effort` | 若 `thinkingLevelMap.off !== null` → `thinking: { type: 'disabled' }` |
**为什么重要**：两家上游的思考开关字段不同；配错会发出对方不认的字段。**原先担心「GLM-5.3-Flash 只能开思考」——2026-11-16 实测证伪**：Coding Plan 端点接受 `thinking:{type:'disabled'}`，视觉工具调用从 14s 降到约 6s，reasoning tokens 归零。

**✅ 实测结果（`@earendil-works/pi-ai@1.5.2` + `openAICompletionsApi()`，真实 Key）**：

| 上游 | 端点 | 结果 |
| --- | --- | --- |
| 智谱 `glm-5.3-flash` | `https://open.bigmodel.cn/api/coding/paas/v4` | 无 `reasoningEffort` → 发 `thinking:{type:'disabled'}`，接受；视觉 + 强制工具 6.1s、0 reasoning tokens；`reasoningEffort:'max'` 接受，8.5s、93 reasoning tokens；`response_format: json_object` 200；`max_tokens` 200 |
| 火山 `doubao-seed-2-1-lite-260915` | `https://ark.cn-beijing.volces.com/api/plan/v3` | 无 effort → `thinking:{type:'disabled'}`，0 reasoning tokens，0.8s；`json_object` 与 `json_schema strict` 都 200 |

**同一 Key 的智谱 Anthropic 兼容端点**：`https://open.bigmodel.cn/api/anthropic` 的文本、图像、强制工具调用都返回 200；但 `thinking:{type:'disabled'}` 被忽略（仍产出 thinking 块），且没有 `response_format`。运行时统一走 OpenAI 兼容端点。

**怎么验（换 Key / 换账号时重跑）**：两个 provider 分别建，`compat` 逐项试：

```ts
// 智谱
const zhipuCompat = {
  thinkingFormat: 'zai' as const,
  supportsReasoningEffort: true,   // 实测 max 可用；默认不传 = disabled
  maxTokensField: 'max_tokens' as const,
  supportsStrictMode: false,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
};

// 火山方舟
const arkCompat = {
  thinkingFormat: 'deepseek' as const, // Doubao 用 thinking.type=enabled/disabled
  supportsReasoningEffort: true,       // 支持 reasoning_effort=minimal 关思考
  maxTokensField: 'max_tokens' as const,
  supportsStrictMode: false,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
};

```

> `compat` 是 **Model** 的字段，不是 `createProvider()` 的字段。把上面两个对象分别放进对应 `models: [{ id, compat, ... }]` 的模型定义里；`createProvider()` 只负责 provider 级配置（id/baseUrl/auth/api）。

✅ 已确认（2026-11-16）：

- **智谱**：不传 `reasoningEffort` 时发 `thinking:{type:'disabled'}`，接受；`reasoningEffort:'max'` 接受；`high`/`medium` 未测，先不用。视觉 + 强制工具、`json_object`、`max_tokens` 均 200。
- **火山**：不传 `reasoningEffort` 时发 `thinking:{type:'disabled'}`，reasoning tokens 归零；`json_object` 与 `json_schema strict` 都 200；图片 + 工具同轮未测（视觉兜底时再验）。
- **两家**：`max_tokens` 都接受；`supportsStore` / `supportsDeveloperRole` / `supportsUsageInStreaming` 未报错；`supportsMidConvoSystemMessages` 要等 durable 集成时再验。
- **所有 `supportsStrictMode` 仍为 `false`**；`constrainedSampling` 显式 `false`；`json_schema` 只当提示，闸门做全量校验。

**判据**：记录「发出什么 / 上游回什么」。本轮已用 `@earendil-works/pi-ai@1.5.2` 的 custom provider 端到端跑通，不再只靠 curl。
**影响**：两个 `createProvider` 的 `compat` 定义；ARCH §6.4。
**别踩**：pi-ai 内置 `zaiProvider()` 的 baseUrl 是 `https://api.z.ai/api/coding/paas/v4`；运行时用自定义 provider 指向 `https://open.bigmodel.cn/api/coding/paas/v4`（plan）或 `/api/paas/v4`（standard）。

---

### V6 — `onYield` / `terminate` 与闸门落点 🟡（已查证，降级）

**为什么重要**：这是"模型只能 propose、不能写用户状态"不变量的落点。**结论：主闸门不能放在 `onYield`。**

**✅ 2026-11-16 复核 1.5.2 npm 包源码（`dist/harness/generation.js`）**：

1. `onYield` 只在 `answer()`（最终答案）里调用；`terminate` 轮走 `finishToolRound()` → `endRun()`，**不经过 `onYield`**。`candidates.propose` 正是 terminate → 如果闸门放 `onYield`，它根本不会跑。
2. `onYield` 在答案提交前调用；返回 `{continue}` 时不会 `endRun`，提交等到最终答案——所以 `wait()` 不会在首次答案 resolve（原文档担心的点不成立）。
3. 但被打回的中间答案会 `appendAssistant` 进 transcript；前端订阅 entries 会看到"半个结论"，必须只渲染最终答案/proposal doc。

**已查证的其它事实**：
- `maxTurns` 不约束 `onYield` 循环，每次打回计数重新开始；框架不兜无限循环。`maxTurns` 触顶时该轮工具仍跑完，run 以 `unanswered` + `turn_limit` 结束；答案不会被截断。
- `afterRun` 在最终答案或 terminate 轮之后运行；`onYield` 续跑期间不运行；失败/中止后也不运行。

**设计结论（已落地到 ARCH）**：`candidates.propose` 写 `nextstop.proposal` doc + `terminate`；应用端读 doc 跑 `checkProposal` 纯函数闸门；不合格 `submit` 修复（≤2）或确定性兜底。**主闸门不再依赖 `onYield`。** `onYield` 只保留为**非终止**最终答案的可选打回，且要自己限次。

**✅ 补测（2026-11-16，真实 `pi-durable@1.5.2` Harness + `fauxProvider`）**：`onYield` 第一次返回 `{continue:"redo please"}` 时，transcript 里**确实写入**了被拒的中间答案 `pi.assistant` 条目（entry 10，内容为 `FIRST-ANSWER-BAD`）以及 continue 的 `pi.user` 条目（entry 11）；第二次答案（entry 13）才是最终答案。所以：**前端订阅 `conv.entries()` 会看到被打回的中间答案，必须只渲染最终 `pi.assistant`/`nextstop.proposal` doc 或按 entry 序过滤。** 若用 `onYield` 备选路径，打回上限 2。
**影响**：闸门实现位置（应用端）；前端只渲染最终答案/proposal doc，UI 不能信任「每个 assistant 条目都是最终答案」。

---

### V7 — 用户确认（导航 / 行程插入）✅（已定为设计，不再是候选）

**结论**：确认放在 agent 之外，已经是选定设计，不是待验方案。

```
模型写 proposal doc + terminate
  → 应用端 checkProposal
  → SSE 给前端（不写入）
  → 用户确认
  → 应用端自己执行 trip.write / trip.lock / trip.undo / nav.launch
  → （可选）submit 一条新输入告知结果
```

**为什么成立**：1.5.2 的 `beforeTool` 不能 sleep，`defineSignal` / `harness.signal()` 未发布；但这条路完全不需要 park。写入是应用端函数，默认不注册工具；即使注册，`callers: ["tools"]` + 不进 `modelTools`，模型在协议层看不到。`modelTools` 只能收窄不能扩宽。

**仍需验的只是应用端细节**（不是 Pi 能力）：
- `/accept`、`/confirm` 的 `Idempotency-Key` 是否只写一次（PRD TC-11）；
- `trip` 的 `revision` 乐观锁在多标签页下的冲突处理；
- 删除/撤销（`DELETE /trips/{id}`、`trip.undo`）是否覆盖已写入的 doc 与对象存储。

**不做的方案**：B 自定义 task + `sleepUntil` 轮询；C 等 Signals 发布。记录为未来简化点。

---

## 4. 🟡 部署、合规与数据源验证（V8–V16）

### V8 — 部署目标已定：`heirloom-lite` 跳板机 🟡

**用户已确认（2026-11-16）**：部署目标是 `heirloom-lite` 项目的**阿里云跳板机**（Linux ECS）。

⚠️ **但仍有一个主机级歧义**：`heirloom-lite` 的运维文档把阿里云跳板当作 SSH/隧道入口，真正的生产机在它后面。用户说的「部署到这个跳板机上」可能指（a）跳板机本机，或（b）经跳板访问的生产机/新机器。**部署前必须确认是哪一个**——把公开 Web 服务跑在堡垒机上会增加攻击面，也可能违反该项目的运维约束。

**已知**：它是 Linux ECS，原则上能跑长驻 Node 进程；但以下全部**未上机确认**：
- OS 发行版与版本；是否有 root / sudo；是否允许装 systemd 服务。
- Node 版本。`pi-durable@1.5.2` 与 `pi-ai@1.5.2` 的 `engines.node` 都是 **`>=22.19.0`**；低于这个版本必须先装 22 LTS。
- 持久盘挂载点与容量；`/opt` 是否在系统盘上。
- 可用端口/域名；Nginx 是否共用；能否加 `server` 块而不动默认 server。
- 出网是否放行智谱/火山/高德。
- 共享跳板机的资源配额与 owner 约束。

**怎么验**：按 SETUP §7.1 先跑只读探测（`uname -a`、`node -v`、`df -h`、`systemctl --version`、`nginx -v`、`ss -lntp`），再和 owner 确认「能否常驻一个 Node 进程 + 加一个 Nginx server 块」。

**判据**：能跑**单写 Node 进程 + 持久 `DATA_DIR` + Nginx 反代 SSE**。若 Node < 22.19，先解决运行时；若不能加 systemd/Nginx，改用 owner 允许的守护方式，但**不能出现第二个写者**。
**影响**：部署形态；SETUP §7.1；若持久盘不成立转 V9 分支。

### V9 — 跳板机持久盘（决定 SQLite 能不能用）🟡

**为什么重要**：durable 的 `openNodeSqliteStorage(file)` 要一个能跨重启存活的文件；**单进程写，无跨进程锁**。

**已知（2026-11-16）**：目标是 `heirloom-lite` 跳板机（阿里云 ECS），但尚未上机确认它的系统盘/数据盘是否持久、重装或重建实例时是否保留。ECS 系统盘通常随实例生命周期保留，但**「通常」不能当已知事实**；必须在目标环境实测。

**怎么验**（SETUP §7.1 有完整命令）：
1. 在 `DATA_DIR` 写一个带时间戳的文件。
2. `systemctl restart nextstop` → 文件还在？
3. 与 owner 约时间重启整台 ECS → 文件还在？
4. 如果部署流程会重建实例/换盘，再走一次「更新/重建」→ 文件还在？

**判据与分支**：
- 有持久卷 → `openNodeSqliteStorage`，WAL + `synchronous=NORMAL`（进程崩溃可存活，断电/宿主故障可能丢最新一条）。
- 无持久卷但可跑 Cloudflare Durable Object → 不适用于跳板机；除非另找托管。
- 两者都无 → 外部数据库（如同 VPC 的 RDS/Postgres），走 `/storage/sqlite` 可移植核心 + 自定义 `SqliteDatabase` facade，并跑 `registerStorageConformance()` 一致性套件。
- **不要在无持久盘的情况下硬用本地 SQLite 并宣称数据安全**；重启即丢是产品事故。

**影响**：存储适配器选型。**架构不变，换的是适配器。**

### V10 — `/v3/distance` 的方向与「1→N」✅（方向已定，反向对称仍需实测）

**已查官方文档（2026-11-16）**：✅ `origins` **支持 100 个坐标对**；`destination` 文档只给单个 `lon,lat`；`type=0` 直线、`1` 驾车（仅国内坐标）、`3` 步行（仅 5km 内）；每个 result 有 `info`/`code`，官方明确「建议不论批量与否用此字段判断请求是否成功」。**方向只能是 multiple origins → one destination**，1→N 不能一次完成。

**为什么重要**：ARCH 早先写「一次调用算完 100 个候选的步行 ETA」，但官方文档是 `origins`≤100、`destination` 单个。雷达需要 **1 个 origin（当前位置）→ N 个候选**；接口方向是 **N 个 origins → 1 个 destination**。这条不确认，可行性筛选的调用次数和方向都会错。

**怎么验**：
1. 用 `origins=current&destination=candidate_A` 和 `origins=current&destination=candidate_B` 各打一次，确认不能一次传多个 destination。
2. 反向：`origins=A|B|...&destination=current`，看 `results[]` 是否按 origin 返回，`info` 是否逐条。
3. 选 10 对古城内步行点，比较 A→B 与 B→A 的 `distance/duration` 差异；记录是否可近似对称。
4. 传一个 >5km 的 origin，记录 `type=3` 的返回/错误。

**判据**：方向已确认；实测步行反向差异在可接受范围（建议 <10%）才允许标 `reverse/estimated`；驾车不做对称假设；记录 >5km `type=3` 的实际错误码。
**影响**：`geo.batch_walk_eta` 契约、`eta_snapshot.by_leg`、§5.2、§8.2。

### V11 — POI detail 批量与营业覆盖 ✅（2026-11-16 实测）

**已查文档（2026-11-16）**：官方 detail 返回表不含 `opentime_today` / `opentime_week`——这两个字段只在 `/v5/place/text`（关键词搜索）的 business 里出现。详情不能替代搜索拿营业时间。

**✅ 实测（2026-11-16，`AMAP_SERVER_KEY`，苏州 POI）**：

- **detail 批量上限不是 10**：一次传 10/15/20/22/25/30/35 个唯一 id 全部返回（官方文档写 ≤10，实测远超；**实现上建议仍按 ≤25 分批，留余量**）。
- **detail 的 business 里约 4/10 有 `opentime_today`**（与文档一致：detail 不含该字段是「部分有返回」而非全部，**不能当营业时间来源**）。
- **`/v5/place/text` 的营业时间覆盖**：12 个苏州 POI 中 4 个有 `opentime_today`（平江路/金鸡湖/寒山寺/观前街/东方之门 5/12 有值），`cost` 全部缺失，`rating` 大部分有。**营业时间缺失率约 60%，必须靠 `policy.json` 策展表补，缺失标 `unknown`。**
- **`/v3/distance` origins 上限**：100 个 origins 返回 100 条；传 101 个静默截断到 100（`count` 字段=100），不报错。
- **步行 5km 限制是文档口径，接口不拦**：origin 距 destination ~97km 也正常返回 `distance=96822m`；**超 5km 的步行 ETA 由应用侧判 `WALK_TOO_FAR`，不能指望接口拒绝。**
- **步行 A→B 与 B→A 同值**（1992m 对称）；两 destination 直返 `INVALID_PARAMS`。
- **QPS 实测约 5/s**（连续 12 次 `place/text` 第 6/7/11 次触发 `CUQPS_HAS_EXCEEDED_THE_LIMIT`，1s 后恢复）。**所有高德调用要带限速器 + 429/QUOTA 重试退避。**

**判据达成**：top N 用一次 detail 批量；营业时间从 search/`policy.json` 取，缺失标 `unknown`；distance 分批 ≤100 且应用侧管步行超距。
**影响**：`candidates.screen` 的 REST 次数、证据状态、限速器设计、PRD TC-14。

### V12 — 预约数据源 ✅（2026-11-16 实测：高德无任何预约字段，策展表是唯一解）

**已查文档（2026-11-16）**：高德旧版 POI 返回里的 `meal_ordering` / `seat_ordering` / `ticket_ordering` / `hotel_ordering` 都标了「此字段逐渐废弃」；新版 v5 detail 的返回表没有预约字段。

**✅ 实测（2026-11-16）**：拙政园、苏州博物馆等 12 个苏州 POI 的 `search_text` + `detail` 返回里，`ticket_ordering`/`booking`/`reserve`/`buyurl` 等预约字段**一个都没有**。**结论：预约必须走策展表，不要等高德。**

**落地**：
1. 建最小策略表 `policy.json`：`poi_id / booking_required / opening / source_url / verified_at`（苏博/拙政园等预约制景区逐条策展）；
2. `policy.lookup` 返回 `required / not_required / unknown`，**unknown 不得当 not_required**；
3. 加用户「我有预约」的手动凭证开关。

**影响**：`policy.json` + `policy.lookup`、闸门不变量、Demo 的「预约景区被排除/提示」分支。

### V13 — 视觉抽取质量 ✅（2026-11-16 全量 20 张实测）

**已有事实**：✅ 多模态输入会自动降级为 `json_object`（V4），所以 `vision.extract` 的 schema 不会生效，输出必须全量校验。**图片只发 GLM-5.3-Flash / Doubao 2.1 Lite；视觉模型不通时 `NoModelAvailable`。**

**素材（2026-11-16 已备）**：`testdata/xhs-suzhou/`，20 张小红书苏州游玩/打卡笔记图片；来源与原始笔记链接见 `testdata/xhs-suzhou/manifest.json`。仅本地评测，不进入 Git/构建产物。

**✅ 全量实测（2026-11-16，GLM-5.3-Flash + Coding Plan + `response_format: json_object` + thinking off，串行 +0.8s 间隔）**：

| 指标 | 结果 |
| --- | --- |
| HTTP 200 + 合法 JSON | **20/20（100%）** |
| 抽出 ≥1 地点 | **13/20（65%）** |
| 总抽取地点数 | 46 个（high 35 / mid 9 / low 2） |
| 单图时延 p50 | **4.3s**（min 1.9s / max 11.4s） |
| 明显误抽 | 1 个（`xhs-06` 抽出「中国建设银行」，low conf） |

**7 张零地点图的真实情况**：`xhs-01/02/08/10/14/16/18`——核对图片 `image_desc`，全部是**纯照片/纯风景图，图里没有地点文字**（湖边夜景、腊梅、水乡河道、泳池自拍、点心特写、拼贴图、火烧云天际线）。**这不是召回失败，是图里本来就没有可抽的文本地点。**

**「文字抽取」与「地标识别」必须分层**：换用允许猜测地标的提示词复测这 7 张，6/7 能给出地标（东方之门×2、周庄古镇×2、苏州古典园林、平江路、金鸡湖），全部 `guessed:true` + low conf。**产品语义：文字抽取是事实（进 wishlist 主路径），地标猜测是提示（进「可能想去」建议，需用户确认，不能与抽取结果混存）。**

**Doubao 视觉兜底实测**：`doubao-seed-2-1-lite` + `json_object` 对 `xhs-09/19` 返回 12/15 个地点（含 GLM 抽到的全部子集 + 少量新增），单图约 2.6–3.2s——**兜底链真实可用**。

**结论**：`vision.extract` 主路径 = GLM `json_object` 抽取文字地点 + pi-schema 校验 + 用户确认；无文字地点的图走 `guessed` 地标通道（UI 区分）；Doubao 兜底经实测可行。召回线按「有文字地点的图」算 = 13/13 抽到（100%）。
**影响**：`vision.extract` 模型/提示词分两层（extract vs guess）、导入 UX、PRD G2。

### V14 — 端到端时延 🟡（模型侧已实测；应用端 p50 待跑）

**为什么重要**：PRD 目标雷达中位 ≤12s；场景如果按 6 个模型回合走会超。§5.7 的预算是设计假设，必须实测。

**怎么验**：用苏州场景跑 10 次，分别测：
- A：6 回合（read/deadline/read/screen/rank/propose）；
- B：`radar.evaluate` 一次 + 1 次理由；
- 记录 p50/p95、地图调用数、模型 token/耗时、失败率。

**✅ 模型侧实测（2026-11-16，pi-ai 1.5.2 + curl）**：`doubao-seed-2-1-lite` 文本约 0.84s、视觉 `json_object` 约 2.6–3.2s；`glm-5.3-flash` 图片 + `json_object` p50 约 4.3s（20 张全量，min 1.9s / max 11.4s，thinking off），图片 + 强制工具约 6.1s，`reasoningEffort:'max'` 约 8.5s；文本 JSON 约 1.2s。视觉回合是主成本；6 回合能否压进 12s 取决于能不能把 read/screen/rank 收敛成一次能力调用，需应用层再测。

**判据**：p50 ≤12s；超了就把 read/screen/rank 收敛成一次能力调用、并行 I/O、限制工具回合；不要把 `maxTurns` 当延迟预算。
**影响**：§5.7、任务类→模型映射、UI 进度。

### V15 — 对象存储、删除与 PWA 🟡

**为什么重要**：PRD FR-12 要求删除旅行与上传图片；PRD §13 要求离线可看最近行程。ARCH 早先没有对象存储/删除/PWA 设计。

**怎么验**：
1. 上传 8 张图 → 重启进程/重新部署 → 图片与 doc 还在；
2. 删除 trip / 删除全部数据 → 检查该用户的 SQLite 文件（含 WAL/SHM）、对象存储对象、缓存都已删；
3. 断网打开已缓存的 trip/proposal → 显示 `stale`，不伪造 ETA；
4. HTTPS 下 PWA 可安装，地图失败时列表可用。

**判据**：删除覆盖 SQLite 文件（含 transcript）+ 对象存储；无孤儿对象；离线不推断实时；PWA 可安装/降级。
**影响**：§10.6–10.7、部署持久卷（V9）。

### V16 — 套餐 Key 合规：官方禁止后端 API；用户选择 plan 模式 🟡（风险接受；两个 plan 端点已实测 200）

**背景**：你原计划用「智谱 Coding Plan 的 GLM-5.3-Flash + 火山 Agent Plan 的 Doubao 2.1 Lite」当运行时模型。2026-11-16 查官方文档，这条路**不合规**：

> 智谱 Coding Plan 快速开始：「GLM Coding Plan 仅限在官方支持的指定工具与产品环境中使用」。套餐端点是 `/api/coding/paas/v4`、`/api/anthropic`、`/api/v1`。
>
> 火山 Agent Plan 套餐概览：「文本生成模型及向量化模型不可用于 API 调用」；「在非 AI 工具中使用 Agent Plan 权益对应的 Base URL 和 API Key 有可能被识别为滥用/违规」；「会导致订阅停用或账号封禁」。端点 `/api/plan/v3`。
>
> 火山 Coding Plan 套餐概览：「套餐额度仅在 AI 编程工具中生效，不可用于 API 调用」。端点 `/api/coding/v3`。

**用户选择（2026-11-16）**：本次按 **plan 模式**跑，配置与 `heirloom-lite` 生产 env 一致。官方条款没有变；这是**已知风险后的选择，不是合规**。代码保留 `MODEL_ENDPOINT_MODE=standard` 一键切回。

**✅ 端点实测（2026-11-16）**：`https://open.bigmodel.cn/api/coding/paas/v4` + `glm-5.3-flash` 的文本、视觉、`json_object` 都返回 200；`https://ark.cn-beijing.volces.com/api/plan/v3` + `doubao-seed-2-1-lite-260915` 的文本、`json_object`、`json_schema strict` 都返回 200。条款风险仍在，技术可用性已确认。

| 模式 | 智谱 Base URL | 火山 Base URL | 用途 |
| --- | --- | --- | --- |
| `plan`（本次） | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://ark.cn-beijing.volces.com/api/plan/v3` | 与 heirloom-lite 一致；账号可能被停用/封禁 |
| `standard`（合规默认） | `https://open.bigmodel.cn/api/paas/v4` | `https://ark.cn-beijing.volces.com/api/v3` | 正式上线/对外演示优先 |

**怎么复验（账号级）**：
1. `.env` 里 `MODEL_ENDPOINT_MODE=plan`；`ZHIPU_BASE_URL` / `ARK_BASE_URL` 是上表 plan 地址；Key 来自 Coding Plan / Agent Plan 套餐页。
2. 按 SETUP §1.4 / §2.4 各打一次，返回 `choices`；记录实际模型名（`glm-5.3-flash`、`doubao-seed-2-1-lite-260915`）是否被接受，404 时试 `glm-5.3` / `doubao-seed-2.1-lite`。
3. 启动日志应有一行 plan warning；把 mode 改成 `standard` 但保留 plan URL 时，guard 应拒绝启动。
4. 记录套餐额度/并发；不要把套餐 Key 写进前端、日志、截图或 Git。

**判据**：plan 模式技术上跑通；`.env` 有明确 `MODEL_ENDPOINT_MODE=plan`；风险已在文档标注；standard 模式可随时切回。
**影响**：ARCH §6.1.1、SETUP §0/§1/§2/§5、网关 provider 配置。

> **旁证（不在本任务范围，但值得一起复核）**：`heirloom-lite` 的生产配置里 `ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3`、`ARK_MODEL=doubao-seed-2-1-lite-260915`，即用 Agent Plan 跑后端文本生成。按火山个人版/企业版 Agent Plan 的原文，这属于「文本生成模型用于 API 调用」，条款风险相同。不要直接改它的生产配置；先确认它是否有单独的企业合同/书面许可，再决定是否迁移到标准按量 Key。

---

## 5. 🟡 高德（文档已查一部分，账号仍需实测）

| 项 | 怎么验 | 影响 |
| --- | --- | --- |
| 个人/企业配额具体数字 | 控制台配额页截图 | 批量 ETA 的调用预算（雷达一次 3 批，见 §5.2） |
| `/v3/distance` 是 **N origins → 1 destination** | 一次传两个 destination 看是否只认一个 | 雷达要 1→N，不能一次算完；见 V10 |
| `/v3/distance` origins ≤100 | 传 100 个 origins 实打 | 候选池分批上限 |
| `/v3/distance` type=3 步行仅 5km | 传一个 >5km 的 origin | 超距返回什么，要不要降级驾车 |
| 步行反向是否近似对称 | A→B 与 B→A 各打一次比对 | 反向 ETA 只能标 `estimated`，见 V10 |
| `/v5/place/detail` 批量上限 | 一次传 10 个 id 看是否全返回 | top N 一次查完；detail 不含 opentime（见 V11） |
| `show_fields=business` 字段覆盖 | 20 个真实 POI 看 `opentime_today/cost/rating` | 营业时间只从 search 返回；证据状态 `verified/unknown` |
| `/v5/place/around` 半径上限 | 传 50000/50001 看返回 | ✅ 0–50000m，超上限按默认 5000；page_size 1–25 |
| 坐标转换批量上限 | 一次传 40 对看返回 | ✅ 官方上限 40；只支持转入 GCJ-02，无反向 |
| 逐条 `info` 而非只看顶层 `status` | 批量里混一个非法坐标 | 部分失败的处理 |
| Web服务 key vs Web端 key | 用错 key 打 REST | `INVALID_USER_SCODE` |

---

## 6. 探针执行记录

跑通后往这里贴**实际输出**（脱敏：去掉 key、WorkspaceId、精确经纬度），并把对应条目改成 ✅。

| 编号 | 执行日期 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| V1 | 2026-11-16 | 四家端点全 200 | ✅ |
| V2 | 2026-11-16 | strict:true 两家接受不报 400；诱导加字段未越界 | ✅ 按不支持处理 |
| V3 | 2026-11-16 | json_schema strict 诱导测试未越界；无法区分约束/自觉 | 🟡 按不生效处理 |
| V4 | 2026-11-16 | 官方确认多模态 json_schema 静默降级为 json_object | ✅ |
| V5 | 2026-11-16 | compat 逐项实测通过 | ✅ |
| V6 | 2026-11-16 | 真实 Harness + fauxProvider：onYield {continue} 时被拒中间答案进 transcript（pi.assistant entry），continue 注入 pi.user | 🟡 主闸门在应用端；UI 过滤中间答案 |
| V7 | 2026-11-16 | 1.5.2 beforeTool 不能 sleep、Signals 未发布 → 确认放 agent 外（已定设计）；剩余仅 app 写入幂等/HTTP | ✅ |
| V8 | | | |
| V9 | | | |
| V10 | 2026-11-16 | origins→destination 单向；对称步行同值；>5km 接口不拦 | ✅ |
| V11 | 2026-11-16 | detail ≤35 ids 实测；opentime 覆盖 ~40%；distance 100 cap 静默截断；QPS ~5/s | ✅ |
| V12 | 2026-11-16 | 12 个苏州 POI 无任何预约字段 | ✅ 策展表 |
| V13 | 2026-11-16 | 20/20 valid JSON；文字地点图 13/13 全抽到；7 纯照片走 guessed；p50 4.3s | ✅ |
| V14 | 2026-11-16 | 模型侧实测：Doubao 文本 0.84s/图 2.6–3.2s；GLM 图 p50 4.3s（max 11.4s）/工具 6.1s/max 8.5s/文本 1.2s | 🟡 应用端 p50 待跑 |
| V15 | | | |
| V16 | 2026-11-16 | 两 plan 端点实测 200；条款仍禁后端 API；用户接受 plan 模式风险 | 🟡 风险接受 |

---

## 附：一手来源

- Pi 仓库：`github.com/earendil-works/pi`（MIT，核心线 1.5.2）
- Pi README：`raw.githubusercontent.com/earendil-works/pi/<tag>/packages/{durable,ai,agent}/README.md`
- 版本与发布时间：`npm view @earendil-works/<pkg> time --json` / `dist-tags`
- 发布说明：`gh api repos/earendil-works/pi/releases`
- 智谱结构化输出：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
- 火山结构化输出：https://docs.volcengine.com/docs/ark/model-list?lang=zh
- 智谱 GLM-5.3-Flash 模型页（1M、视觉、思考开关、参考价）：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
- 智谱标准 API 介绍：https://docs.bigmodel.cn/cn/api/introduction
- 智谱 Coding Plan 快速开始（「仅限官方支持的指定工具」）：https://docs.bigmodel.cn/cn/coding-plan/quick-start
- 智谱 Coding Plan Key 管理（三种 Key 互不通用）：https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management
- 火山 Agent Plan 套餐概览（「文本生成模型及向量化模型不可用于 API 调用」）：https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh
- 火山 Agent Plan Pi 接入（`/api/plan/v3`）：https://docs.volcengine.com/docs/ark/agent-plan-personal-pi?lang=zh
- 火山 Coding Plan 套餐概览（不可用于 API 调用）：https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh
- 火山方舟模型列表（`doubao-seed-2-1-lite-260915`、1M、视觉、思考开关）：https://docs.volcengine.com/docs/ark/model-list?lang=zh
- 火山方舟管理 API Key：https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh
- 部署目标：`heirloom-lite` 跳板机（阿里云 ECS/Linux）
- Pi 1.5.1/1.5.2 包内容对比（2026-11-16）：`npm pack @earendil-works/pi-durable@1.5.1` 与 `@1.5.2` → `tar -xzf` → `diff -qr`；只有 `CHANGELOG.md`、`package.json` 不同，`dist/` 相同。
- Pi 1.5.2 包源码（2026-11-16 复核）：`npm pack @earendil-works/pi-durable@1.5.2` →
  - `dist/harness/generation.js`：`onYield` 只在 `answer()` 调用；`terminate` 轮走 `finishToolRound()` → `endRun()`，不经过 `onYield`。
  - `dist/documents.d.ts`：`defineDoc` 的 session / conversation / task 重载，`history`/`fork` 选项，`retireDoc`。
- 高德距离测量：https://lbs.amap.com/api/webservice/guide/api/direction （`/v3/distance`：`origins`≤100、`destination` 单个、`type` 0/1/3、逐条 `info`）
- 高德 POI 搜索/详情：https://lbs.amap.com/api/webservice/guide/api/search （`show_fields=business`、详情单点）