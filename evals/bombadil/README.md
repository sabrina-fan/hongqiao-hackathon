# Bombadil UI 属性测试

[Bombadil](https://github.com/antithesishq/bombadil) 随机探索浏览器界面并持续校验属性。
本目录的 `nextstop.ts` 面向 NextStop 的雷达与行程页面。

## 运行

1. 安装 Bombadil 0.8.0 或更新版本，并确保 `bombadil` 在 `PATH` 中：

   ```bash
   curl -L -o bombadil https://github.com/antithesishq/bombadil/releases/download/v0.8.0/bombadil-aarch64-darwin
   chmod +x bombadil && mv bombadil ~/.local/bin/
   ```

2. 对已部署环境或本地开发服务器运行：

   ```bash
   bombadil browser test --headless --time-limit=2m \
     https://nextstop.sunwentong.cn evals/bombadil/nextstop.ts
   ```

   移动端布局另跑一轮：

   ```bash
   bombadil browser test --headless --width 390 --height 844 --time-limit=2m \
     https://nextstop.sunwentong.cn evals/bombadil/nextstop.ts
   ```

3. 查看结果：`bombadil browser inspect <trace>`，或在终端执行
   `bombadil trace <trace> --json`。退出码 0 表示时限内未发现违规，2 表示有属性违规。

## 覆盖内容

- 默认属性：未捕获异常、未处理 Promise 拒绝、console error、导航响应 4xx。
- 标签导航：四个标签恰好一个 `aria-current="page"`，且与 URL hash 一致。
- 雷达表单：提交按钮仅在出发地、目的地和 1–720 分钟都有效时可用。
- 行程：站点名称不重复；卡片上的“已加入 N 个地点”与列表数量一致。
- 渲染卫生：页面不出现密钥名/密钥串、原始错误码、`undefined`/`NaN`/`[object Object]`，且无横向溢出。
- `planPath` 自定义动作每个浏览器会话执行一次“选址 → 提交”真实流程，覆盖模型提案与行程确认。

## 成本与边界

- `planPath` 每次运行最多触发一次真实模型调用；不需要付费路径时，删除 `planPath` 的导出即可。
- Bombadil 只驱动 Chrome，不覆盖多浏览器、文件上传选择器和真实移动设备。
- 探索范围限定在起始 origin 内。
