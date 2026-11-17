# NextStop 开工配置：平台开通指南

面向第一次接触这些平台的开发者，按顺序照做即可。每一步都给出**确切的控制台地址、按钮名称、以及做完之后应该看到什么**。

配套文档：[ARCH_技术架构与选型.md](./ARCH_技术架构与选型.md)（架构与选型，说明这些凭据各自被哪一层持有） · [VERIFY_待验证清单.md](./VERIFY_待验证清单.md)（V1–V16 待验项与可执行探针）。

标注约定：
- ✅ = 已对照官方文档核实（核实日期 2026-11-15）
- ⚠️ = 官方文档未给出确切数值/步骤，需要你在控制台现场确认，不要当成已知事实写进代码

---

## 0. 总览：要开通什么，拿到什么

| 平台 | 用途 | 最终要拿到的东西 | 落到哪个环境变量 |
| --- | --- | --- | --- |
| 智谱开放平台 | 视觉解析主模型 `glm-5.3-flash` | 1 个 **Coding Plan Key**（plan 模式，风险自担；standard 模式用标准 Key） | `ZHIPU_API_KEY` |
| 智谱开放平台 | 视觉兜底（可选）`glm-4.6v-flash` | 1 个**标准按量 Key**（与主 Key 分开计费；429 高发，仅主 Key 配额耗尽时启用） | `ZHIPU_BACKUP_API_KEY` |
| 火山方舟 | 文本/意图/理由主模型 `doubao-seed-2-1-lite-260915` | 1 个 **Agent Plan Key**（plan 模式，风险自担；standard 模式用标准 Key） | `ARK_API_KEY` |
| 高德开放平台 | 服务端 POI 搜索 / 批量 ETA / 路径规划 | 1 个 **Web服务** 类型 Key | `AMAP_SERVER_KEY` |
| 高德开放平台 | 浏览器端地图渲染（JS API 2.0） | 1 个 **Web端(JS API)** 类型 Key + 1 个安全密钥 | `AMAP_JS_KEY`（可公开）<br>`AMAP_JS_CODE`（服务端保密） |
| 应用自身 | 签名/内部令牌 | 2 个 `openssl rand -hex 32` 随机串 | `COOKIE_SECRET` / `GATEWAY_INTERNAL_TOKEN` |

**保密级别**：`AMAP_JS_KEY` 会出现在浏览器里，这是设计如此；`ZHIPU_API_KEY`、`ZHIPU_BACKUP_API_KEY`、`ARK_API_KEY`、`AMAP_SERVER_KEY`、`AMAP_JS_CODE`、`COOKIE_SECRET`、`GATEWAY_INTERNAL_TOKEN` 只能存在于服务端进程环境变量中，任何情况下不得下发到前端、不得写进前端构建产物、不得进日志。

> 🔴 **先看这条，别开错 Key：** 智谱 **Coding Plan** 和火山 **Agent Plan / Coding Plan** 是给 Claude Code、ZCode 等「官方支持的 AI 工具」用的订阅套餐；官方文档明确**不允许**拿它们的 Key/Base URL 给自建后端做 API 调用（火山原文：「文本生成模型及向量化模型不可用于 API 调用」，违规可能导致订阅停用或账号封禁）。**能通 ≠ 条款允许。**
>
> **本次选择（2026-11-16 用户决定）：** 先按 **plan 模式**跑，智谱用 Coding Plan、火山用 Agent Plan，配置与 `heirloom-lite` 生产 env 一致。风险由部署者承担，文档保留风险标记；`MODEL_ENDPOINT_MODE=standard` 可随时切回合规路径。套餐 Key 获取见 §1.2 / §2.2 的 plan 小节。

**两种模式：**

| 模式 | 智谱 Base URL | 火山 Base URL | 用途 |
| --- | --- | --- | --- |
| `plan`（本次） | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://ark.cn-beijing.volces.com/api/plan/v3` | 与 heirloom-lite 一致；账号风险 |
| `standard`（合规默认） | `https://open.bigmodel.cn/api/paas/v4` | `https://ark.cn-beijing.volces.com/api/v3` | 正式上线/对外演示优先 |

架构上，五个保密值由**模型网关 / 地图适配层**持有，业务代码不直接读取（见 `ARCH_技术架构与选型.md` §6 模型网关、§10 安全边界）；`AMAP_JS_KEY` 只由前端持有。

---

## 1. 智谱开放平台（GLM-5.3-Flash，plan/standard 双模式）

### 1.1 注册与实名

