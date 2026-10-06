# 原始调试数据显示移除验收

## 改动范围

- 删除任务详情中的“原始结果”面板，同时删除前端 DOM 绑定和结果写入；原始任务 JSON 不再被填入该页面节点。
- 删除工具展开详情中的“原始事件”及内部工具方法名；保留可读的状态、结果、用时、对象和错误提示。
- 清除这些展示专用的死样式。后端结果处理、持久化、事件传递与日志机制沿用原有行为；未新增调试开关或菜单。
- 按项目函数行数限制拆分原有结果渲染函数，调用顺序、停止与错误分支保持一致。

## 验证

- `pnpm lint`、`pnpm typecheck` 通过，JS/Python 架构约束通过。
- `pnpm test`：桌面 301 通过；网关 37 通过、2 跳过；诊断 2 通过。
- 正式 EXE 验收通过：启动、对话、审批、Markdown、仓库、工作区选择共 24 个明暗主题及窗口宽度布局。
- 展开工具后仍显示可读详情；原始结果、原始事件及其 JSON 容器均不存在。历史回放、真实刷新、工作区排序与侧栏宽度保存通过。
- 验收使用本地模拟模型和独立临时数据；不是在线模型任务效果验收。

发布程序：`release/BitAgent-2026-10-05T07-05-36-329Z/Bit Agent.exe`，运行时保留完整发布目录。

证据：`tmp/packaged-acceptance-4KyIxu/result.json`，其中 `passed` 和 `rawDebugDataAbsentFromUi` 均为 `true`；同目录有页面截图。

本轮未提交、未推送；仓库原有未提交改动保留。移除调试数据展示属于界面清理，不是源码加密或新的安全边界。

## 改动文件行数

| 文件（相对仓库根目录） | 行数 |
| --- | ---: |
| `apps/desktop/renderer/partials/inspector.html` | 54 |
| `apps/desktop/src/renderer/application/context.ts` | 153 |
| `apps/desktop/src/renderer/application/state.ts` | 149 |
| `apps/desktop/src/renderer/application/result.ts` | 171 |
| `apps/desktop/src/renderer/stream/tool-row.ts` | 186 |
| `apps/desktop/src/renderer/stream/group.css` | 168 |
| `apps/desktop/src/renderer/styles/inspector.css` | 187 |
| `apps/desktop/src/renderer/styles/conversation.css` | 178 |
| `scripts/accept-packaged.mjs`（测试脚本） | 665 |

本轮生产源文件均不超过 300 行；函数最长 33 行，控制流程嵌套不超过 3 层。
