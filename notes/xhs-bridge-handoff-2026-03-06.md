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

当前结构是“OpenClaw 统一入口 + 本机本地执行层”：

1. `openclaw/scripts/xhs-post.ts`
   - 负责统一命令入口
   - 负责桥接参数
   - 负责 `draft/save-draft` 的额外逻辑
   - 负责复用专用 Chrome profile

2. 本机本地依赖：`../xiaohongshu-mcp`
   - 当前实际执行 fill-only 的能力仍来自这里
   - 当前依赖的核心脚本：
     - `../xiaohongshu-mcp/skills/post-to-xhs/scripts/cdp_publish.py`
     - `../xiaohongshu-mcp/skills/post-to-xhs/scripts/publish_pipeline.py`

3. 专用浏览器
   - Chrome profile：`~/.codex/chrome-mcp-profile`
   - CDP 端口：`9222`

## 当前命令

```bash
corepack pnpm xhs -- check-login

corepack pnpm xhs -- draft \
  --title "标题" \
  --content "正文" \
  --image /绝对路径/图片.png

corepack pnpm xhs -- save-draft --title "当前编辑页标题"

corepack pnpm xhs -- click-publish
```

## 已知缺口

### 1. 仍依赖本机本地 sibling 仓库

当前桥接还依赖：

- `../xiaohongshu-mcp`

而且这个 sibling 仓库当前有本地补丁，尚未内收到 OpenClaw：

- `../xiaohongshu-mcp/skills/post-to-xhs/scripts/cdp_publish.py`
- `../xiaohongshu-mcp/skills/post-to-xhs/scripts/publish_pipeline.py`

这意味着：

- 当前能力可用
- 但还不是自包含
- 换目录、换机器、换人接手时不稳

### 2. 没有正式自动化测试

当前主要靠真实浏览器验证，没有单独的 smoke test。

### 3. 还只是“执行层”

当前没有统一处理：

- 选题
- 改写
- 出图
- 预览审核
- 站内 CTA
- 发布后回流

### 4. `save-draft` 依赖页面 DOM

当前草稿保存依赖：

- “暂存离开”按钮
- “草稿箱”
- “保存成功”

这套逻辑可用，但页面结构一变就可能失效。

## 下一步优先级

### P0：内收执行层

把当前依赖的 `xiaohongshu-mcp` 执行脚本正式内收到 OpenClaw，去掉对 `../xiaohongshu-mcp` 的运行时依赖。

目标：

- OpenClaw 仓库自包含
- 不再依赖本机 sibling repo
- 能在新机器上复现

### P1：补 smoke test

至少补这几个最小验证：

- `check-login` 不新开多余页面
- `draft` 能把标题、正文、图片填进去
- `draft` 能落到草稿箱
- `save-draft` 在没有编辑页时能明确失败

### P2：补审核输出

草稿生成后自动输出：

- 标题
- 正文
- 图片路径
- 草稿状态
- 当前预览截图

### P3：再接内容层

内容层后面再做，不要现在就混进发布执行层：

- X / GitHub / Agent-Reach 选题
- 小红书改写
- Nano Banana / Gemini 出图

## 当前判断

现在这个能力可以视为一个“执行型 skill”，但还不是完整内容 skill。

它已经能稳定做：

- 登录检查
- 图文填充
- 草稿保存
- 标签页复用

但它还不具备：

- 自包含
- 可测试
- 内容层闭环

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
2. check-login / fill / draft / save-draft / click-publish 已可用
3. pnpm xhs -- check-login 和 pnpm xhs check-login 都已兼容
4. draft 已验证能落到小红书草稿箱
5. 已修复频繁新开小红书页面的问题，现在默认复用同一个 creator 标签页

当前最大问题：
这套能力还依赖本机本地的 ../xiaohongshu-mcp，而且该 sibling 仓库里有本地补丁，尚未内收到 openclaw。

下一步只做一件事：
把当前小红书发布执行层内收到 openclaw，去掉对 ../xiaohongshu-mcp 的运行时依赖。

不要扩到选题、出图、增长分析。
先把执行层做成自包含、可测试、可维护的能力。
```

## 本次涉及的 OpenClaw 文件

- `package.json`
- `scripts/xhs-post.ts`
- `notes/xhs-bridge-handoff-2026-03-06.md`