1. 打开 https://bigmodel.cn/ ，注册并完成实名认证。
2. 进入控制台。⚠️ 个人/企业认证的可用模型、并发与赠送额度不同，以控制台为准。

### 1.2 拿 Key（两种模式）

**plan 模式（本次选择，风险见 §0）：**

1. 打开个人编程套餐 Key 页：**https://bigmodel.cn/apikey/coding-plan-per**；团队套餐在控制台「团队套餐 → 我的套餐」页。
2. 确认 Coding Plan 已开通；点「创建/复制 Key」。
3. **立刻复制完整 Key**，只显示一次。这个 Key 与标准 API Key 互不通用。

**standard 模式（合规备选）：**

1. 打开标准 API Key 管理页：**https://bigmodel.cn/apikey/platform**（⚠️ 若跳转，按控制台「API Key / 标准模型 API」入口走）。
2. 点「创建 API Key」，归属选默认项目。
3. 复制完整 Key。这个 Key 扣余额/普通资源包，不扣套餐额度。

### 1.3 Base URL 与模型 ID

```bash
# plan 模式（本次）
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
ZHIPU_MODEL_VISION=glm-5.3-flash

# standard 模式（合规备选）
# ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
```

✅ 官方模型页确认：`glm-5.3-flash` 支持图像、视频、文本、文件输入，1M 上下文、128K 最大输出、工具调用；官方推荐 `temperature: 1`、`top_p: 0.95`、`reasoning_effort: max`、`thinking.clear_thinking: false`。**2026-11-16 实测 Coding Plan 端点也接受 `thinking:{type:'disabled'}`**：视觉 + 强制工具约 6s、0 reasoning tokens；`reasoning_effort:'max'` 约 8.5s。默认用 disabled 降延迟，抽取质量不够再升 max。参考价：输入 0.8 元 / 输出 2.8 元 / 缓存命中 0.23 元（每百万 token）。

⚠️ Coding Plan 的 `/api/coding/paas/v4` 是套餐端点，官方只允许在支持的 AI 工具里用；本次按你的选择用于后端，账号风险自担。模型 ID 若在套餐页显示为 `glm-5.3`，先以套餐页为准；`glm-5.3-flash` 不通时再换。

### 1.4 验证 Key 可用

```bash
export ZHIPU_API_KEY='你的plan或标准Key'
export ZHIPU_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4'
# standard 模式改成：export ZHIPU_BASE_URL='https://open.bigmodel.cn/api/paas/v4'

curl -sS -X POST "${ZHIPU_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer $ZHIPU_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5.3-flash",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "只回复两个字：可用"}],
    "thinking": {"type": "disabled"}
  }'
# 质量不够时改成：
# "thinking": {"type": "enabled", "clear_thinking": false},
# "reasoning_effort": "max"
```

**期望**：`choices[0].message.content` 有「可用」，`completion_tokens_details.reasoning_tokens` 为 0；开思考时才可能出现 `reasoning_content`。若 401，确认 Key 与 Base URL 是同一模式（plan Key 配 plan 端点，标准 Key 配标准端点）；若模型不存在，去套餐页/模型列表确认 `glm-5.3-flash` 可用。

---

## 2. 火山方舟（Doubao 2.1 Lite，plan/standard 双模式）

### 2.1 注册、开通方舟

1. 打开 https://www.volcengine.com/ ，注册并实名。
2. 进入方舟控制台：https://console.volcengine.com/ark ，地域选**华北2（北京）**。
3. 在「模型广场 / 开通管理」里确认 `doubao-seed-2-1-lite-260915` 已开通。⚠️ 有些账号需要先点「开通模型」或创建推理接入点。

### 2.2 拿 Key（两种模式）

**plan 模式（本次选择，风险见 §0）：**

1. 控制台 → **Agent Plan / 套餐订阅** 页面。
2. 找到套餐专属 API Key（与普通 API Key 分开管理），创建/复制。
3. 确认套餐额度可用。这个 Key 与标准 API Key 互不通用。

**standard 模式（合规备选）：**

1. 控制台左下角 → **API Key 管理** → **创建 API Key**（官方文档：https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh ）。
2. 归属选目标项目空间，创建后立刻复制。这个 Key 扣余额/普通资源包。

### 2.3 Base URL 与模型 ID

