# OS 沙箱与多工作区验收（2026-10-04）

本次实现四项指定修改：移除 Docker 验证机制，使用官方 OS 沙箱；移除左侧额外设置入口；新聊天明确选择工作区并锁定已有会话的目录；移除个人中心“已连接”文字。个人中心原有设置保留。

Windows 便携版采用官方 `@anthropic-ai/sandbox-runtime@0.0.78`（Windows alpha）。固定验证命令进入独立账户、受限 token 和 Job 进程树，WFP 约束网络；文件工具继续使用原有工作区路径保护。首次官方安装已实跑成功，其他机器首次执行可能需要 Windows 系统授权。项目依赖需预先准备。

普通验证直接使用项目工作区；只有失败比较和独立验收建立安全快照。无法启动沙箱时不回退为普通进程执行，记录无法验证。

## 最新验证结果

| 检查 | 结果 |
| --- | --- |
| 项目 lint、类型检查、架构检查 | 通过 |
| Desktop | 28 个文件、188 tests 通过 |
| Gateway | 32 passed、2 skipped；诊断包另有 2 passed |
| Python 全量（启用真实 OS 独立验收） | 622 passed、4 skipped |
| Python Ruff | 全量通过 |
| Python mypy | 迁移相关 34 个源码文件通过 |
| Python 源码结构 | 相关 34 个文件不超过 300 行，函数不超过 40 行 |
| 真实 SDK 安全回归 | 8 passed：工作区写入、外部写入拒绝、敏感文件拒绝、禁网、参数、大输出、真实子进程超时及取消 |
| 最终包自带 Python | pytest、敏感文件读写拒绝、外部写入拒绝、本地 TCP 阻断通过 |
| 最终 exe 串联 | 通过，两个真实后台会话分别绑定 A/B 工作区 |

Python 4 项跳过涉及未配置的真实 PostgreSQL、真实模型联合数据库，以及已安装 build/mypy 时不适用的缺工具实测路径；对应负向模拟已有覆盖。Gateway 的跳过项为未启用外部环境用例。UI 使用本地模型 fixture，不宣称真实在线模型端到端通过；安全测试使用真实 SDK，不依赖 Docker 或模型。

## 产物与证据

- 程序：`release/BitAgent-2026-10-04T14-16-13-657Z/Bit Agent.exe`。
- UI 结果：`tmp/packaged-acceptance-XCDw5o/result.json`。
- 包内 Python 安全结果：`tmp/packaged-os-sl_95z58/result.json`。
- 最终 Python JUnit：`tmp/sdk-suite-final-results.xml`。
- JS/lint/typecheck：`tmp/sdk-js-tests-final.log`、`tmp/sdk-lint-final.log`、`tmp/sdk-typecheck-final.log`。
- 隐藏窗口截图检查主题像素及唯一帧标记，避免捕获上一帧。标记只存在于验收进程。

## 已确认边界

- 官方 Windows 实现仍为 alpha。D 盘带空格 Node 项目 npm.cmd 实跑成功；用户私有 AppData/Temp 下的 Node 项目仍可能因祖先目录 metadata 权限返回 EPERM，没有通过扩大用户目录权限绕过。
- SDK 重叠 denyRead/denyWrite 会降级同一路径 mask。保留所有规则，初始化后再通过官方 stampWindowsAcl 重申完整拒绝，成功后才允许启动任务。四种假凭据的读取和写入均已实测拒绝。
- 曾捕获 HEAD 已有的恢复排序偶发失败：回答与目标替换时间相同，storage.py 仅按时间排序，可能逆转顺序。storage.py、interaction.py、test_runtime_recovery.py 均与 HEAD 一致，固定同时间可以复现。本次未擅自修改；最新全量通过不等于这个旧问题已修复。
- 没有提交或远端推送；验收的 Git 提交仅发生在临时 fixture 仓库。

## 当前相关变更文件的行数

下表包含本次涉及的当前未提交源码、配置和测试，以及前面已完成的 UI 改动；按文件总行数记录。测试、锁文件和生成内容不适用源文件大小限制，生成图标资产未计入。

