# infra：给项目准备配套环境

2026-09-09：默认桌面链路已改成本地 Python + SQLite，不需要下面的开发 Redis。
Redis 配置和集成测试保留供旧模式使用。Docker 测试沙箱仍有独立用途，没有删除。
新启动方式见 [本地运行](../docs/LOCAL_RUNTIME.md)。本轮未执行测试或构建。

这里放服务配置、测试沙箱的 Dockerfile 和辅助脚本。你可以把它理解成“准备工作场地”的部分，Agent 的业务逻辑在 `services/agent`。

## 每个目录做什么

| 目录 | 用途 |
| --- | --- |
| `docker` | Windows 下 Docker Desktop 的辅助启动和残留文件处理脚本。 |
| `runtime` | 正常开发以及 Gateway / Worker 联调使用的 Redis 配置。 |
| `memory` | 记忆模块真实 Redis/PostgreSQL 测试环境。 |
| `sandbox/python` | 给目标 Python 项目运行测试和检查的 Docker 环境。 |

## 开发 Redis 和测试 Redis 分开

| 配置文件 | 启动内容 | 本机端口 |
| --- | --- | --- |
| `runtime/compose.dev.yaml` | 开发用 Redis，使用持久卷保存数据。 | `6379` |
| `runtime/compose.yaml` | Gateway / Worker 协议测试 Redis。 | `6381` |
| `memory/compose.yaml` | 记忆后端测试 Redis 和 PostgreSQL/pgvector。 | `6380`、`55432` |

它们是不同用途的环境。开发 Redis 中的任务不会自动出现在另一套测试 Redis 中。

这些 Compose 文件没有启动 Gateway、Worker、Electron 或 Ollama，需要按各自说明单独运行。

## 日常开发启动什么

启动 Docker Desktop 后，在项目根目录执行：

```powershell
docker compose --file infra/runtime/compose.dev.yaml up --detach --wait
```

再按 [项目首页](../README.md) 启动 Worker、Gateway 和客户端。

## 两个集成测试脚本

`runtime/run-integration-tests.ps1` 启动测试 Redis，运行 Gateway 与 Python Worker 的 Redis 联调测试。

`memory/run-integration-tests.ps1` 启动记忆测试服务并运行相应 Python 集成测试。它会启用真实 LLM 测试条件，因此还需要相关模型配置。

两个脚本都支持 `-StopAfter`，表示结束后关闭对应测试服务；记忆脚本的 `-FullSuite` 会改为运行默认 Python 测试集合，不会顺带运行所有 Node.js 测试。

这些是脚本用途说明，本轮文档整理没有执行它们。

## sandbox/python 里有什么

`Dockerfile` 以 Python 3.12 为基础，安装 pytest、Ruff、mypy、build 等检查依赖，并设置普通用户。

`run_python_build.py` 是受控构建入口。Agent 不能把任意 Shell 命令塞进构建工具。

Docker 环境与根目录 `.venv` 相互独立。本机 Python 可以导入某个包，不代表目标测试沙箱中也已安装它。

## 修改这些文件会影响什么

修改 Compose 会影响服务和端口；修改 Dockerfile 会影响后续准备的沙箱镜像；修改 PowerShell 脚本会影响启动、测试或清理行为。这里只写说明的 README 不会直接启动任何服务。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](../docs/ACCEPTANCE_LOCAL_RUNTIME.md)。