```bash
# plan 模式（本次，与 heirloom-lite 生产 env 一致）
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
ARK_MODEL_TEXT=doubao-seed-2-1-lite-260915

# standard 模式（合规备选）
# ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

✅ 官方模型列表确认：Model ID 为 `doubao-seed-2-1-lite-260915`，支持 Responses / Chat / Messages API，1M 上下文，支持视觉理解与深度思考；思考可用 `thinking.type=disabled` 关闭。参考价：输入 0.8 元 / 输出 2.7 元 / 缓存命中 0.16 元（每百万 token）。

⚠️ Agent Plan 的 `/api/plan/v3` 是套餐端点，官方只允许在支持的 AI 工具里用；本次按你的选择用于后端，账号风险自担。官方 Agent Plan Pi 文档写的是 `doubao-seed-2.1-lite`，而 heirloom-lite env 用 `doubao-seed-2-1-lite-260915`；先按后者试，404 再换前者。

如果控制台只给了推理接入点，`model` 填 `ep-xxxxxxxx`，不要填模型名。

### 2.4 验证 Key 可用

```bash
export ARK_API_KEY='你的plan或标准Key'
export ARK_BASE_URL='https://ark.cn-beijing.volces.com/api/plan/v3'
# standard 模式改成：export ARK_BASE_URL='https://ark.cn-beijing.volces.com/api/v3'

curl -sS -X POST "${ARK_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "doubao-seed-2-1-lite-260915",
    "messages": [{"role": "user", "content": "只回复两个字：可用"}],
    "thinking": {"type": "disabled"}
  }'
```

**期望**：`choices[0].message.content` 有「可用」。若报模型不存在，先确认模型已开通，或改用 `ep-...` 接入点；若 401，确认不是 Agent Plan Key。

---

## 3. 高德开放平台

### 3.1 注册成为开发者

1. 打开控制台：https://console.amap.com/ ✅
2. 没有账号就注册开发者：https://console.amap.com/dev/id ✅
3. 完成开发者信息填写。

**个人 vs 企业认证：** 认证入口在 https://console.amap.com/dev/user/permission ✅
⚠️ 认证后的配额提升幅度、以及哪些高级接口需要企业认证，见 https://developer.amap.com/upgrade#price 。**先用个人开发者跑通，再决定要不要认证。**

### 3.2 创建应用

1. 进入 **【应用管理】**：https://console.amap.com/dev/key ✅
2. 点页面右上角 **【创建新应用】**。
3. 填表单（应用名称、应用类型）。名称建议 `nextstop`。

> 一个「应用」是一个容器，下面可以挂多个不同类型的 Key。我们只需要**一个应用、两个 Key**。
>
> **苏州没有单独的“地图 Key”。** 高德是全国一张图，同一个 Key 调苏州数据即可：POI 搜索传 `city=苏州`（或 adcode `320500`），地图中心先设 `[120.5853, 31.2989]`。不需要为苏州另开应用或 Key。

### 3.3 创建 Key #1：Web服务（服务端用）

1. 在【应用管理】→【我的应用】里选中刚建的应用。
2. 点 **【添加 Key】**。
3. **服务平台选择【Web 服务】** ✅ ← 这一步选错是最常见的坑
4. 提交，得到 Key。存为 `AMAP_SERVER_KEY`。

> ✅ **Key 类型必须匹配调用方式。** 用「Web端(JS API)」类型的 Key 去调 `restapi.amap.com` 的 Web 服务接口，会返回 `INVALID_USER_SCODE`。反过来也一样。
> 服务端 POI 搜索、批量 ETA、路径规划，全部用这个 **Web服务** Key。
>
> ⚠️ **不要勾选「数字签名」**：本项目不需要；勾了之后每个 Web 服务请求都要额外算 `sig`，只会增加调试成本。若已经勾了，去 Key 详情里关掉或重建一个不勾的 Key。

### 3.4 创建 Key #2：Web端(JS API)（浏览器地图用）

1. 同一个应用下，再点 **【添加 Key】**。
2. **服务平台选择【Web端(JS API)】** ✅
3. 提交后，**同时得到 Key 和安全密钥（securityJsCode）** ✅
4. 分别存为 `AMAP_JS_KEY` 和 `AMAP_JS_CODE`。

> ✅ **2021年12月02日之后创建的 Key 必须配合安全密钥一起使用。** 现在新建的 Key 都在此之后，所以安全密钥不是可选项。
> 安全密钥的用法见 §4——**生产环境必须走服务端代理，不要明文下发。**

### 3.5 验证 Web服务 Key 可用

```bash
export AMAP_SERVER_KEY='你的Web服务Key'
```

**测试 A：POI 搜索 2.0**

```bash
curl -sS -G 'https://restapi.amap.com/v5/place/text' \
  --data-urlencode "key=$AMAP_SERVER_KEY" \
  --data-urlencode 'keywords=拙政园' \
  --data-urlencode 'region=苏州' \
  --data-urlencode 'show_fields=business'
