# Desktop 和 CLI：怎样使用这个项目

更新日期：2026-09-09。本轮代码尚未运行验证。

Desktop 是桌面窗口，CLI 是终端命令。默认任务经过 Gateway 和本地 Python 运行库，不再需要 Redis。
桌面支持会话恢复和关闭／开启／智能三档模式；旧 CLI 命令不等于完整的桌面多轮会话界面。

Desktop 另外提供本地仓库浏览和文本预览，用来帮助你理解选中的项目。

## 先准备后台

先安装项目依赖并配置聊天模型。`pnpm desktop:dev` 会启动本地后台和桌面；使用隔离测试工具时仍需 Docker。具体顺序见 [本地运行说明](LOCAL_RUNTIME.md)。

默认 Gateway 地址为 `http://127.0.0.1:3000`。普通任务不强制要求 Ollama；配置向量记忆时才需要相应向量服务。

## Desktop 怎样启动

首次安装 Node.js 依赖：

```powershell
pnpm install
```

构建并打开 Electron 窗口：

```powershell
pnpm desktop:dev
```

当前这条命令先构建，再启动 Gateway、本地 Python 执行进程和 Electron。
如果已另行启动 Gateway，请用 `pnpm desktop:only`，避免占用同一端口。

只构建时使用：

```powershell
pnpm desktop:build
```

构建后的代码在 `apps/desktop/dist`。要修改界面，应修改 `src` 中的源码；再次构建会重新生成 `dist`。

## 界面里能做什么

- 选择本地工作区，输入自然语言任务。
- 提交、查询和取消任务。
- 查看工具执行事件、修改文件、测试与检查结果、最终回答。
- 浏览选中仓库的目录和文本文件。
- 切换主题，保留部分本地界面偏好和任务历史信息。

普通寒暄会直接回答，不会因为已经选择工作区就启动仓库扫描。只有明确的代码任务才会
创建子 Agent 并运行仓库验证；直接回复的 Docker 与 Ruff 状态显示为“未运行”，不是“未通过”。

目录预览用于查看文件。任务历史用于找回任务编号和展示信息，不等于 Redis 中的完整任务结果，也不等于已经做了源码备份。

桌面端主进程负责文件对话框、受控目录读取和 Gateway 请求。页面进程通过 preload 提供的接口调用这些能力。

## CLI 怎样启动

安装 Python 项目后会生成 `bit-agent` 命令。如果没有激活虚拟环境，可以直接使用完整的项目内入口：

```powershell
./.venv/Scripts/bit-agent.exe run --workspace "D:/path/to/repo" --task "定位失败测试并修复"
```

已经激活项目虚拟环境时，可以简写：

```powershell
bit-agent run --workspace "D:/path/to/repo" --task "定位失败测试并修复"
```

## 常用命令

| 命令 | 大白话解释 |
| --- | --- |
| `bit-agent run --workspace "D:/repo" --task "修复问题"` | 提交任务，并继续等待事件和结果。 |
| `bit-agent run --workspace "D:/repo" --task "修复问题" --detach` | 提交后返回，不一直占着终端等待。 |
| `bit-agent status TASK_ID` | 查询指定任务进行到哪里。 |
| `bit-agent result TASK_ID --json` | 获取结构化结果，适合排查问题或供程序读取。 |
| `bit-agent cancel TASK_ID` | 请求停止指定任务。 |

`TASK_ID` 是提交任务时返回的编号，不是让你原样输入这几个字母。

使用 `--gateway` 或环境变量 `BIT_AGENT_GATEWAY_URL` 可以指定 Gateway 地址，例如：

```powershell
bit-agent status TASK_ID --gateway "http://127.0.0.1:3000"
```

## 先用哪个示例理解

`workspaces/desktop-demo-calculator` 是桌面演示工作区。当前加法实现已经是正常相加，旧 README 中的“存在错误”已更新，不能假设它仍是一道未修复的题。

`evals/fixtures` 和 `services/agent/evals/fixtures` 则保存评测题目。重新做题应使用隔离副本，避免把原始题目改成答案。

## 对应代码

- `apps/desktop/src/main`：Electron 主进程和本地文件访问。
- `apps/desktop/src/renderer`：界面、事件展示、文本和 Markdown 呈现。
- `apps/desktop/src/shared`：界面和主进程之间的数据约定。
- `services/agent/src/bit_agent/cli.py`：命令行入口。
- `services/agent/src/bit_agent/client`：Python Gateway 客户端。

Desktop 的页面进程没有直接开放 Node.js 能力；本机 Gateway 可以使用 HTTP，远程地址需要 HTTPS。具体地址规则和访问限制由客户端代码执行。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](ACCEPTANCE_LOCAL_RUNTIME.md)。