| 文件 | 当前行数 |
| --- | ---: |
| `README.md` | 167 |
| `apps/desktop/renderer/index.html` | 262 |
| `apps/desktop/renderer/partials/inspector.html` | 61 |
| `apps/desktop/renderer/partials/profile.html` | 26 |
| `apps/desktop/src/main/application/ports.ts` | 48 |
| `apps/desktop/src/main/infrastructure/runtime/docker-status.ts` | 已删除 |
| `apps/desktop/src/main/infrastructure/runtime/gateway-environment.ts` | 31 |
| `apps/desktop/src/main/infrastructure/runtime/managed-runtime.ts` | 250 |
| `apps/desktop/src/main/infrastructure/runtime/sandbox-executor.ts` | 70 |
| `apps/desktop/src/main/infrastructure/runtime/sandbox-manifest.ts` | 34 |
| `apps/desktop/src/main/main.ts` | 22 |
| `apps/desktop/src/main/transport/desktop-lifecycle.ts` | 39 |
| `apps/desktop/src/main/transport/desktop-theme.ts` | 24 |
| `apps/desktop/src/main/transport/desktop-window.ts` | 60 |
| `apps/desktop/src/main/transport/diagnostics-ipc.ts` | 37 |
| `apps/desktop/src/main/transport/electron.ts` | 69 |
| `apps/desktop/src/main/transport/git-ipc.ts` | 45 |
| `apps/desktop/src/main/transport/ipc-handler.ts` | 20 |
| `apps/desktop/src/main/transport/memory-ipc.ts` | 18 |
| `apps/desktop/src/main/transport/preload.cts` | 56 |
| `apps/desktop/src/main/transport/repository-ipc.ts` | 53 |
| `apps/desktop/src/main/transport/session-ipc.ts` | 28 |
| `apps/desktop/src/main/transport/settings-ipc.ts` | 19 |
| `apps/desktop/src/main/transport/task-ipc.ts` | 54 |
| `apps/desktop/src/main/transport/task-notifications.ts` | 25 |
| `apps/desktop/src/main/transport/task-request.ts` | 9 |
| `apps/desktop/src/main/transport/task-watches.ts` | 58 |
| `apps/desktop/src/renderer/application/composer.ts` | 127 |
| `apps/desktop/src/renderer/application/connection.ts` | 31 |
| `apps/desktop/src/renderer/application/context.ts` | 154 |
| `apps/desktop/src/renderer/application/events.ts` | 102 |
| `apps/desktop/src/renderer/application/history.ts` | 200 |
| `apps/desktop/src/renderer/application/processes.ts` | 90 |
| `apps/desktop/src/renderer/application/queue.ts` | 54 |
| `apps/desktop/src/renderer/application/result.ts` | 160 |
| `apps/desktop/src/renderer/application/run.ts` | 240 |
| `apps/desktop/src/renderer/application/shell.ts` | 76 |
| `apps/desktop/src/renderer/application/state.ts` | 150 |
| `apps/desktop/src/renderer/application/stop.ts` | 30 |
| `apps/desktop/src/renderer/code-view.css` | 207 |
| `apps/desktop/src/renderer/composer.css` | 208 |
| `apps/desktop/src/renderer/execution-settings.css` | 26 |
| `apps/desktop/src/renderer/execution-settings.ts` | 18 |
| `apps/desktop/src/renderer/file-icons.ts` | 90 |
| `apps/desktop/src/renderer/interaction-view.ts` | 6 |
| `apps/desktop/src/renderer/interaction/controller.ts` | 205 |
| `apps/desktop/src/renderer/interaction/panel.ts` | 57 |
| `apps/desktop/src/renderer/interaction/question.ts` | 130 |
| `apps/desktop/src/renderer/main.ts` | 185 |
| `apps/desktop/src/renderer/product-controls.css` | 187 |
| `apps/desktop/src/renderer/product-controls.ts` | 19 |
| `apps/desktop/src/renderer/product/change-entry.ts` | 72 |
| `apps/desktop/src/renderer/product/diagnostics.ts` | 59 |
| `apps/desktop/src/renderer/product/dialog.ts` | 67 |
| `apps/desktop/src/renderer/product/execution-controller.ts` | 87 |
| `apps/desktop/src/renderer/product/execution-dialog.ts` | 34 |
| `apps/desktop/src/renderer/product/memory.ts` | 75 |
| `apps/desktop/src/renderer/product/model-form-html.ts` | 34 |
| `apps/desktop/src/renderer/product/model-form.ts` | 14 |
| `apps/desktop/src/renderer/product/model-list.ts` | 38 |
| `apps/desktop/src/renderer/product/model-test.ts` | 49 |
| `apps/desktop/src/renderer/product/model.ts` | 40 |
| `apps/desktop/src/renderer/product/permission.ts` | 29 |
| `apps/desktop/src/renderer/product/review.ts` | 77 |
| `apps/desktop/src/renderer/product/settings-entries.ts` | 41 |
| `apps/desktop/src/renderer/profile-menu.ts` | 53 |
| `apps/desktop/src/renderer/repository-view.ts` | 23 |
| `apps/desktop/src/renderer/repository/breadcrumbs.ts` | 22 |
| `apps/desktop/src/renderer/repository/icons.css` | 15 |
| `apps/desktop/src/renderer/repository/preview.ts` | 121 |
| `apps/desktop/src/renderer/repository/syntax.css` | 61 |
| `apps/desktop/src/renderer/repository/tabs.ts` | 110 |
| `apps/desktop/src/renderer/repository/tree.css` | 35 |
| `apps/desktop/src/renderer/repository/tree.ts` | 180 |
| `apps/desktop/src/renderer/repository/types.ts` | 10 |
| `apps/desktop/src/renderer/sidebar.css` | 204 |
| `apps/desktop/src/renderer/stream-view.ts` | 240 |
| `apps/desktop/src/renderer/stream/run-status.ts` | 80 |
| `apps/desktop/src/renderer/stream/status-line.ts` | 43 |
| `apps/desktop/src/renderer/stream/status.css` | 1 |
| `apps/desktop/src/renderer/stream/tool-diff.ts` | 43 |
| `apps/desktop/src/renderer/stream/tool-row.ts` | 137 |
| `apps/desktop/src/renderer/styles.css` | 13 |
| `apps/desktop/src/renderer/styles/base.css` | 110 |
| `apps/desktop/src/renderer/styles/composer-layout.css` | 146 |
| `apps/desktop/src/renderer/styles/connection.css` | 50 |
| `apps/desktop/src/renderer/styles/conversation.css` | 193 |
| `apps/desktop/src/renderer/styles/history.css` | 257 |
| `apps/desktop/src/renderer/styles/inspector.css` | 212 |
| `apps/desktop/src/renderer/styles/markdown.css` | 110 |
| `apps/desktop/src/renderer/styles/navigation.css` | 116 |
| `apps/desktop/src/renderer/styles/profile.css` | 139 |
| `apps/desktop/src/renderer/styles/repository-preview.css` | 58 |
| `apps/desktop/src/renderer/styles/repository-tree.css` | 136 |
| `apps/desktop/src/renderer/styles/responsive.css` | 106 |
| `apps/desktop/src/renderer/styles/theme.css` | 125 |
| `apps/desktop/src/renderer/styles/titlebar.css` | 29 |
| `apps/desktop/src/renderer/workspace-chooser.css` | 25 |
| `apps/desktop/src/renderer/workspace-chooser.ts` | 74 |
| `apps/desktop/src/renderer/workspace-options.ts` | 36 |
| `apps/desktop/src/renderer/workspace-tree.ts` | 150 |
| `apps/desktop/src/shared/contracts.ts` | 179 |
| `apps/desktop/test/composer-controller.test.ts` | 105 |
| `apps/desktop/test/execution-settings-controller.test.ts` | 112 |
| `apps/desktop/test/file-icons.test.ts` | 50 |
| `apps/desktop/test/interaction-view.test.ts` | 133 |
| `apps/desktop/test/internal-gateway-routing.test.ts` | 183 |
| `apps/desktop/test/managed-runtime.test.ts` | 89 |
| `apps/desktop/test/product-controls.test.ts` | 87 |
| `apps/desktop/test/profile-menu.test.ts` | 67 |
| `apps/desktop/test/run-status.test.ts` | 62 |
| `apps/desktop/test/runtime-connection.test.ts` | 60 |
| `apps/desktop/test/sandbox-executor.test.ts` | 125 |
| `apps/desktop/test/sandbox-runner-child.test.ts` | 56 |
| `apps/desktop/test/sandbox-runner-status.test.ts` | 42 |
| `apps/desktop/test/sandbox-runner.test.ts` | 196 |
| `apps/desktop/test/stop-controller.test.ts` | 141 |
| `apps/desktop/test/workspace-options.test.ts` | 33 |
| `docs/CLI_DESKTOP.md` | 188 |
| `docs/ENVIRONMENT.md` | 11 |
| `docs/LOCAL_RUNTIME.md` | 76 |
| `package.json` | 29 |
| `pnpm-lock.yaml` | 2702 |
| `pnpm-workspace.yaml` | 17 |
| `pyproject.toml` | 90 |
| `scripts/accept-packaged.mjs` | 601 |
| `scripts/desktop-dev.mjs` | 53 |
| `scripts/desktop-package/generate-icon.py` | 32 |
| `scripts/desktop-package/sandbox.mjs` | 47 |
| `scripts/desktop-package/windows-branding.mjs` | 47 |
| `scripts/desktop-package/windows-branding.test.mjs` | 41 |
| `scripts/desktop-package/windows-shell-icon.ps1` | 34 |
| `scripts/package-desktop.mjs` | 103 |
| `scripts/sandbox-runner.ts` | 31 |
| `scripts/sandbox-runner/bootstrap.ts` | 11 |
| `scripts/sandbox-runner/child.ts` | 24 |
| `scripts/sandbox-runner/cleanup.ts` | 22 |
| `scripts/sandbox-runner/command.ts` | 43 |
| `scripts/sandbox-runner/lifecycle.ts` | 57 |
| `scripts/sandbox-runner/policy.ts` | 26 |
| `scripts/sandbox-runner/read-protection.ts` | 9 |
| `scripts/sandbox-runner/request.ts` | 48 |
| `scripts/sandbox-runner/status.ts` | 27 |
| `services/agent/src/bit_agent/evals/artifacts.py` | 25 |
| `services/agent/src/bit_agent/evals/evidence.py` | 49 |
| `services/agent/src/bit_agent/evals/runner.py` | 184 |
| `services/agent/src/bit_agent/evals/scoring.py` | 103 |
| `services/agent/src/bit_agent/evals/workspace.py` | 112 |
| `services/agent/src/bit_agent/llm/tool_schemas.py` | 195 |
| `services/agent/src/bit_agent/mcp_server/server.py` | 84 |
| `services/agent/src/bit_agent/mcp_server/tool_registration.py` | 106 |
| `services/agent/src/bit_agent/multi_agent/aggregator.py` | 122 |
| `services/agent/src/bit_agent/runtime/__main__.py` | 95 |
| `services/agent/src/bit_agent/runtime/infrastructure/acceptance.py` | 146 |
| `services/agent/src/bit_agent/runtime/infrastructure/acceptance_commands.py` | 44 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification.py` | 51 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/__init__.py` | 1 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/baseline.py` | 68 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/commands.py` | 63 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/comparison.py` | 93 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/config.py` | 87 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/execution.py` | 125 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/node_manifest.py` | 38 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/planning.py` | 128 |
| `services/agent/src/bit_agent/runtime/infrastructure/verification_support/report.py` | 62 |
| `services/agent/src/bit_agent/sandbox/__init__.py` | 6 |
| `services/agent/src/bit_agent/sandbox/base.py` | 31 |
| `services/agent/src/bit_agent/sandbox/configuration.py` | 66 |
| `services/agent/src/bit_agent/sandbox/docker.py` | 已删除 |
| `services/agent/src/bit_agent/sandbox/environment.py` | 已删除 |
| `services/agent/src/bit_agent/sandbox/images/python/run_python_build.py` | 已删除 |
| `services/agent/src/bit_agent/sandbox/native.py` | 105 |
| `services/agent/src/bit_agent/sandbox/node_environment.py` | 已删除 |
| `services/agent/src/bit_agent/sandbox/output.py` | 47 |
| `services/agent/src/bit_agent/sandbox/process.py` | 84 |
| `services/agent/src/bit_agent/tools/command_runtime.py` | 41 |
| `services/agent/src/bit_agent/tools/run_checks.py` | 243 |
| `services/agent/src/bit_agent/tools/run_tests.py` | 191 |
| `services/agent/tests/test_agent_runtime.py` | 809 |
| `services/agent/tests/test_docker_sandbox.py` | 已删除 |
| `services/agent/tests/test_environment.py` | 已删除 |
| `services/agent/tests/test_eval_runner.py` | 212 |
| `services/agent/tests/test_independent_acceptance.py` | 660 |
| `services/agent/tests/test_mcp_integration.py` | 261 |
| `services/agent/tests/test_os_sandbox.py` | 245 |
| `services/agent/tests/test_os_sandbox_integration.py` | 231 |
| `services/agent/tests/test_verification_baseline.py` | 678 |
| `services/agent/tests/test_verification_copy.py` | 49 |
| `services/agent/tests/tools/test_day3_workflow.py` | 57 |
| `services/agent/tests/tools/test_run_checks.py` | 319 |
| `services/agent/tests/tools/test_run_tests.py` | 277 |
| `uv.lock` | 1571 |
