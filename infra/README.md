# infra：给项目准备配套环境

日常开发不需要启动这里的任何服务：桌面链路是本地 Python + SQLite，启动方式见 [本地运行](../docs/LOCAL_RUNTIME.md)。
早期的 Redis 开发与联调配置已随旧链路删除（git 标签 `legacy-redis`）。

这里放记忆后端测试服务的配置和辅助脚本。你可以把它理解成“准备工作场地”的部分，Agent 的业务逻辑在 `services/agent`。

## 每个目录做什么

| 目录 | 用途 |
| --- | --- |
| `docker` | Windows 下 Docker Desktop 的辅助启动和残留文件处理脚本，供记忆集成测试使用。 |
| `memory` | 记忆模块真实 PostgreSQL/pgvector 测试环境。 |

## 记忆集成测试

`memory/compose.yaml` 只启动测试用 PostgreSQL/pgvector，绑定本机端口 `55432`，不会启动 Gateway、Electron 或 Ollama。

`memory/run-integration-tests.ps1` 启动这套服务并运行相应 Python 集成测试。它会启用真实 LLM 测试条件，因此还需要相关模型配置。
`-StopAfter` 表示结束后关闭测试服务；`-FullSuite` 会改为运行默认 Python 测试集合，不会顺带运行 Node.js 测试。

## 测试沙箱不在这里

测试和检查不再使用 Docker 镜像，改由随包的官方 Windows OS 沙箱执行，见 [Windows OS 沙箱](../docs/ENVIRONMENT.md)。以前的沙箱镜像配方已删除。

## 修改这些文件会影响什么

修改 Compose 会影响服务和端口；修改 PowerShell 脚本会影响启动、测试或清理行为。这里只写说明的 README 不会直接启动任何服务。