```

期望：`status: "1"`，`pois[]` 非空，且因为带了 `show_fields=business`，能看到 `business.opentime_today` 这类字段。

**测试 B：批量步行 ETA（本项目的关键接口）**

```bash
curl -sS -G 'https://restapi.amap.com/v3/distance' \
  --data-urlencode "key=$AMAP_SERVER_KEY" \
  --data-urlencode 'origins=120.629,31.324|120.631,31.318|120.620,31.310' \
  --data-urlencode 'destination=120.625,31.320' \
  --data-urlencode 'type=3'
```

期望：`results[]` 有 **3 条**，每条带 `origin_id`、`distance`（米）、`duration`（秒）、`info`。

> ✅ 这个接口一次调用支持 **最多 100 个 origins**（`|` 分隔），单个 destination；实测传 101 个会**静默截断到 100**，不报错。
> `type=3` 是步行规划距离，官方口径 5km 内有效，但**实测超距也返回数值不报错**——超距候选要由应用侧判 `WALK_TOO_FAR`，不能把返回值当可行。`type=0` 直线距离；`type=1` 驾车导航距离（默认，考虑路况）。
> **逐条看 `results[].info` 判断成功与否**，不要只看顶层 `status`——部分起点失败时顶层仍可能是 1；传两个 destination 直返 `INVALID_PARAMS`。
> ✅ 2026-11-16 实测：步行 A→B 与 B→A 返回相同 distance/duration（对称）；个人开发者的实测 QPS 约 **5 次/秒**，连续打会触发 `CUQPS_HAS_EXCEEDED_THE_LIMIT`，1s 后恢复——所有高德调用要带限速器。
>
> 这个批量能力是整个雷达性能设计的基础：N 个候选的 ETA 只需要 1 次调用，而不是 N 次。

**测试 C：坐标转换（浏览器定位 → 高德坐标）**

```bash
curl -sS -G 'https://restapi.amap.com/v3/assistant/coordinate/convert' \
  --data-urlencode "key=$AMAP_SERVER_KEY" \
  --data-urlencode 'locations=120.629,31.324' \
  --data-urlencode 'coordsys=gps'
```

⚠️ 该接口的**批量上限未核实**，先按单点用，需要批量时现场验证。

### 3.6 查配额

✅ 官方文档把配额信息放在两个地方，**文档本身不列具体数字**：

| 要看什么 | 去哪看 |
| --- | --- |
| **QPS / 并发配额** | 控制台 → 流量分析 → 配额管理：<br>https://console.amap.com/dev/flow/manage |
| **每日调用量配额** | 定价页 → 基础服务配额说明：<br>https://developer.amap.com/upgrade#price#base_service_price |

⚠️ **开工第一件事就是打开这两个页面，把你账号的真实数字抄下来。** 个人开发者和企业认证的数字不同，不同接口的配额也可能不同。不要假设。

错误码对照表：https://developer.amap.com/api/webservice/guide/tools/info ✅

### 3.7 顺手记下的工具

| 工具 | 地址 | 用途 |
| --- | --- | --- |
| 坐标拾取器 | https://developer.amap.com/tools/picker | 手工取 Demo 场景的坐标（苏州姑苏区） |
| 高德地图 URI Web | https://developer.amap.com/api/uri-api/summary/ | 从网页唤起高德导航 |
| 高德地图 URI APP | https://developer.amap.com/api/amap-mobile/summary/ | 从 App 唤起 |
| MCP Server | https://developer.amap.com/api/mcp-server | **开发期**探查数据用，不进生产链路 |

> 关于 MCP：官方托管端点 `https://mcp.amap.com/mcp?key=<Key>`（Streamable HTTP）和 `https://mcp.amap.com/sse?key=<Key>`（SSE）。
> **定位是开发期工具**——用来快速试接口、看真实返回长什么样。生产运行时走 REST Web 服务 API，因为需要批量、缓存、超时、配额控制，这些 MCP 给不了。

---

## 4. JS API 安全密钥：两种接法

浏览器里的地图要调高德服务，必须带安全密钥。有两种方式，**生产环境只能用第二种**。

### 4.1 明文方式（仅本地开发，不安全）

✅ 官方原文：「JS API 安全密钥以明文方式设置，**不建议在生产环境使用**」。

