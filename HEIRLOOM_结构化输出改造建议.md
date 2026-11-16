# heirloom-lite 结构化输出改造建议

日期：2026-11-16  
依据：`heirloom-lite` 当前源码 + `pi-durable` 1.5.2 源码核对  
范围：只讨论模型 JSON 输出的解析、校验、修复；不改模型端点、套餐配置、业务 prompt 语义。

---

## 0. 结论

**heirloom-lite 不需要大改。** 它现在的方向是对的：

- 只发 `response_format: { type: "json_object" }`，从不发 `json_schema`；
- 拿到文本后做清洗、确定性 salvage、最多一次语法 repair；
- 解析后用 Zod `safeParse`/`parse` 校验；
- 对 `qwen-plus` 显式控制 `enable_thinking` / `thinking_budget`。

要改的是三件小事：

1. **抽一个公共 `completeStructuredJson()`**，替掉 `memoir-use-case-strategy.ts` 里的内联 repair 逻辑，避免每个调用点各写一套。
2. **把关键写入路径的 `JSON.parse(...) as T` 补上 Zod 校验**；不要全仓替换，OCR 等“允许纯文本兜底”的路径保持原样。
3. **消除 prompt 字段说明与 Zod schema 的漂移**：加一个契约测试，或从 Zod 生成 prompt 用的 JSON Schema（只用于提示，不作为 `response_format` 发给模型）。

**不要做的事：**

- 不要为了 `qwen-plus` 切到 `json_schema`；它在百炼 JSON Schema 支持清单外，`strict` 不可靠。
- 不要全仓迁移到 `pi-schema`/`pi-durable`。`heirloom-lite` 是 NestJS + Zod 体系，迁移成本远大于收益；`pi-durable` 的工具参数校验也不能直接套到它的 LLM gateway 上。
- 不要改 `ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3`、`ARK_MODEL` 或任何生产 env；套餐合规问题另行决策。

---

## 1. 现状核对

| 位置 | 现在怎么做 | 判断 |
| --- | --- | --- |
| `apps/api/src/ai/provider-transport.ts:311` / `:333` | Chat Completions 发 `response_format: { type: "json_object" }`；Agent Plan Responses 发 `text.format: { type: "json_object" }` | ✅ 对 `qwen-plus` 正确；没有假装 `json_schema` 生效 |
| `apps/api/src/ai/memoir-use-case-strategy.ts:477` | `sanitizeStructuredContent` + `salvageMalformedJson` | ✅ 确定性抢救先行，避免为尾逗号/控制符付一次模型调用 |
| `apps/api/src/ai/memoir-use-case-strategy.ts:498` | 不是 JSON 对象才发一次低温 repair；repair prompt 禁止改写正文 | ✅ 有界、内容保护明确；但逻辑内联，其他调用点复用不到 |
| `apps/api/src/ai/llm-gateway.service.ts:715` | `z.object(...).parse(JSON.parse(completion.content))` | ⚠️ 有 Zod 闸门，但 `JSON.parse` 失败会直接抛，没有走统一 salvage/repair |
| 多处 `JSON.parse(stripJsonEnvelope(...)) as T` | 只做类型断言，运行时没有字段校验 | ⚠️ 关键写入路径需要补 `safeParse`；纯展示/允许降级的路径可以保留 |
| `apps/api/src/ai/llm-creative-calls.ts:335` | OCR 结果先尝试 `JSON.parse` 取 `text`，失败就用纯文本 | ✅ 这是有意的降级路径，不要改成 strict |
| `memoirThinkingOptions()` / `enable_thinking` | 按 provider/operation 显式控制思考 | ✅ 新增调用继续走这个入口，不要散落传参 |

**核心判断：** `json_object` 只保证“是个 JSON 对象”，字段合法性完全靠本地 Zod。这个方向对，但需要把“解析 + 抢救 + 一次 repair + Zod 校验”收敛成一个可测试的边界。

---

## 2. 目标形态：一个公共 helper

新增 `apps/api/src/ai/structured-json-completion.ts`（名字可调整），只做结构化输出，不碰业务语义。

