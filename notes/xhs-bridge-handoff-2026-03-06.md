# 小红书发布桥接交接

## 当前目标

把“小红书图文草稿执行层”先做成稳定的本地桥接能力，再逐步内收到 OpenClaw。

当前范围只覆盖：

- 登录检查
- 填充标题、正文、图片
- 存草稿
- 手动或半自动发布

当前范围不覆盖：

- 选题抓取
- 文案生成
- 封面出图
- 正式话题选择
- 置顶评论
- 发布后数据回流

## 已完成

### OpenClaw 仓库内

- 新增统一入口脚本：`scripts/xhs-post.ts`
- 新增命令：`pnpm xhs`
- 已支持命令：
  - `check-login`
  - `login`
  - `fill`
  - `draft`
  - `save-draft`
  - `publish`
  - `click-publish`
- 已兼容两种调用方式：
  - `pnpm xhs check-login`
  - `pnpm xhs -- check-login`

### 真实验证结果

- `check-login` 已验证可用
- `draft` 已验证可用
- `draft` 会先走 fill-only，再自动点击“暂存离开”
- 草稿箱已实测从 `10` 增加到 `11`
- 已确认不再每次命令都新开一个小红书页面

### 标签页复用

之前的问题是每次调用时容易反复新开小红书页面。

根因不在 OpenClaw 外层，而在借用的 `xiaohongshu-mcp` 本地脚本：

- 默认 `connect()` 在不传目标前缀时会走 `json/new`
- 导致频繁新建 tab

现在已经改成：

- 优先复用已有的 `https://creator.xiaohongshu.com/...` 标签页
- 只有完全没有 creator 页时才新开

## 当前架构

当前结构已经是“OpenClaw 统一入口 + 仓内执行层”：

1. `openclaw/scripts/xhs-post.ts`
   - 统一 CLI 入口

2. `openclaw/src/xhs/cli.ts`
   - 负责命令解析
   - 负责 `fill/draft/publish/save-draft/click-publish` 编排

3. `openclaw/src/xhs/bridge.ts`
   - 负责 Chrome/CDP 连接
   - 负责 creator 标签页复用
   - 负责标题/正文/图片填充、草稿保存、点击发布

4. `openclaw/src/xhs/images.ts`
   - 负责远程图片下载

5. `openclaw/src/xhs/smoke.ts`
   - 负责执行层真实 smoke
   - 默认只做非发布验证
   - 真实发布验证需要显式 gate

6. 专用浏览器
   - Chrome profile：`~/.codex/chrome-mcp-profile`
   - CDP 端口：`9222`

## 当前命令

```bash
corepack pnpm xhs -- check-login

corepack pnpm xhs -- draft \
  --audit-dir /tmp/xhs-audit \
  --title "标题" \
  --content "正文" \
  --image /绝对路径/图片.png

corepack pnpm xhs -- save-draft --title "当前编辑页标题"

corepack pnpm xhs -- click-publish

corepack pnpm xhs -- cleanup-published \
  --report-file /tmp/xhs-smoke/smoke-report.json \
  --apply

corepack pnpm xhs:smoke -- --report-dir /tmp/xhs-smoke

OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1 corepack pnpm xhs:smoke -- \
  --allow-live-publish \
  --publish-command click-publish
```

## 已知缺口

### 1. 还只是“执行层”

当前没有统一处理：

- 选题
- 改写
- 出图
- 预览审核
- 站内 CTA
- 发布后回流

### 2. 仍依赖页面 DOM

当前草稿保存依赖：

- “暂存离开”按钮
- “草稿箱”
- “保存成功”

这套逻辑可用，但页面结构一变就可能失效。

### 3. 还没有 CI 级自动化验收

当前已经有 `pnpm xhs:smoke`，也做过真实线上验证，但仍需要：

- 已登录账号
- 本地 Chrome + CDP
- 人工控制是否允许真实发帖

因此它还不是可直接接入 CI 的无人值守验收。

### 4. 草稿清理仍是人工动作

