# 截图删除的 TLC 有界模型

`ImageDeletion` 是 `e6c56d8` 的历史基线。`c27cc8a` 的持久化清理见 [ImageCleanupRetry 模型及复现](./cleanup-retry.md)。`a0f6cfa` 的批次清理发现见本页末尾的 [批次清理发现与重试](#批次清理发现与重试)。

模型以 `e6c56d8` 为基线，覆盖同一访客的普通批次项移除、单图来源删除和旅行删除。正式配置允许 SQLite 提交或中止、文件部分清理、清理失败和进程退出。所有 ID 和文件状态均为合成数据。

## 本地复现

从工作树根目录运行。使用 TLA+ 工具发行版 1.7.4（TLC2 2.19，修订 `5a47802`）。本机没有 `tlc` 包装命令时，可用 `java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC` 运行同样的参数。`-lncheck final` 在搜完状态图后检查活性。每次运行使用独立的临时状态目录。

```sh
out=$(mktemp -d)
model=verification/images/ImageDeletion
for suffix in '' EarlyCleanup EarlyAbort Orphans; do
  label=${suffix:-Main}
  tlc -lncheck final -fp 0 -workers 1 -metadir "$out/$label" \
    -config "$model$suffix.cfg" "$model.tla" > "$out/$label.log" 2>&1
  printf '%s exit=%s (%s)\n' "$label" "$?" "$out/$label.log"
done
```

| 配置 | 预期退出码 | 检查 |
| --- | ---: | --- |
| `ImageDeletion.cfg` | 0 | 安全不变量与无清理故障、无退出时的条件活性通过 |
| `ImageDeletionEarlyCleanup.cfg` | 12 | 改为先删后提交，`ReferencedFilesPresent` 在第一次 unlink 时失败 |
| `ImageDeletionEarlyAbort.cfg` | 12 | 同一变体单独检查 `AbortKeepsSnapshot`，轨迹走到中止，数据库仍引用已删文件 |
| `ImageDeletionOrphans.cfg` | 13 | 正式提交顺序，`EventuallyNoOrphans` 给出永久残留的反例 |

## 状态与性质

- 两趟旅行、一个批次和五个图片 ID。目标旅行包含两个待确认批次项、一个已保存批次项和一个独立上传。另一趟旅行有一个已保存的独立上传。已保存批次项同时有单图记录，批次归属在汇总时优先。两个初态分别保留和移除收藏里的两个图源，历史确认回执仍在。模型保留批次、单图记录、收藏和确认回执中的图源引用。
- 每条轨迹最多接纳三次写请求，最多经历一次进程退出和重启。`Begin` 读取已提交状态并锁定操作直到中止、完成、失败或退出。`Commit` 原子更换数据库状态。`Abort` 和退出前尚未成功的事务保留原数据库状态。缺失目标、批次已保存项和失效修订属于拒绝或幂等路径，在模型中用静止表示。无文件的无效批次项和空批次元数据没有单独建模。
- 每个图片 ID 有原图和规范化副本。不同 ID 的路径互不重叠，两份文件在初态均完好。递归删除可以先删任一副本，也可在删掉零份、一份或两份后失败或被打断。旅行按一个固定的合成图片顺序逐目录清理，第一次报错即结束。模型把提交后读取批次结果时的异常也归为清理前失败。重启或下一次请求从当前数据库重新计划，之前的清单只用于检查。
- `ReferencedFilesPresent` 要求所有已提交的图源引用始终有原图和规范化副本。`OnlyTargetsLoseFiles` 根据请求和操作前的数据库独立核对清理范围。`SuccessClearsOnlyTargets` 要求正常完成时恰好清掉目标的两份文件。`CommitKeepsOtherReferences` 核对提交只移除目标及其引用，旅行删除只解除保留来源的目标旅行归属，收藏共享来源及其他旅行保留。`UncommittedDbUnchanged` 和 `AbortKeepsSnapshot` 检查未提交状态和显式中止。
- `EventuallyNoOrphans` 要求每个失去所有引用的存量文件最终消失。`Spec` 对当前操作的进展使用弱公平，`CHECK_DEADLOCK FALSE` 允许已结束或没有新请求的状态静止。在无清理失败、无退出的轨迹上，有限的清理步骤最终执行完。发生故障时，即使进程重启并继续处理后续请求，已提交移除的目标也可能永远缺少清理机会。
- TLC 检查的是这个有限抽象。它假定 SQLite 在进程退出后保留成功提交、丢弃未提交写入，假定每个访客在计划、提交和清理期间只有一个写者，文件系统仅受所建模的动作修改。模型没有模拟真实 SQLite 和文件系统、主机掉电、外部文件修改、跨访客并行、上传或重新绑定、整户清除、HTTP 响应和缓存，以及雷达任务取消的副作用。

## 实现与回归入口

| 模型行为 | 基线实现 | 现有回归 |
| --- | --- | --- |
| 同一访客串行处理至清理结束 | [访客串行队列](../../apps/server/src/radar/user-access.ts#L20)、[隐私路由](../../apps/server/src/privacy/http.ts#L51) | 隐私与导入 HTTP 用例经这两个入口执行 |
| 批次项提交后清理，已保存项不能用该路径移除 | [批次移除](../../apps/server/src/imports/batch-http.ts#L268)、[提交和回读](../../apps/server/src/imports/batch-store.ts#L111) | [批次回滚保留待确认与已保存图源](../../apps/server/src/import-batch-http.integration.test.ts#L281) |
| 单图提交移除批次、单图记录和收藏图源 | [来源删除](../../apps/server/src/privacy/store.ts#L49)、[回执清理](../../apps/server/src/imports/store.ts#L75)、[收藏图源清理](../../apps/server/src/wishlist/store.ts#L164) | [隐私删除提交故障和重试](../../apps/server/src/privacy-http.integration.test.ts#L230) |
| 旅行提交移除独占图源，解除共享图源的旅行归属 | [旅行删除](../../apps/server/src/privacy/store.ts#L66)、[批次归属清理](../../apps/server/src/imports/batch-store.ts#L68) | [保留共享来源与清理两份文件](../../apps/server/src/privacy-http.integration.test.ts#L79) |
| 原图和规范化副本的文件清理 | [图片目录和递归删除](../../apps/server/src/imports/images.ts#L113) | 提交故障用例验证两份文件及图片 HTTP 响应。文件系统故障和重启轨迹由本模型覆盖 |

## 批次清理发现与重试

`ImageCleanupDiscovery` 从 `a0f6cfa` 的一次已提交移除且清理失败开始。模型覆盖一个批次、一个待清理截图和两个匿名访客，其中另一个访客没有该批次。`cleanupIds` 是原操作键下持久的 `image_ids`。`snapshots` 记录各访客各入口最近读取的结果。退役保留清单、磁盘和已有快照，刷新丢弃快照。成功重试清空清单及目标文件，更新提交重试的页面。其他页面可能保留旧入口，直到重新读取或刷新。

| 条件 | 导入恢复 GET | 新版设置 GET |
| --- | --- | --- |
| 批次有效且待清理 | `200`，提供截图 ID 和原修订 | `200`，无该批次项 |
| 批次退役且待清理 | `404 IMPORT_NOT_FOUND` | `200`，提供 `batch_item`、批次 ID、截图 ID 和原修订 |
| 清理完成 | 有效批次 `200`，条目为空。退役批次仍为 `404` | `200`，无该批次项 |
| 另一访客读取同一批次 | `404 IMPORT_NOT_FOUND` | `200`，无该批次项 |

旧设置读取始终排除该批次项。表中只列目标清理项。服务端对当前访客串行读取，模型把导入 URL 中的批次 ID 与两种响应提供的字段归一为同一个重放键。[导入 GET](../../apps/server/src/imports/batch-http.ts#L198) · [设置 GET](../../apps/server/src/privacy/http.ts#L13) · [清单筛选与确认](../../apps/server/src/imports/image-cleanup.ts#L62) · [HTTP 回归](../../apps/server/src/image-cleanup-http.integration.test.ts#L441)

`HealthyPendingEventuallyCompletes` 假定故障一旦解除便保持健康，访客最终执行持续可更新快照的读取（弱公平），并最终点击反复可用的重试入口（健康时强公平，因为连续刷新可反复清空快照）。故障解除本身无公平性要求。`CompletedSnapshotsEventuallyClear` 同样依赖读取或刷新。模型把健康重试中的文件删除、清单确认和提交页更新合并为一步，省略 HTTP 在途响应、浏览器缓存策略和其它删除类型。事务与精确重放的较细模型见 [ImageCleanupRetry](./cleanup-retry.md)。

从工作树根目录用同一版本 TLC 运行以下配置。

```sh
out=$(mktemp -d)
model=verification/images/ImageCleanupDiscovery
for suffix in '' MissingRetiredSettings MissingRetiredSettingsLiveness; do
  label=${suffix:-Main}
  tlc -lncheck final -fp 0 -workers 1 -metadir "$out/$label" \
    -config "$model$suffix.cfg" "$model.tla" > "$out/$label.log" 2>&1
  printf '%s exit=%s (%s)\n' "$label" "$?" "$out/$label.log"
done
```

正式配置预期退出 `0`。两个负例都只关闭新版设置对退役待清理项的枚举，模拟 `61e351b`。`MissingRetiredSettings` 预期以 `12` 报告 `RetiredDiscovery` 违反。`MissingRetiredSettingsLiveness` 预期以 `13` 报告 `HealthyPendingEventuallyCompletes` 违反，轨迹中故障已解除，访客重新读取仍无法发现重试入口。
