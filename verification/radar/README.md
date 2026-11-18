# 雷达确认的 TLC 模型

从仓库根目录运行。`tlc` 可用 `java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC` 替换。本轮使用 TLA+ 工具发行版 1.7.4，TLC2 2.19（`5a47802`）。

```sh
out=$(mktemp -d)
tlc -fp 0 -workers 1 -metadir "$out/main" \
  -config verification/radar/RadarAcceptance.cfg verification/radar/RadarAcceptance.tla
tlc -fp 0 -workers 1 -metadir "$out/mutation" \
  -config verification/radar/RadarAcceptanceUndoMutation.cfg verification/radar/RadarAcceptance.tla
```

第二条预期退出 12 并报告 `LiveStopsMatchReceipts` 违反。变体只把 `RemoveByStopId` 改为 `FALSE`。错误实现清空目标旅行的雷达停靠项。两次确认可以加入同一 POI，撤销第一笔仍须保留第二笔的不同停靠项。

## 界限与性质

- 一个用户和一个串行写者，两个雷达会话、两个幂等键、一个共享 POI。两个旅行中只初始存在一个，可创建另一个并切换当前旅行一次。每个旅行可独立编辑一次，修订上界为 6。每个会话可发布一次、刷新一次。请求枚举当前绑定、刷新前的绑定、七个字段逐一不符以及候选不符。
- 时钟为离散的 `0..5`。证据在发布或刷新时采集，TTL 为 2 tick，到期点排除。最新出发点包含在窗口内，发布时余量取 0 或 3 tick。原旅行的进行中固定安排覆盖 `[2, 4)`。模型用一个时间戳表示已采齐的证据，并用一个编辑标记表示独立的后来写入。
- `AuthorizedAndAtomic` 核对产生新回执的转换，以及已有回执的不可变性。`HistoricalReplay` 检查同键同请求仍可拿到原回执，同键异参发生冲突。`LiveStopsMatchReceipts` 核对行程中的停靠项与生效接受记录一一对应。`DirectedUndo` 核对撤销基于回执旅行的当前内容，仅移除目标 `stop_id`，并保留其余停靠项、独立编辑、另一旅行和幂等回执。
- `CHECK_DEADLOCK FALSE` 允许有限时钟耗尽后静止。检查的是安全性，时钟推进、重试和撤销均为可选动作。发布动作合并了服务端验证与发布，`poolRev` 在发布中固定为 1，客户端不符仍逐字段枚举。业务时间计算、候选池筛选细节、并行 I/O、重开 SQLite、访客隔离和删除旅行由实现与测试另行覆盖。确认、编辑和撤销各用一个原子转换表示。

## 实现与测试映射

| 抽象动作 | 实现 | 已有测试 |
| --- | --- | --- |
| `Publish`、`Refresh`、新确认绑定检查 | [发布与确认](../../apps/server/src/radar/store.ts#L222)、[更新召回提案](../../apps/server/src/radar/recall-store.ts#L99)、[绑定对照](../../packages/core/src/proposal-binding.ts#L3) | [核心绑定检查](../../packages/core/src/core.test.ts#L73)、[SQLite 快照修订变化](../../apps/server/src/radar/store.integration.test.ts#L294)、[HTTP 竞争标签页](../../apps/server/src/radar-http.integration.test.ts#L1138) |
| `Tick`、新确认的证据和固定安排检查 | [单候选校验](../../apps/server/src/radar/store.ts#L184)、[候选单独复筛](../../apps/server/src/radar/recall.ts#L229)、[固定安排开始与结束](../../apps/server/src/radar/fixed-stop.ts#L40) | [证据过期与窗口耗尽](../../apps/server/src/radar/store.integration.test.ts#L199)、[另一候选过期后仍可确认](../../apps/server/src/radar-http.integration.test.ts#L528)、[固定安排精确结束](../../apps/server/src/radar-http.integration.test.ts#L879) |
| `Confirm`、`CommitConfirmation` | [请求指纹与事务内重放](../../apps/server/src/radar/store.ts#L400) | [同键重试、异参与新键](../../apps/server/src/radar/store.integration.test.ts#L350)、[并发、过期和重启](../../apps/server/src/radar-http.integration.test.ts#L687) |
| `EditTrip`、`CreateLaterTrip`、`Undo` | [旅行写入](../../apps/server/src/trip/store.ts#L142)、[按回执旅行和停靠项撤销](../../apps/server/src/radar/acceptance.ts#L35) | [丢回执、追加同 POI、独立编辑、切换旅行、并发撤销与撤销后重放](../../apps/server/src/radar-http.integration.test.ts#L776) |

本轮增加了恰好可排入窗口的单候选 HTTP 回归，并将公开的 `valid_until` 统一为首个失效毫秒。ETA 到期仍为排他的上限。[HTTP 回归](../../apps/server/src/radar-http.integration.test.ts#L973) · [过期时间计算](../../apps/server/src/radar/store.ts#L112)