```ts
import type { z } from "zod";
import type { Completion } from "./llm-gateway.service.js"; // 按实际类型位置调整

export type StructuredJsonResult<T> = {
  completion: Completion;
  value: T;
  repaired: boolean;
  salvaged: boolean;
};

export class StructuredJsonTruncatedError extends Error {
  constructor(public readonly completion: Completion) {
    super("structured_json_truncated");
  }
}

export class StructuredJsonSchemaError extends Error {
  constructor(
    public readonly completion: Completion,
    public readonly issues: z.ZodIssue[],
  ) {
    super("structured_json_schema_invalid");
  }
}

export async function completeStructuredJson<T>(
  schema: z.ZodType<T>,
  complete: (system: string, user: string, options: Record<string, unknown>) => Promise<Completion | null>,
  system: string,
  user: string,
  options: Record<string, unknown> & { repairMaxTokens?: number },
): Promise<StructuredJsonResult<T>> {
  // 1) 第一次调用：必须带 jsonObject: true
  const first = await complete(system, user, { ...options, jsonObject: true });
  if (!first) throw new Error("structured_json_no_completion");

  // 2) 清洗 + 确定性 salvage
  let content = sanitizeStructuredContent(first.content);
  const salvaged = salvageMalformedJson(content);
  if (salvaged.truncated) {
    // 截断不能靠 repair 补数据；交给调用方重新生成
    throw new StructuredJsonTruncatedError(first);
  }
  if (isJsonObject(salvaged.text)) content = sanitizeStructuredContent(salvaged.text);

  // 3) 语法不合法：最多一次低温 repair
  let repaired = false;
  if (!isJsonObject(content)) {
    const repair = await complete(
      repairSystem(system),
      repairUser(user, content),
      {
        ...options,
        maxTokens: options.repairMaxTokens ?? options.maxTokens,
        jsonObject: true,
        temperature: 0.1,
      },
    );
    if (!repair) throw new Error("structured_json_repair_no_completion");
    content = sanitizeStructuredContent(repair.content);
    repaired = true;
    // repair 后仍不是 JSON 对象：直接失败，不要无限重试
    if (!isJsonObject(content)) {
      throw new StructuredJsonSchemaError(repair, []);
    }
  }

  // 4) 本地 Zod 闸门
  const parsed = schema.safeParse(JSON.parse(stripJsonEnvelope(content)));
  if (!parsed.success) {
    throw new StructuredJsonSchemaError(first, parsed.error.issues);
  }

  return {
    completion: first,
    value: parsed.data,
    repaired,
    salvaged: salvaged.text !== first.content,
  };
}
```

实现时按现有 `Completion`、`host.complete`、metrics 结构适配，不要真的照抄类型。关键约束：

- **截断不 repair**：补全只能得到“语法合法但数据不完整”，必须重新生成。
- **repair 最多一次**：repair 后仍不合法就抛错，由调用方决定用户提示/重试。
- **schema 失败不自动再调模型**：字段级修复属于业务层（例如 dynamic outline 的 feedback 路由），不要塞进通用 helper。
- **不记录原文**：日志只记 operation、provider、issue path、token 数；不记 `content`。
- **保留 usage**：repair 的 usage 要加到结果上，避免结算漏账。

---

## 3. 分批改动

### P0：先做，风险低

1. **新增 helper**：`structured-json-completion.ts`，复用现有 `sanitizeStructuredContent`、`salvageMalformedJson`、`isJsonObject`、`stripJsonEnvelope`。
2. **所有模型调用继续走 `provider-transport.ts`**：不要在业务层直接拼 `response_format`；新增 transport 也必须只发 `json_object`，不发 `json_schema`。
3. **替换 `memoir-use-case-strategy.ts` 的内联块**：第 477–565 行的清洗/repair 逻辑改为调用 helper；后面的 `finalizeStructuredCompletion` 业务链不动。
4. **包住 `llm-gateway.service.ts:715`**：`z.object(...).parse(JSON.parse(...))` 改为 helper 或至少 `safeParse` + 明确错误；不要让 `JSON.parse` 的 `SyntaxError` 直接冒到上层。
5. **补测试**：见 §5。

### P1：关键路径补 Zod，按“会写库/会展示给用户”排序

| 文件 | 现状 | 建议 |
| --- | --- | --- |
| `memoir-dynamic-outline-proposal.ts` | 已有 `safeParse` | 保持；作为其他路径的样板 |
| `memoir-evidence-resolution-resolve.ts` | 已有 `envelopeSchema.safeParse` | 保持 |
| `memoir-invariant-repair.ts` | `repairSchema.parse` | 保持；补 invalid JSON 的明确错误 |
| `memoir-letter-resolution.ts` | `schema.parse` | 保持 |
| `memoir-repair-rewrite.ts` | `JSON.parse(...) as`，失败 `return null` | 可加 `safeParse`；失败返回 `null` 的降级语义不变 |
| `memoir-quality-gate.ts` | `JSON.parse` 后直接用 | 若结果影响放行/拒稿，补 `safeParse` |
| `llm-creative-calls.ts` OCR | 允许纯文本降级 | **不改**，这是有意设计 |
| `memoir-directory-maintenance.ts` | `JSON.parse(current.content)` | 若 `items` 会写库，补 `safeParse` |

原则：**只改“解析结果会写库、会改变状态、会展示给用户”的路径。** 纯日志、纯展示、允许降级的路径不要为了统一而 strict 化。

### P2：消除 prompt / schema 漂移