```html
<div id="container"></div>
<script>
  window._AMapSecurityConfig = {
    securityJsCode: '你的安全密钥',
  };
</script>
<script src="https://webapi.amap.com/maps?v=2.0&key=你的JSKey"></script>
<script>
  var map = new AMap.Map('container', { zoom: 12 });
</script>
```

> ✅ **`_AMapSecurityConfig` 必须在 JS API 脚本加载之前设置**，否则无效。
> 用 `@amap/amap-jsapi-loader` 异步加载时，同样要在 `load()` 之前把 `window._AMapSecurityConfig` 赋好。

### 4.2 服务端代理方式（生产必须）

思路：安全密钥只存在于服务端。浏览器把请求发给你自己的域名，服务端追加 `jscode` 后转发给高德。

**前端：**

```js
window._AMapSecurityConfig = {
  serviceHost: location.origin + '/AMapService',
};
```

**服务端（Node / Hono 示例，含路径校验）：**

```ts
const AMAP_JS_CODE = process.env.AMAP_JS_CODE!;
const PROXY_PREFIX = '/AMapService';
const SAFE_PATH = /^\/v[345]\/[a-z0-9/_-]+$/;

app.all(`${PROXY_PREFIX}/*`, async (c) => {
  const path = c.req.path.slice(PROXY_PREFIX.length);
  if (!SAFE_PATH.test(path)) return c.text('bad path', 400);

  const upstream = new URL('https://restapi.amap.com' + path);
  new URL(c.req.url).searchParams.forEach((v, k) => upstream.searchParams.set(k, v));
  upstream.searchParams.set('jscode', AMAP_JS_CODE);

  const res = await fetch(upstream, { method: c.req.method });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
});
```

`SAFE_PATH` 不是可选的装饰：没有它，这个代理就是一个带着你安全密钥的开放转发器，任何人都能借它刷你的配额。

**Nginx 版本（✅ 官方示例）：**

```nginx
server {
  listen       80;
  server_name  你的域名;

  # 自定义地图样式（没用到可以不配，但配的话顺序要在前面）
  location /_AMapService/v4/map/styles {
    set $args "$args&jscode=你的安全密钥";
    proxy_pass https://webapi.amap.com/v4/map/styles;
  }

  # Web 服务 API
  location /_AMapService/ {
    set $args "$args&jscode=你的安全密钥";
    proxy_pass https://restapi.amap.com/;
  }
}
```

改完执行 `nginx -s reload`。

> **关于前缀：** 官方文档示例用 `/_AMapService`，并写明「`_AMapService` 为代理请求固定前缀」。高德自己的站点用的是 `/AMapService`（无下划线）。
> 实际起作用的是**前端 `serviceHost` 里写的路径**和**服务端代理 location 的路径**必须一致。上面 Node 示例用 `/AMapService`，Nginx 示例用 `/_AMapService`，各自内部是自洽的——**别混用**。
>
> 如果用了多个 JS Key，✅ 官方要求「在代理设置中根据 key 来映射不同的安全密钥」。

### 4.3 域名白名单

⚠️ 在控制台为 **Web端(JS API)** 类型的 Key 配置域名白名单，把生产域名和 `localhost` 加进去。具体字段名以控制台为准。这是密钥泄露后的第二道防线。

---

## 5. 环境变量清单

在项目根目录建 `.env`（**加进 `.gitignore`**），并提交一份不含真实值的 `.env.example`。真实值只写进 `.env`，**不要贴到聊天里**；填好后告诉 Claude「放好了」，它只检查变量是否存在，不打印值：

```bash
# ---- 模型网关持有，业务代码不读 ----
# 端点模式：plan = 套餐端点（本次选择，官方条款不允许后端 API 调用，风险自担）
#           standard = 标准按量端点（合规）
MODEL_ENDPOINT_MODE=plan

# 智谱：视觉主模型（plan 模式用 Coding Plan Key）
ZHIPU_API_KEY=xxxxxxxx
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
# standard 模式改成：ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
# 不要用 /api/anthropic：能用，但会忽略 thinking:disabled，也没有 response_format
ZHIPU_MODEL_VISION=glm-5.3-flash

# 智谱：视觉兜底（可选，标准按量 Key，与主 Key 分开计费）
# 实测 glm-4.6v-flash 429 高发；只作主 Key 配额耗尽时的短超时备选，不在默认链里
ZHIPU_BACKUP_API_KEY=
ZHIPU_BACKUP_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_BACKUP_MODEL=glm-4.6v-flash

# 火山方舟：文本/意图/理由主模型（plan 模式用 Agent Plan Key）
ARK_API_KEY=xxxxxxxx
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
# standard 模式改成：ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL_TEXT=doubao-seed-2-1-lite-260915   # 若用接入点，改成 ep-xxxxxxxx

# ---- 地图适配层持有 ----
AMAP_SERVER_KEY=xxxxxxxx          # Web服务类型，保密
AMAP_JS_CODE=xxxxxxxx             # JS API 安全密钥，保密

# ---- 唯一允许下发到前端的凭据 ----
AMAP_JS_KEY=xxxxxxxx              # Web端(JS API)类型，公开

# ---- 应用自身 ----
COOKIE_SECRET=xxxxxxxx              # openssl rand -hex 32；签匿名 guest cookie
GATEWAY_INTERNAL_TOKEN=xxxxxxxx     # openssl rand -hex 32；业务进程调用网关的内部凭据

# ---- 本地持久化（部署时必须落在持久卷上，见 §7）----
DATA_DIR=./data                   # SQLite 目录；每匿名用户一个文件（data/users/*.sqlite）
OBJECT_STORE=local                # local | s3 | oss
OBJECT_STORE_DIR=./data/objects   # local 模式的对象目录
# OBJECT_STORE=s3 时另配：OBJECT_STORE_ENDPOINT / OBJECT_STORE_BUCKET /
# OBJECT_STORE_ACCESS_KEY / OBJECT_STORE_SECRET_KEY，按所选服务填
```

`DATA_DIR` 与 `OBJECT_STORE_DIR` 是应用唯一的本地状态。容器部署时把这两个目录挂同一个持久卷；删除旅行/删除全部数据时要同时清库与对象（ARCH §10.6）。

前端只能拿到 `AMAP_JS_KEY`。在 Vite 里意味着只有它带 `VITE_` 前缀：

```bash
VITE_AMAP_JS_KEY=xxxxxxxx
```

**其余任何变量都不要加 `VITE_` 前缀**——加了就会被打进前端产物。

**Jev 中转（2026-11-16 用户指定）**：单独保存在 Git 忽略的 `.env.jev.local`，变量为 `JEV_BASE_URL`、`JEV_API_KEY`、`JEV_MODEL=jev-latest` 和 `JEV_TIMEOUT_MS`；文件权限设为 600。使用原生 `/v1/systemone`，凭据只由服务端 decision transport / 本地探针读取。运行连通性探针：`node --env-file=.env.jev.local scripts/probe-jev.mjs`；加 `--suite` 会真实调用中转，运行 16 个合成请求。运行未来完整应用时需同时加载主 `.env` 与该文件；当前探针不修改现有主配置。

---

## 6. 开工自检清单

按顺序做完，每一项都要看到期望结果才往下走：

- [ ] `MODEL_ENDPOINT_MODE=plan` 已写入 `.env`，并知道这是**风险模式**（官方条款不允许后端 API 调用）
- [ ] 智谱 Coding Plan Key 已创建并完整保存
- [ ] 智谱 `glm-5.3-flash` 的 `curl` 返回了 `choices`；带 `thinking:{type:'disabled'}` 时 `content` 直接有文本，不再只看到空的 `reasoning_content`
- [ ] 火山 Agent Plan Key 已创建并完整保存
- [ ] 火山 `doubao-seed-2-1-lite-260915`（或 `ep-...`）的 `curl` 返回了 `choices`；若 404，试 `doubao-seed-2.1-lite`
- [ ] plan 模式启动时日志有一行 warning；standard 模式下把 `ZHIPU_BASE_URL` 改成 `/api/coding/paas/v4` 时进程拒绝启动
- [ ] ⚠️ 在控制台确认了两个模型的**额度/单价**；plan 模式尤其要确认套餐额度
- [ ] 高德开发者注册完成
- [ ] 应用创建完成
- [ ] **Web服务** Key 创建完成，`/v5/place/text` 返回 `status: "1"`
- [ ] `/v3/distance?type=3` 传 3 个 origins，返回 **3 条** results
- [ ] **Web端(JS API)** Key + 安全密钥创建完成
- [ ] ⚠️ 在 https://console.amap.com/dev/flow/manage 抄下真实 **QPS 配额**
- [ ] ⚠️ 在定价页抄下真实**每日调用量配额**
- [ ] 浏览器里地图能渲染出来（先用明文方式验证连通）
- [ ] 切到服务端代理方式，地图**仍然**能渲染，且浏览器 Network 里看不到 `jscode`
- [ ] `.env` 已进 `.gitignore`，`git status` 里看不到它
- [ ] `COOKIE_SECRET`、`GATEWAY_INTERNAL_TOKEN` 已用 `openssl rand -hex 32` 生成（不要复用）
- [ ] 前端构建产物里 grep 不到 `ZHIPU_API_KEY` / `ZHIPU_BACKUP_API_KEY` / `ARK_API_KEY` / `AMAP_SERVER_KEY` / `AMAP_JS_CODE` 的值
- [ ] 重启应用进程后，已写入的会话与上传图片还在（`DATA_DIR` + 对象存储落在持久卷上）

前端构建产物 grep 那条建议做成 CI 检查，而不是靠人眼。

---

## 7. 未核实项（不要当成已知事实）

这些在本次核实中没有拿到确切答案，**开工时需要现场确认**：

1. 高德个人开发者 / 企业开发者的**具体每日配额和 QPS 数字**——文档只给了查看入口，没给数字
2. 智谱 / 火山在**你账号下的免费额度、并发限制、实际单价**——官方参考价已查，但以控制台账单为准
3. plan 模式下 `glm-5.3-flash` 与 `doubao-seed-2-1-lite-260915` 的**实际可用性/模型名**——端点能通不代表条款允许，必须实测并记录
5. 视觉模型对**小红书截图**的真实解析质量——必须用你自己的样本图实测，别信任何 benchmark
6. **`heirloom-lite` 跳板机的上机环境**：OS 版本、Node 版本、持久盘挂载点、可用端口/域名、是否允许安装 systemd 服务（见 §7.1）

### 7.1 部署目标：heirloom-lite 跳板机 ⚠️

**已确认：部署目标是 `heirloom-lite` 项目的阿里云跳板机（Linux ECS）。** 但「跳板机」具体指哪台机器，还要再确认一次——

> ⚠️ **跳板机通常是 SSH/隧道入口，不是应用服务器。** `heirloom-lite` 的运维文档把阿里云跳板用于连接后面的生产机；把公开 Web 服务直接跑在堡垒机上会增加攻击面，也可能违反该项目的运维约束。开工前必须确认：是部署在跳板机本机，还是经跳板部署到后面的生产机/新机器？两种都要先拿 owner 授权，并确认资源配额、端口和持久盘。
>
> 如果跳板机不让装 Node 24，用 Docker 镜像固定 Node `>=24.18.0 <25`；但 `DATA_DIR` 与 `OBJECT_STORE_DIR` 仍必须挂持久卷，且只能有一个写者。

架构对部署的要求不是「无状态」：

- **单写进程**：只有这一个应用进程持有 SQLite 写连接，同时提供 HTTP API 与 SSE。不要横向起多个副本共享同一个库文件，也不要让第二个进程写。
- **本地持久状态确实存在**：SQLite 文件（每个匿名用户一个，含会话/doc/transcript）和上传图片的对象存储都在应用侧。`DATA_DIR` 与 `OBJECT_STORE_DIR` 必须落在**持久盘**，否则重启/重新发布即丢数据（VERIFY V9）。
- **Node 版本硬要求**：本项目统一 **Node 24 线**（`.nvmrc` 写 `24`，`engines >=24.18.0 <25`；pi-durable/pi-ai 自身只要求 `>=22.19.0`，本项目取更严的 24 线）。跳板机上的 Node 不在该区间就先装 24（用户级 nvm 或 NodeSource 均可），不要用系统自带的旧 Node 硬跑。
- **PWA 与 SSE** 需要 HTTPS 和长连接；反向代理对 SSE 关掉缓冲（`proxy_buffering off`）。

#### 上机前先问跳板机 owner（不要直接改共享服务）

跳板机通常是共享入口，先确认这几件事，避免影响 `heirloom-lite` 现有服务：

1. 是否允许安装/常驻一个 Node 进程？是否允许用 `systemd` 或只能用户级 `systemctl --user`？
2. 有没有专用域名/端口？Nginx 是共用还是可以加一个 `server` 块？**不要改默认 server**。
3. 持久盘挂载点是什么（`/opt`、`/data`、还是只有系统盘）？有没有备份/快照？
4. 出网是否放行 `open.bigmodel.cn`、`ark.cn-beijing.volces.com`、`restapi.amap.com`？
5. 资源配额（CPU/内存/磁盘）和是否允许 80/443 之外的端口。

#### 上机先跑这组只读探测

```bash
uname -a; cat /etc/os-release
node -v; npm -v; corepack --version
df -h /opt /data /var
free -h; nproc
systemctl --version | head -1
nginx -v
ss -lntp | grep -E ':80|:443|:3000' || true
```

把输出贴回来，才能把 §7.1 的路径、端口、Node 安装方式写死；现在这些是 ⚠️，不是已知事实。

#### 推荐布局

```text
/opt/nextstop/
  app/                 # 代码 + node_modules + dist
  data/                # DATA_DIR：users/*.sqlite（含 WAL/SHM）
  data/objects/        # OBJECT_STORE_DIR
  .env                 # chmod 600，属主 nextstop
```

```bash
sudo useradd --system --home /opt/nextstop --shell /usr/sbin/nologin nextstop
sudo mkdir -p /opt/nextstop/{app,data/objects}
sudo chown -R nextstop:nextstop /opt/nextstop
sudo chmod 600 /opt/nextstop/.env
```

#### systemd（有 root 时）

```ini
[Unit]
Description=NextStop
After=network.target

[Service]
Type=simple
User=nextstop
WorkingDirectory=/opt/nextstop/app
EnvironmentFile=/opt/nextstop/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nextstop
sudo systemctl status nextstop --no-pager
```

没有 root 时用 `systemctl --user` + `loginctl enable-linger nextstop`，或 owner 指定的进程守护方式；**不要用两个进程同时写 `DATA_DIR`**。

#### 如果走 Docker（跳板机已有 Docker 时优先）

`heirloom-lite` 本身用 Docker，跳板机/生产机大概率已有 Docker；这时把 Node 24（`>=24.18.0 <25`）固定在镜像里，不污染宿主机：

```yaml
# /opt/nextstop/docker-compose.yml
services:
  nextstop:
    build: /opt/nextstop/app
    image: nextstop:local
    restart: unless-stopped
    env_file: /opt/nextstop/.env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/nextstop/data:/app/data
```

```bash
cd /opt/nextstop && docker compose up -d --build
docker compose logs -f --tail=100 nextstop
```

容器只监听宿主机回环地址；`/opt/nextstop/data` 必须是持久盘。**不要起两个副本共享同一个 `data` 目录。**

#### Nginx 反代（SSE 必须关缓冲）

```nginx
server {
  listen 443 ssl http2;
  server_name nextstop.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # SSE：/api/v1/radar/sessions/{id}/events
  location /api/v1/radar/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
}
```

应用只监听 `127.0.0.1:3000`，公网只开 80/443；SQLite 文件和 `.env` 不进任何静态目录。

#### 部署后必须验的 V9

```bash
# 1) 写一个文件，记下内容
date -Is | sudo -u nextstop tee /opt/nextstop/data/persist-probe.txt

# 2) 重启应用进程
sudo systemctl restart nextstop

# 3) 文件还在？
cat /opt/nextstop/data/persist-probe.txt

# 4) 重启整台 ECS（与 owner 约时间），再查一次
```

文件在 → 用 `openNodeSqliteStorage`；文件不在 → 按 ARCH §8.4 换适配器（外部数据库或 Cloudflare DO），不要假设系统盘一定持久。

---

## 附：官方文档入口

| 主题 | 地址 |
| --- | --- |
| 智谱 标准 API 介绍 | https://docs.bigmodel.cn/cn/api/introduction |
| 智谱 GLM-5.3-Flash 模型页 | https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash |
| 智谱 Coding Plan 快速开始（看了就知道为什么不能用） | https://docs.bigmodel.cn/cn/coding-plan/quick-start |
| 火山方舟 管理 API Key | https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh |
| 火山方舟 模型列表 | https://docs.volcengine.com/docs/ark/model-list?lang=zh |
| 火山 Agent Plan 套餐概览（API 调用限制） | https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh |
| 高德 创建应用和 Key | https://developer.amap.com/api/webservice/create-project-and-key |
| 高德 JS API 准备 | https://developer.amap.com/api/javascript-api-v2/prerequisites |
| 高德 JS API 安全密钥使用 | https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode |
| 高德 流量限制说明 | https://developer.amap.com/api/webservice/guide/tools/flowlevel |
| 高德 错误码说明 | https://developer.amap.com/api/webservice/guide/tools/info |
| 高德 搜索 POI 2.0 | https://developer.amap.com/api/webservice/guide/api-advanced/newpoisearch |
| 高德 路径规划 | https://developer.amap.com/api/webservice/guide/api/direction |
| 高德 坐标转换 | https://developer.amap.com/api/webservice/guide/api/convert |