已发布 smoke 测试帖现在可通过 `cleanup-published` 命令按精确标题或 `smoke-report.json` 清理，但草稿箱仍只有“编辑最新笔记”入口，没有独立草稿列表页，因此草稿清理暂时仍需人工执行。

## 已完成的执行层增强

### 1. 审核输出

`fill` / `draft` / `publish` 成功后会输出：

- 标题
- 正文
- 图片路径
- 当前页面状态
- `preview.png`
- `summary.json`

可通过 `--audit-dir` 指定目录，否则走临时目录。

### 2. smoke 留痕与操作手册

`pnpm xhs:smoke` 现在会稳定输出：

- `smoke-report.json`
- 分步骤 `audit` 目录
- 真实发布时的 `cleanupNotes`

使用约定：

- 默认 `publish-command=none`，只做非发布验证
- 首次真实发帖优先用 `click-publish`
- `publish` 作为直连路径补充验证
- 真实发帖前必须显式设置：
  - `--allow-live-publish`
  - `OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1`

### 3. 已发布测试帖清理

已支持：

- `cleanup-published --report-file ...`
- `cleanup-published --cleanup-title ...`
- 默认 dry-run
- 只有显式 `--apply` 才会真正删除

当前范围只覆盖“已发布笔记管理页”里的删除，不覆盖草稿箱。

### 4. 后续真正剩余的方向

#### A. CI 级无人值守验收

这部分后面再做，需要解决：

- 登录态托管
- 独立 Chrome 环境
- 真实发帖的安全沙箱与回滚

#### B. 内容层

内容层后面再做，不要现在就混进发布执行层：

- X / GitHub / Agent-Reach 选题
- 小红书改写
- Nano Banana / Gemini 出图

## 当前判断

现在执行层可以视为“闭环完成”。

它已经能稳定做：

- 登录检查
- 图文填充
- 草稿保存
- 标签页复用
- 仓内自包含执行
- 审核输出
- 真实 smoke 验证
- smoke 报告留痕
- `click-publish` / `publish` 两条路径的真实发布验证

但它还不具备：

- CI 级自动化发布验收
- 内容层闭环

## 2026-03-07 最小 smoke 结果

已在 `codex/xhs-draft-bridge-handoff-20260306` 分支上完成一轮最小真实验证，范围仍只覆盖执行层：

- `pnpm xhs -- check-login`：通过，返回 `LOGIN_CONFIRMED`
- `pnpm xhs -- draft --title ... --content ... --image /tmp/openclaw-xhs-smoke.png`：通过，返回 `FILL_STATUS: READY_TO_PUBLISH` 和 `DRAFT_STATUS: SAVED`
- `pnpm xhs -- save-draft`（当前不在编辑页）：按预期失败，返回 `No editable Xiaohongshu compose page is open.`

说明：

- 本轮 smoke 已验证仓内内收后的执行层可以直接工作，不再依赖 `../xiaohongshu-mcp`
- 本轮为了避免真实发帖，没有执行 `click-publish` / `publish` 的线上动作
- 本轮 `draft` 会在草稿箱新增一条测试草稿，标题为 `OpenClaw XHS smoke 2026-03-07 14:51:12`

## 2026-03-07 扩展 smoke 与加固结果

- 已新增 `pnpm xhs:smoke`
- 已把 `check-login` 的标签页复用校验纳入 smoke
- 已把 `draft` 的真实填充与存草稿校验纳入 smoke
- 已把“离开编辑页后 `save-draft` 必须失败”纳入 smoke
- 已为真实发帖验证补上显式 gate，避免误发
- 已加固发布页的关键 DOM 选择器与按钮识别逻辑

## 2026-03-07 真实 click-publish 验证结果

- 已执行：
  `OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1 pnpm xhs:smoke -- --allow-live-publish --publish-command click-publish`
- 结果：通过
- 真实发布标题：
  `OpenClaw XHS smoke click-publish 2026-03-07 07:29:37`
