# 首屏、菜单和 Windows 图标验收 2026-10-04

本轮对应用户的五点反馈及补充任务栏截图。真正需要补齐的是 Windows EXE / 任务栏应用图标；上一轮完成的软件内文件树图标仍保留。

## 修改结果

1. 首次进入的发送按钮带灰色箭头；空输入禁用发送，空 Enter 不执行。HTML 默认图标、启动时绘制、状态未变化但 SVG 缺失时重绘三处共同避免空白按钮。运行时仍可停止，有文字时仍可引导 / 排队。
2. 移除个人中心重复的主题切换菜单项、调用参数与观察器，保留左侧主题按钮。
3. Windows EXE 写入十种尺寸的橙色圆角底白色 B 图标、产品名称和版本。窗口用 NativeImage 加载品牌 PNG，任务栏通过 setAppDetails 设置图标、应用名及重新启动命令。打包时将 electron.exe 重命名为 Bit Agent.exe，不留下重复默认入口。
4. 为符合已有 AGENTS.md 的文件 / 函数限制，主 HTML 拆为页面、个人中心与检查器片段，使用已引入的 Vite transformIndexHtml 组装；Electron 超长入口拆为窗口、生命周期、主题、各类 IPC 与事件订阅职责。
5. 新增固定开发依赖 resedit 3.1.0，仅用于打包，不进入产品运行链路。它是 [Electron 官方 Packager 当前采用的资源编辑路线](https://github.com/electron/packager/blob/main/src/resedit.ts)。图标沿用现有品牌，用已有 Pillow 环境生成 PNG / ICO；运行包无需 Pillow。

## Gateway 与隔离检测结论

Gateway 地址是应用自动启动的本地任务服务。`scripts/gateway-entry.ts` 用 `127.0.0.1` 和随机空闲端口监听；桌面经它提交任务、接收事件、读取会话，再由 Python Agent 调用“模型设置”保存的服务地址。模型 Base URL 与本地任务 Gateway 是不同用途的地址；监听本机是当前便携架构的正常行为。

Codex / Claude Code 本地沙箱采用操作系统机制，没有内置 Docker 引擎。Codex 原生 Windows 使用 Windows 权限和网络限制；Claude Code 的 shell 沙箱支持 macOS / Linux / WSL2，原生 Windows 需通过 WSL2 使用该沙箱。

- [OpenAI 官方沙箱说明](https://learn.chatgpt.com/docs/sandboxing)
- [OpenAI Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Claude Code 官方沙箱说明](https://code.claude.com/docs/en/sandboxing)
- [Claude Code 可选 Docker 开发容器](https://code.claude.com/docs/en/devcontainer)

项目用 Docker 跑测试与质量检查的方向合理：安全快照只读挂载、禁网、非 root、只读容器文件系统、丢弃 capabilities，并限制资源。它隔离的是验证执行，不能当作整个 Agent 都在容器里。现有 dockerStatus 只检查 CLI 和服务能否连接，不能证明镜像 / 依赖 / 项目测试可用；真正验证时按执行结果判定，无 Docker 时标记 UNVERIFIED。检测只在启动 / 重新获得焦点时提示，15 秒节流，可关闭，不拦截普通聊天。本轮未修改这些后端规则，也未安装 Docker。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过，包括 123 模块 / 309 依赖的 JavaScript 架构检查及 Python 4 项架构约束 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | Desktop 125 通过；Gateway 32 通过 / 2 跳过；Diagnostics 2 通过 |
| Windows 资源回读测试 | 3 通过；对真实 Electron EXE 在内存中写入后逐一比对十种尺寸、产品与版本数据，原始依赖二进制未改 |
| 图标生成脚本 Ruff | 通过（使用 --no-cache） |
| 开发 / 生产 HTML | 通过；Vite 片段均展开、必要 DOM 唯一、主题切换入口唯一 |
| `pnpm desktop:package` | 通过；新目录独立生成，不覆盖旧发布包 |
| 实际便携包验收 | 通过；本地模型夹具、独立资料与工作区、剥离系统运行依赖 PATH |
| 首屏 / 个人中心 / 停止截图 | 深浅主题、1280 / 920 宽度，共 12 个布局检查通过 |
| Windows Shell 图标 | SHGetFileInfoW 对真实 EXE 读取成功，32×32；621 个橙色像素、75 个白色像素，已人工查看为橙底白 B |
| `git diff --check` | 通过 |

实际包还验证了重启续聊、模型 / 思考程度保存、流式输出、立即停止、引导与排队、停止后不自动发队列、审批后写文件、结束等待、审阅 / 撤销、随包 Git、MCP、记忆、会话搜索 / 重命名 / 删除、历史回放与软件内文件树 / 编辑器图标。

系统图标验收采用 Windows Shell 的 SHGetFileInfoW(SHGFI_ICON)，不带 SHGFI_USEFILEATTRIBUTES，读取真实文件。Electron getFileIcon 在本机返回通用图标；Chromium 官方实现存在 sandbox icon reader 失败后回退通用图标的路径，具体失败分支本轮未判定。产品没有使用该读取接口，窗口与任务栏图标均明确设置；原生 Shell 接口和 ExtractAssociatedIcon 两次独立读取已确认品牌图标，无需修改系统图标缓存。

- [Microsoft SHGetFileInfoW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow)
- [Chromium 图标读取及回退](https://github.com/chromium/chromium/blob/main/chrome/browser/icon_loader_win.cc)

本轮未改 Python 后端，未重跑其全量测试。上一轮已记录的恢复顺序失败仍待单独处理：`test_recovered_answers_keep_order_with_later_goal_replacement`，当时全量为 560 通过 / 4 跳过 / 1 失败。本轮也未用真实在线模型或 Docker 容器执行项目验证。

## 新包与证据

- 新包：`release/BitAgent-2026-10-04T11-50-33-926Z/Bit Agent.exe`。使用完整目录；关闭旧包后启动本包。旧任务栏固定项如指向旧 EXE，需要重新固定新 EXE。
- [最终验收 result.json](../../tmp/packaged-acceptance-3wAJEG/result.json)
- [Windows 实际读取的图标](../../tmp/packaged-acceptance-3wAJEG/windows-executable-icon.png)
- [首次进入截图](../../tmp/packaged-acceptance-3wAJEG/startup-dark-1280.png)
- [个人中心截图](../../tmp/packaged-acceptance-3wAJEG/profile-menu-dark-1280.png)
- [停止截图](../../tmp/packaged-acceptance-3wAJEG/stopped-dark-1280.png)

源码和文档尚未提交、未推送。原有 RELEASE_NOTES_1.0.md 与上一轮验收记录保留。

## 本轮文件行数

以下是本轮修改 / 新增文件的最终物理行数；测试与生成锁文件不受源文件 300 行上限约束。PNG 为 512×512 RGBA；ICO 含 16、20、24、32、40、48、64、96、128、256 共十种尺寸。

| 文件（相对仓库根目录） | 行数 |
| --- | ---: |
| `apps/desktop/renderer/index.html` | 262 |
| `apps/desktop/renderer/partials/profile.html` | 49 |
| `apps/desktop/renderer/partials/inspector.html` | 61 |
| `apps/desktop/vite.config.ts` | 20 |
| `apps/desktop/src/renderer/application/composer.ts` | 126 |
| `apps/desktop/src/renderer/profile-menu.ts` | 67 |
| `apps/desktop/src/renderer/main.ts` | 203 |
| `apps/desktop/src/renderer/composer.css` | 208 |
| `scripts/package-desktop.mjs` | 100 |
| `scripts/desktop-package/windows-branding.mjs` | 47 |
| `scripts/desktop-package/windows-branding.test.mjs` | 41 |
| `scripts/desktop-package/windows-shell-icon.ps1` | 34 |
| `scripts/desktop-package/generate-icon.py` | 32 |
| `scripts/accept-packaged.mjs` | 551 |
| `apps/desktop/test/composer-controller.test.ts` | 105 |
| `apps/desktop/test/profile-menu.test.ts` | 68 |
| `package.json` | 28 |
| `pnpm-lock.yaml` | 2662 |
| `apps/desktop/src/main/transport/desktop-lifecycle.ts` | 39 |
| `apps/desktop/src/main/transport/desktop-theme.ts` | 24 |
| `apps/desktop/src/main/transport/desktop-window.ts` | 60 |
| `apps/desktop/src/main/transport/diagnostics-ipc.ts` | 37 |
| `apps/desktop/src/main/transport/git-ipc.ts` | 45 |
| `apps/desktop/src/main/transport/ipc-handler.ts` | 20 |
| `apps/desktop/src/main/transport/memory-ipc.ts` | 18 |
| `apps/desktop/src/main/transport/repository-ipc.ts` | 53 |
| `apps/desktop/src/main/transport/session-ipc.ts` | 28 |
| `apps/desktop/src/main/transport/settings-ipc.ts` | 20 |
| `apps/desktop/src/main/transport/task-ipc.ts` | 54 |
| `apps/desktop/src/main/transport/task-notifications.ts` | 25 |
| `apps/desktop/src/main/transport/task-request.ts` | 9 |
| `apps/desktop/src/main/transport/task-watches.ts` | 58 |
| `apps/desktop/src/main/transport/electron.ts` | 69 |
