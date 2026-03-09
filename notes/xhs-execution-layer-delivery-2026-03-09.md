# 小红书执行层结构化交付

## 交付定位

- 交付名称：小红书执行层交付文档
- 交付日期：2026-03-09
- 交付状态：可用闭环完成
- 交付范围：只覆盖小红书发布执行层
- 不覆盖：选题、改写、出图、增长分析、发布后回流

## 交付建议

- 主交付物放进 GitHub 仓库。
- 原因：这类交付需要版本化、可审计、可交接、可持续更新。
- 本地产物只作为运行证据保留：
  - `summary.json`
  - `preview.png`
  - `smoke-report.json`

## 交付内容

### 1. 仓内执行层代码

- 命令行入口：[`scripts/xhs-post.ts`](../scripts/xhs-post.ts)
- 冒烟验证入口：[`scripts/xhs-smoke.ts`](../scripts/xhs-smoke.ts)
- 命令编排：[`src/xhs/cli.ts`](../src/xhs/cli.ts)
- 浏览器远程调试协议桥接：[`src/xhs/bridge.ts`](../src/xhs/bridge.ts)
- 远程图片下载：[`src/xhs/images.ts`](../src/xhs/images.ts)
- 审核产物输出：[`src/xhs/audit.ts`](../src/xhs/audit.ts)
- 冒烟验证编排：[`src/xhs/smoke.ts`](../src/xhs/smoke.ts)

### 2. 已交付命令能力

- `check-login`
- `login`
- `fill`
- `draft`
- `save-draft`
- `click-publish`
- `publish`
- `cleanup-published`
- `xhs:smoke`

### 3. 已交付运行产物

- `--audit-dir`
  - 输出 `summary.json`
  - 输出 `preview.png`
- `--report-dir`
  - 输出 `smoke-report.json`
  - 输出分步骤审核目录
- `cleanup-published`
  - 支持 `--cleanup-title`
  - 支持 `--report-file`
  - 默认预演
  - `--apply` 才会真删

### 4. 已交付测试与验证

- 单元测试：
  - [`src/xhs/bridge.test.ts`](../src/xhs/bridge.test.ts)
  - [`src/xhs/cli.test.ts`](../src/xhs/cli.test.ts)
  - [`src/xhs/images.test.ts`](../src/xhs/images.test.ts)
  - [`src/xhs/audit.test.ts`](../src/xhs/audit.test.ts)
  - [`src/xhs/smoke.test.ts`](../src/xhs/smoke.test.ts)
- 静态校验：
  - `pnpm tsgo`
  - `pnpm exec oxlint --type-aware ...`
  - `pnpm exec vitest run --config vitest.unit.config.ts src/xhs/*.test.ts`
- 真实链路验证：
  - `check-login`
  - `draft`
  - `save-draft` 非编辑页失败
  - `click-publish` 真实发布
  - `publish` 真实发布
  - `audit-dir` 实际落盘
  - `report-dir` 实际落盘
  - `cleanup-published` 预演实际命中

## 当前架构

### 上下游边界

- 上游：人工提供标题、正文、图片或图片地址
- 中间层：OpenClaw 仓内执行层
- 下游：小红书创作后台页面与本地浏览器远程调试协议连接

### 模块职责

- `scripts/xhs-post.ts`
  - 单一命令行入口
- `src/xhs/cli.ts`
  - 参数解析
  - 命令分发
  - 审核输出接线
- `src/xhs/bridge.ts`
  - 浏览器连接
  - 创作者标签页复用
  - 填充、存草稿、发布
  - 已发布笔记清理
- `src/xhs/audit.ts`
  - 执行留痕落盘
- `src/xhs/smoke.ts`
  - 真实冒烟验证编排
  - 真实发布保护开关

## 交付后的能力判断

现在完成的是：

- 一个执行型能力层
- 一个可手动调用的发布执行器
- 一个可回归的冒烟验收入口
- 一个带审核留痕的运行层

现在还没有完成的是：

- 输入层
  - 选题来源、素材入口、信号采集
- 内容层
  - 改写、标题生成、配图生成、封面生成
- 审核流层
  - 正式人审、合规审核、发布审批
- 编排层
  - 队列、状态机、定时、重试、批量任务
- 数据回流层
  - 发布后指标抓取、复盘、策略迭代
- 运维治理层
  - CI 级无人值守验收、监控告警、账号治理

## 已知边界

- 仍依赖页面结构选择器，页面大改版时需要跟进修复。
- 还不是 CI 级无人值守运行。
- 草稿箱没有稳定独立列表页，草稿清理仍需人工处理。
- 真实发帖仍需人工显式放行。

## 推荐用法

### 日常执行

- 发布前先跑：
  - `pnpm xhs -- check-login`
- 需要草稿：
  - `pnpm xhs -- draft --audit-dir ...`
- 需要真实验收：
  - `pnpm xhs:smoke -- --report-dir ...`

### 真实发布验收

- 首次优先：
  - `click-publish`
- 直连补充：
  - `publish`
- 真实发布前必须同时满足：
  - `--allow-live-publish`
  - `OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1`

### 测试帖清理

- 推荐先做预演：
  - `pnpm xhs -- cleanup-published --report-file ...`
- 确认后再：
  - `pnpm xhs -- cleanup-published --report-file ... --apply`

## 建议下一步

- 如果继续做执行层：
  - 只做 CI 级验收
  - 只做清理自动化
- 如果进入下一阶段：
  - 从内容层开始，不要再回头扩执行层细节

## 关联文档

- 交接文档：[`notes/xhs-bridge-handoff-2026-03-06.md`](./xhs-bridge-handoff-2026-03-06.md)