- 同轮 smoke 仍同时通过：
  - `check-login` 复用 creator tab
  - `draft` 真实填充并存草稿
  - 离开编辑页后 `save-draft` 明确失败

## 2026-03-07 真实 publish 验证结果

- 已执行：
  `OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1 pnpm xhs:smoke -- --allow-live-publish --publish-command publish`
- 结果：通过
- 真实发布标题：
  `OpenClaw XHS smoke publish 2026-03-07 07:47:03`
- 说明：
  `publish` 直连路径与 `click-publish` 路径都已完成真实线上验证

## 2026-03-09 审核输出与 smoke 报告验证

- 已执行：
  `pnpm xhs -- draft --audit-dir /tmp/openclaw-xhs-audit-check.Byg9cK ...`
- 结果：通过
- 已确认产出：
  - `/tmp/openclaw-xhs-audit-check.Byg9cK/preview.png`
  - `/tmp/openclaw-xhs-audit-check.Byg9cK/summary.json`

- 已执行：
  `pnpm xhs:smoke -- --report-dir /tmp/openclaw-xhs-smoke-report.9GycNq`
- 结果：通过
- 已确认产出：
  - `/tmp/openclaw-xhs-smoke-report.9GycNq/smoke-report.json`
  - `/tmp/openclaw-xhs-smoke-report.9GycNq/draft/preview.png`
  - `/tmp/openclaw-xhs-smoke-report.9GycNq/draft/summary.json`

## 2026-03-09 已发布测试帖清理 dry-run 验证

- 已执行：
  `pnpm xhs -- cleanup-published --cleanup-title "OpenClaw变现靠谱吗" --cleanup-title "OpenClaw XHS smoke click-publish 2026-03-07 07:29:37"`
- 结果：通过
- 返回：
  - `OpenClaw变现靠谱吗` -> `would_delete`
  - `OpenClaw XHS smoke click-publish 2026-03-07 07:29:37` -> `not_found`
- 说明：
  - 已确认命令能在笔记管理页精确匹配标题
  - 默认不会删除，只有传 `--apply` 才会执行

## 新窗口接手提示词

下面这段可以直接复制到新窗口使用：

```text
继续处理 OpenClaw 里的小红书发布桥接。

仓库地址：
https://github.com/openclaw/openclaw

先读这份交接：
notes/xhs-bridge-handoff-2026-03-06.md

当前已经完成：
1. scripts/xhs-post.ts 已作为统一入口接到 package.json 的 pnpm xhs
2. check-login / fill / draft / save-draft / click-publish / publish 已可用
3. pnpm xhs -- check-login 和 pnpm xhs check-login 都已兼容
4. 执行层已经正式内收到 openclaw，不再依赖 ../xiaohongshu-mcp
5. 已补 pnpm xhs:smoke，并完成真实非发布 smoke
6. click-publish 和 publish 两条路径都已完成真实线上验证
7. 已修复频繁新开小红书页面的问题，现在默认复用同一个 creator 标签页
8. fill / draft / publish 已支持 --audit-dir 输出 preview.png + summary.json
9. pnpm xhs:smoke 已支持 --report-dir 输出 smoke-report.json 和 cleanupNotes
10. 已支持 cleanup-published，对已发布 smoke 测试帖做 dry-run / apply 清理

当前最大问题：
当前执行层已闭环，但仍依赖页面 DOM，草稿清理仍需人工处理，也还没有 CI 级无人值守验收。

下一步只做一件事：
如果继续做执行层，就只做 CI 级验收与清理自动化；否则就开始接内容层，但不要把两个方向混在一起。

不要扩到选题、出图、增长分析。
先把执行层做成自包含、可测试、可维护的能力。
```

## 本次涉及的 OpenClaw 文件

- `package.json`
- `scripts/xhs-post.ts`
- `scripts/xhs-smoke.ts`
- `notes/xhs-bridge-handoff-2026-03-06.md`
- `src/xhs/audit.ts`
- `src/xhs/bridge.ts`
- `src/xhs/cli.ts`
- `src/xhs/images.ts`
- `src/xhs/smoke.ts`
