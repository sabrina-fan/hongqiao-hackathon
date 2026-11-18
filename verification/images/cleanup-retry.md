# 截图清理重试的 TLC 有界验证

基线为 `c27cc8a`。`ImageCleanupRetry` 覆盖批次项移除、来源删除和旅行删除。旧模型 `ImageDeletion` 仍对应 `e6c56d8`。

## 本机运行

在工作树根目录用 TLA+ 工具发行版 1.7.4 运行。`tlc` 包装器等价于 `java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC`。每个配置使用独立状态目录。`-lncheck final` 在完整搜索后检查活性。

```sh
out=$(mktemp -d "${TMPDIR:-/tmp}/nextstop-cleanup-tlc-final.XXXXXXXX")
model=verification/images/ImageCleanupRetry
for suffix in '' DropRegistration NoReplay RetiredBatch; do
  label=${suffix:-Main}
  _JAVA_OPTIONS=-Xmx1g tlc -lncheck final -fp 0 -workers 1 \
    -metadir "$out/$label" -config "$model$suffix.cfg" "$model.tla" > "$out/$label.log" 2>&1
  code=$?
  printf '%s exit=%s (%s)\n' "$label" "$code" "$out/$label.log"
done
```

| 配置后缀           | 预期退出码 | 检查                                                                                 |
| ------------------ | ---------: | ------------------------------------------------------------------------------------ |
| 无                 |          0 | 下述安全性质、清理和响应的条件活性                                                   |
| `DropRegistration` |         12 | 唯一变体跳过删除事务内的清理清单写入。`AtomicRegistration` 在首次这样的提交后失败    |
| `NoReplay`         |         13 | 原模型加上“故障恢复后空闲的待清理请求最终都会完成”。TLC 可停在仍有清单的状态         |
| `RetiredBatch`     |         12 | 原模型加上“故障恢复后，重提仍有清单的批次删除必定得到成功响应”。批次可在重提前已退役 |

## 模型与实现的对应

