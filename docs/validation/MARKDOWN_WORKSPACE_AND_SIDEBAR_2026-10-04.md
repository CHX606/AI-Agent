# Markdown 输出、工作区排序与左侧调宽验收

日期：2026-10-04（America/Los_Angeles）；发布目录名称使用 UTC 时间。

## 交付行为

- 消息使用同一个 CommonMark/GFM 渲染入口，支持表格、六级标题、粗体/斜体/删除线、嵌套与任务列表、引用、分隔线、链接、图片、行内及围栏代码。流式内容、未结束的代码围栏和历史回放共用实现。
- 宽表格在自身区域横向滚动，图片限制在消息宽度内，代码着色复用现有实现及主题。复用已在依赖树中的 `marked@11.2.0`，直接声明依赖；新增 `dompurify@3.4.16` 在插入前清洗 HTML。
- 外链交给系统浏览器；图片允许 HTTP/HTTPS；页面继续限制脚本、样式与连接。允许当前桌面页面刷新，其他文件及远程页面不能载入具有桌面权限的主窗口。
- 拖动左侧工作区标题调整排列，保存手动顺序。工作区排序与组内对话排序使用独立拖放类型和存储键；目录选择列表保持原有逻辑。
- 拖动左侧与主区之间的边界调宽，聊天与代码仓库共用宽度，刷新后保留。窗口收窄时限制实际宽度，保留用户偏好；右侧面板展开时保持主内容区空间。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过，JS 依赖约束及 4 项 Python 架构约束通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 桌面 301 通过；网关 37 通过、2 跳过；诊断 2 通过 |
| 独立 Markdown Electron 验收 | 明暗主题 × 两种宽度共 4 个布局；流式/历史 DOM 相同；净化、表格对齐、任务状态、代码高亮、宽表格横滚通过 |
| 独立侧栏 Electron 验收 | 原生拖动、取消、失去捕获、键盘、宽度保存与两页面共享通过；1051/1100/1280 窗口保持主区 ≥480px；扩大窗口恢复右栏偏好 |
| 真实 Electron 页面刷新 | 页面启动与 `did-finish-load` 均由 1 次变成 2 次，确认刷新重建页面 |
| 最终发布 EXE | 通过；启动/对话/审批/Markdown/代码仓库/目录选择 × 明暗主题 × 两种窗口宽度共 24 个布局；HTTP 图片真实载入，历史回放格式相同；原生鼠标调整侧栏宽度、跨页面共享、真实刷新持久化与工作区标题排序均通过 |

最终发布程序：`release/BitAgent-2026-10-05T06-36-23-903Z/Bit Agent.exe`，使用完整发布目录。

独立证据：`tmp/markdown-renderer-wKr5WY/result.json`、`tmp/sidebar-resize-oQq6cl/result.json`、`tmp/navigation-reload-B6Lgyw/result.json`。

最终 EXE 证据：`tmp/packaged-acceptance-a4xp73/result.json`；同目录含 24 张页面截图。工作区排序使用实际 DOM 拖放事件验证；侧栏使用 CDP 原生鼠标事件验证。刷新使用窗口 token 确认创建了新的 Document。

最终验收同时复查原有会话排序/拖动、工具折叠、停止/引导/排队、工作区选择、审批、差异/撤销、记忆、模型设置、离线图标及仓库标签页等行为；本地模拟模型与测试工作区独立。

验收使用本地模拟模型与独立临时数据，不使用用户真实凭据；验证界面、流式、回放、拖放和持久化行为，不代表真实在线模型的任务效果。本轮没有新增 Git 提交或推送；仓库原有其他未提交改动保留。

## 本轮改动文件行数

统计最终完整文件的物理行数，不是新增行数。测试、验收脚本与生成的依赖锁文件不适用源文件 300 行限制；本轮生产源文件均不超过 300 行，函数不超过 40 行，控制流程嵌套不超过 3 层。

| 文件（相对仓库根目录） | 行数 |
| --- | ---: |
| `apps/desktop/renderer/index.html` | 262 |
| `apps/desktop/src/renderer/markdown.ts` | 9 |
| `apps/desktop/src/renderer/markdown/parser.ts` | 25 |
| `apps/desktop/src/renderer/markdown/content.ts` | 61 |
| `apps/desktop/src/renderer/markdown/code-block.ts` | 47 |
| `apps/desktop/src/renderer/styles/markdown.css` | 211 |
| `apps/desktop/src/shared/external-url.ts` | 14 |
| `apps/desktop/src/main/transport/external-navigation.ts` | 32 |
| `apps/desktop/src/main/transport/desktop-window.ts` | 62 |
| `apps/desktop/src/renderer/workspace-order.ts` | 37 |
| `apps/desktop/src/renderer/workspace-drag.ts` | 67 |
| `apps/desktop/src/renderer/workspace-tree.ts` | 133 |
| `apps/desktop/src/renderer/application/history.ts` | 233 |
| `apps/desktop/src/renderer/sidebar.css` | 212 |
| `apps/desktop/src/renderer/sidebar-width.ts` | 17 |
| `apps/desktop/src/renderer/sidebar-resize.ts` | 103 |
| `apps/desktop/src/renderer/main.ts` | 187 |
| `apps/desktop/src/renderer/styles/navigation.css` | 145 |
| `apps/desktop/src/renderer/styles/responsive.css` | 110 |
| `apps/desktop/src/renderer/styles/base.css` | 111 |
| `apps/desktop/package.json` | 29 |
| `pnpm-lock.yaml` | 2715 |
| `apps/desktop/test/markdown-parser.test.ts` | 64 |
| `apps/desktop/test/external-navigation.test.ts` | 84 |
| `apps/desktop/test/markdown-csp.test.ts` | 24 |
| `apps/desktop/test/markdown-renderer.fixture.ts` | 86 |
| `apps/desktop/test/accept-markdown-renderer.mjs` | 31 |
| `apps/desktop/test/markdown-renderer.acceptance.cjs` | 29 |
| `apps/desktop/test/workspace-order.test.ts` | 63 |
| `apps/desktop/test/workspace-drag.test.ts` | 127 |
| `apps/desktop/test/sidebar-width.test.ts` | 34 |
| `apps/desktop/test/sidebar-resize.fixture.ts` | 11 |
| `apps/desktop/test/accept-sidebar-resize.mjs` | 31 |
| `apps/desktop/test/sidebar-resize.acceptance.cjs` | 109 |
| `apps/desktop/test/workspace-sidebar-packaged.mjs` | 207 |
| `apps/desktop/test/markdown-packaged.mjs` | 45 |
| `scripts/accept-packaged.mjs` | 663 |
| `docs/validation/MARKDOWN_WORKSPACE_AND_SIDEBAR_2026-10-04.md` | 78 |
