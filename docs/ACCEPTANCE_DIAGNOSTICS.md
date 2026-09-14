# 日志与诊断验收记录

日期：2026-09-11。使用方法及接口边界见 [DESKTOP_DIAGNOSTICS.md](./DESKTOP_DIAGNOSTICS.md)。

## 自动化检查

- Python：282 passed，12 skipped。跳过项需要真实模型、Docker 或 Redis/PostgreSQL 等外部环境。
- JavaScript：诊断包 2 项、桌面 34 项、Gateway 21 项通过；Gateway 2 项可选环境测试跳过。
- `pnpm -r typecheck` 通过；本次修改的 Python 文件 Ruff 检查通过。
- 已验证：模拟 HTTP 错误与重试、流式异常和缺少完成事件、超时与主动取消、真实 Python 子进程异常退出、SQLite 只读失败、文件保存 ENOSPC、日志轮转与过期清理、脱敏、日志不可写时保留原始错误、离线 ZIP 导出。

## 最终桌面包

- 程序：`release/BitAgent-2026-09-11T06-24-49-930Z/Bit Agent.exe`。
- 验收命令：`node scripts/accept-diagnostics.mjs "release/BitAgent-2026-09-11T06-24-49-930Z/Bit Agent.exe"`。
- 隔离数据与证据：`tmp/diagnostics-desktop-VOulSN/`。
- 结果：`acceptance.json`，截图：`diagnostics.png`，脱敏包：`diagnostics.zip`。

验收启动了真实打包 Electron、Gateway、Python 和 SQLite，以本机模型夹具触发 HTTP 401、流式中断、等待模型和主动取消。空会话中的「日志与诊断」界面、界面触发导出、ZIP 脱敏均通过，最终截图已人工查看。验收结果中的八个布尔检查项全部为 true。

## 尚未验证

模型接口为本机模拟服务，未调用真实服务商。导出使用真实 IPC 和 ZIP 逻辑，但原生保存窗口的选择结果由测试替身提供。未进行真实断网、系统断电或 OS/native 崩溃实验。不能将这些项目视为已经通过的桌面验收。

日志和分层改动保留现有业务事件、审批、暂停、取消、上下文保存与恢复职责；工作区原有修改未回滚。