`heirloom-lite` 现在 prompt 里手写字段说明，Zod schema 另写一份。两个方案：

- **A（推荐，改动小）**：保留手写 prompt，加一个契约测试：从 Zod schema 提取顶层字段名，断言每个字段名都出现在对应 prompt 中；反向也检查 prompt 没有 schema 外字段。
- **B（彻底但更重）**：用 `z.toJSONSchema(schema)` 生成 JSON Schema，作为 prompt 的“字段契约”部分；**只用于提示，不作为 `response_format` 发给模型**。注意生成物可能含 provider 不认的关键字，但因为不发给模型，只影响 token 量和可读性。

先做 A；B 只在 schema 经常变、手写 prompt 频繁漂移时再做。

### P3：qwen-plus 思考策略

已经有 `memoirThinkingOptions()` / `enable_thinking` 的集中入口，继续保持：

- 目录规划、OCR、审计分类等低延迟任务：`enable_thinking: false`。
- 长文生成/纠错：按现有 `thinking_budget` 档位，不要让混合模型默认思考吃掉输出预算。
- 新增 operation 必须走同一个 policy 函数，禁止在调用点散落 `enable_thinking`。

---

## 4. 不建议做的事

### 4.1 不要切 `json_schema`

`qwen-plus` 在百炼 JSON Schema 支持清单外；`json_schema` 可能 400 或静默降级。`json_object` + 本地 Zod 是正确姿势。`json_schema` 最多作为未来某个 provider 的“额外约束”，不能当闸门。

> 2026-11-16 NextStop 实测：`qwen-plus` 与 `doubao-seed-2-1-lite` 的 `json_schema strict` 请求都返回 200，输出也符合给定 schema；但这只证明接口接受，**没有证明约束真的生效**（没做越界诱导）。heirloom 继续用 `json_object` 的决定不变。

### 4.2 不要全仓迁移到 pi-schema / pi-durable

`heirloom-lite` 的 AI 层是 NestJS service + Zod，`pi-durable` 是另一套 agent runtime。为了结构化输出迁移整个运行时，成本远大于收益；`pi-durable` 的 `Tool.parameters` 校验也不能直接套到现有 `host.complete()` 调用上。

### 4.3 不要自动无限 repair

repair 只修 JSON 语法，不修业务语义；最多一次。schema 失败应由业务层按字段反馈重试或拒稿，不能让通用 helper 反复调模型改写正文。

### 4.4 不要改 OCR 的纯文本降级

`llm-creative-calls.ts` 的 OCR 路径允许模型返回纯文本；这是有意的容错，不是所有 `JSON.parse` 都要 strict 化。

---

## 5. 测试清单

在现有 Vitest 体系里加：

1. **合法 JSON** → helper 返回 Zod 解析后的值。
2. **代码围栏 / 前后说明** → `stripJsonEnvelope` 后通过。
3. **尾逗号 / 未转义控制符** → `salvageMalformedJson` 修好后通过，且 `repaired=false`。
4. **截断 JSON** → 抛 `StructuredJsonTruncatedError`，**不**发 repair 调用。
5. **纯 prose** → 发一次 repair；repair 返回合法 JSON 后通过，`repaired=true`。
6. **repair 仍非法** → 抛错，调用次数恰好 2（原始 + repair）。
7. **schema 缺字段/类型错** → 抛 `StructuredJsonSchemaError`，`issues` 带 path；不自动再调模型。
8. **usage 合并** → repair 的 usage 计入结果。
9. **prompt/schema 契约** → Zod 顶层字段名与 prompt 字段说明一致。
10. **qwen-plus thinking** → 指定 operation 的请求体 `enable_thinking`/`thinking_budget` 符合 policy。

---

## 6. 灰度与回滚

- 先加 helper，不替换调用点：单测覆盖。
- P0 替换 `memoir-use-case-strategy` 后，跑现有 memoir 回归；对比 `jsonRepairCount`、`qualityRejectionCount`、失败率。
- 可加一个 env（例如 `AI_STRUCTURED_JSON_HELPER=shadow|enforce`）：shadow 模式只解析/校验并打点，仍返回原结果；确认无回归再切 enforce。
- 回滚：helper 是新增文件，调用点回退即可；不改数据库、不改 transport、不改模型端点。

建议观测指标：

- `structured_json_salvage_total`
- `structured_json_repair_total`
- `structured_json_truncated_total`
- `structured_json_schema_reject_total`
- 按 operation/provider 分组的 repair 率和最终失败率

---

## 7. 一句话版本

**heirloom-lite 的方向是对的：`json_object` 当语法提示，Zod 当闸门，repair 有界。要改的不是模型协议，而是把这段逻辑抽成公共边界、给关键写入路径补上运行时校验、用测试锁住 prompt 和 schema 的一致性。**