| 性质                                       | 模型检查                                                                                                                                                          | 实现入口                                                                                                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AtomicRegistration`                       | 首次删除原子更新所建模的业务数据并登记固定目标，确认前记录不丢失，确认后 `source`/`trip` 记录退役，批次键保留空清单。历史检查状态从提交前业务引用独立计算预期目标 | [来源与旅行事务](../../apps/server/src/privacy/store.ts#L61)、[批次项事务](../../apps/server/src/imports/batch-store.ts#L173)、[登记及确认](../../apps/server/src/imports/image-cleanup.ts#L44)                                                      |
| `ExactResume`、`LoadRestartsFromBeginning` | 精确匹配访客、操作类型、ID 和批次版本。每次从原清单第一项开始，工作游标只能是清单的后缀，已经越过的目录须不存在。重复删除不存在的目录允许成功                     | [重提与确认](../../apps/server/src/imports/image-cleanup.ts#L57)、[文件删除适配](../../apps/server/src/imports/images.ts#L129)                                                                                                                       |
| `PreservedReferences`                      | 清理仅影响删除计划包含的 ID。仍有批次、单图、收藏或单图确认回执引用的目录和两份文件均保留。旅行删除解除共享来源的旅行归属，并保留其收藏和回执引用                 | [旅行目标选择](../../apps/server/src/privacy/store.ts#L94)、[来源与回执调整](../../apps/server/src/imports/store.ts#L75)                                                                                                                             |
| `SettingsDiscovery`                        | 模拟进入队列后的新鲜设置读取。当前访客获得所有待清理的 `source`、`trip` 键，另一个空白访客得到空集合，批次清单不出现在设置结果里                                  | [设置路由](../../apps/server/src/privacy/http.ts#L13)、[当前会话扫描](../../apps/server/src/runtime/open-user-runtime.ts#L60)、[键筛选](../../apps/server/src/imports/image-cleanup.ts#L30)、[设置页重提](../../apps/web/src/SettingsPanel.tsx#L198) |
| `AckAndReplySound`                         | 清单确认要求全清。对已登记请求建模的成功响应须晚于持久确认。目标不存在且无匹配清单的 `source`/`trip` 204 是静止步，无法确认另一请求的清单                         | [隐私响应](../../apps/server/src/privacy/http.ts#L58)、[批次响应](../../apps/server/src/imports/batch-http.ts#L269)                                                                                                                                  |

`HealthyReplayCleans` 从故障已解除且原请求已被服务端接纳、匹配到未确认登记的状态起，要求该清单最终持久确认。`HealthyReplayConfirms` 在同样条件下检查 `source` 和 `trip` 的成功响应，以及批次尚在时的批次项成功响应。队列内进展使用弱公平，故障解除后有限的文件删除、确认和响应步骤会完成。故障解除、进程重启和用户重提均无公平性要求。因此允许恢复后无人重提的轨迹。若回复丢失时确认事务已提交，文件已经清理，之后的无清单路径按 API 的幂等规则处理。

## 边界与假设

- 一个有数据的访客和一个空白的访客，两个旅行，一个仅含一项的批次，四个合成图片 ID。`tripA` 有两个独占图和一个收藏共享图，`tripB` 有一个图。批次身份隐含且版本域为 `0..2`。每条轨迹最多成功提交两次新的逻辑删除，已登记请求可反复重提。批次项和独立单图在本夹具中互斥，另一个访客的请求用于检查空白访客下的键隔离。
- 假定每个访客从计划到文件清理都串行。第一次提交持久化元数据与清单，第二次提交持久化确认。显式失败代表事务中止、清理或回读异常等。进程退出清空请求和文件游标，保留已提交数据以及已发生的文件删除。重启本身不发起清理。文件按合成顺序逐目录清理，目录中的原图、副本可按任意顺序移除，空目录也单独表示。允许清理部分目录或副本后失败，或全部清完但确认前失败。
- `Repair` 抽象为一次稳定恢复。恢复后排除新的进程退出、存储或清理故障，队列中的操作最终推进。使用两个事务的抽象原子性、稳定的访客身份以及唯一且互不重叠的图片目录。验证范围为有限状态上的性质，SQLite 和文件系统的实现与主机掉电属于假设之外。
- 设置性质只涵盖新鲜响应所能枚举的键。浏览器缓存、渲染和点击、队列公平性、整户删除、上传或重绑、无图片批次项、多批次并发、雷达副作用以及已退役文档的物理 SQLite 字节均未建模。HTTP 回归另行检查重开、身份隔离、版本拒绝及实际图片响应。

## 批次退役后的 HTTP 复现

在 `c27cc8a` 上用普通用户、Node 24 和本机依赖运行。脚本只监听 `127.0.0.1`，使用临时数据目录、合成截图和本地适配器。`chmod` 故障来自实际文件权限。

```sh
pnpm build:packages
node --import tsx --input-type=module <<'JS'
import { createApp } from './apps/server/src/app.ts';
import { createAmap } from './apps/server/src/radar/amap.ts';
import { reproduce } from './verification/images/repro-retired-batch.mjs';
await reproduce(createApp, createAmap);
JS
```

1. 创建旅行，上传只含一张截图的批次并等到核对就绪。
2. 暂时移除截图目录写权限。用当前版本移除批次项，HTTP 返回 `500 INTERNAL_ERROR`，批次读取已是空列表且版本增加。恢复目录写权限。
3. 删除所属旅行，HTTP 返回 `204`，批次读取返回 `404`。此时两份截图仍在。
4. 以原版本重提第 2 步，文件目录消失，响应为 `404 IMPORT_NOT_FOUND`。再次重提仍返回相同错误。

重提先按旧版本的键续做并持久确认，然后回读已退役的批次。这个场景影响批次项接口的成功确认，文件已经清完。 [重提回读](../../apps/server/src/imports/batch-store.ts#L186) · [批次退役](../../apps/server/src/imports/batch-store.ts#L85)
