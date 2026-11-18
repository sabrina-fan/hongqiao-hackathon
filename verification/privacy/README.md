# 整户删除确认的 TLC 有界验证

`EraseConfirmationBinding` 对应 `38d2402`。两个标签共享一个当前匿名会话 Cookie，各自持有打开确认框时的访客绑定和删除模式。换签只更新共享 Cookie，另一个标签的确认目标保持原样。

## 本机运行

从工作树根目录运行。使用 TLA+ 工具发行版 1.7.4（TLC2 2.19，修订 `5a47802`）。`tlc` 可用 `java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC` 替换。每个配置使用独立的临时状态目录。

```sh
out=$(mktemp -d)
model=verification/privacy/EraseConfirmationBinding
for suffix in '' LegacyOrdinary; do
  label=${suffix:-Main}
  tlc -lncheck final -fp 0 -workers 1 -metadir "$out/$label" \
    -config "$model$suffix.cfg" "$model.tla" > "$out/$label.log" 2>&1
  printf '%s exit=%s (%s)\n' "$label" "$?" "$out/$label.log"
done
```

| 配置                                         | 预期退出码 | 检查                                                                             |
| -------------------------------------------- | ---------: | -------------------------------------------------------------------------------- |
| `EraseConfirmationBinding.cfg`               |          0 | 正常绑定、数据和撤销隔离、拒绝无副作用、删除失败后重试                           |
| `EraseConfirmationBindingLegacyOrdinary.cfg` |         12 | 模拟 `f62799a` 持有有效 Cookie 的普通删除路径，`NoCrossSessionTripDeletion` 失败 |

负向配置只替换普通请求的发送和接纳规则。普通请求省略绑定，服务端按当前 Cookie 选定访客。续做仍使用正向规则。该配置选择检查行程丢失，避免在空的新会话首次被撤销时提前结束。TLC 的 7 状态反例由健康初态开始，A、B 各打开原会话的普通确认，A 提交成功并清除 Cookie，浏览器获得新 Cookie 并保存新行程，B 用原确认提交。最后一次返回 `204`，新行程消失，新会话加入撤销集合，Cookie 再次被清除。正向配置中对应的 B 请求返回 `401`，新行程、撤销集合和 Cookie 保持原样。

## 性质与实现对应

| 模型检查                                                                                                                                                                      | 实现与回归                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NoCrossSessionTripDeletion`、`NoCrossSessionRevocation` 以确认时的访客为范围，对比请求前后的行程和撤销集合                                                                   | [响应返回访客绑定](../../apps/server/src/privacy/http.ts#L81) · [确认框保存快照](../../apps/web/src/SettingsPanel.tsx#L125) · [提交使用快照](../../apps/web/src/settings-client.ts#L44)                                                          |
| `StaleConfirmationIsRejected`、`UnboundRequestIsRejected`、`RejectedEraseHasNoServerEffects` 要求普通和续做的旧确认或无绑定请求返回 `401`，行程、撤销集合和 Cookie 均保持原样 | [先检查绑定再删除](../../apps/server/src/privacy/http.ts#L63) · [路由单测检查未调用删除](../../apps/server/src/privacy/http.test.ts#L8) · [HTTP 集成覆盖两种模式的无绑定和过期请求](../../apps/server/src/privacy-http.integration.test.ts#L102) |
| `AcceptedEraseLifecycle` 要求续做目标已撤销，清理失败后保留 Cookie 和原确认以便重试，成功后清除行程及 Cookie                                                                  | [先写撤销标记再清理](../../apps/server/src/radar/user-access.ts#L75) · [HTTP 集成检查 500、恢复读取及 204](../../apps/server/src/privacy-http.integration.test.ts#L72)                                                                           |

正向状态图中可达普通确认 `500` 后在同一确认框重试成功，亦可关闭并重新读取设置，以同一访客打开续做确认，续做再次 `500` 后重试成功。若其他标签先完成并换签，原普通或续做确认仍可提交到拒绝分支。旧客户端两种请求即使带有正确 Cookie，缺绑定也可达 `401`。旧版和修复版的本地 Ego 双标签场景分别观测到误删和保留新行程。文件权限故障场景另行观测到刷新后的续做入口和实际清理结果。

## 模型边界

- 两个标签和两个合成访客。初态原访客有一条行程。原 Cookie 在成功删除前可继续用于重试，换签最多一次，新访客最多保存一条行程。`trips` 只记录每个访客的代表行程是否存在，`revoked` 记录持久撤销标记。
- 绑定用原访客 ID 抽象表示，提交时读取共享 Cookie。假定签名验证正确，绑定能区分两个访客。模型区分有效与缺失的 Cookie，并显式表示缺失绑定。Cookie 期限和 HMAC 算法在范围之外。HTTP 集成测试另行检查格式无效的绑定和无效 Cookie。
- 设置读取与打开确认合为一步，撤销、清理结果和 HTTP 回执合为一次删除转换。`500` 表示写完撤销标记后清理失败，代表行程可能还在或已被删。`401` 后关闭弹窗代表用户点「返回当前设置」。故障可在初态存在，最多修复一次。每个标签可以反复打开、关闭或提交，用户何时推进由 TLC 枚举。`CHECK_DEADLOCK FALSE` 允许停在无人继续操作的状态，配置只检查安全性质。
- HTTP 请求在途、响应重排和设置页缓存超出模型范围。实际文件清理、SQLite/WAL 和 Service Worker 离线回读的具体场景由现有 HTTP/Ego 验收提供证据。
