# Bit Agent MCP

更新日期：2026-09-04。

## MCP 在这里做什么

本项目已经有一套 Python 工具。MCP 是把这些工具开放给其他兼容程序调用的统一接口，可以理解成“工具的通用插口”。

例如同一个读文件功能，既能被 Bit Agent 内部直接调用，也能通过 MCP Server 提供给另一套客户端。实际干活的仍然是原来的工具代码。

当前提供六个工具：`list_files`、`read_file`、`search_code`、`apply_patch`、`run_tests`、`run_checks`。参数和用途见 [工具说明](TOOLS.md)。

## 去哪里看代码

| 目录 | 用途 |
| --- | --- |
| `services/agent/src/bit_agent/mcp_server` | 把工具注册成 MCP 服务，提供启动入口。 |
| `services/agent/src/bit_agent/tool_provider` | 让 Agent 通过本地方式或 MCP 调用工具。 |
| `services/agent/src/bit_agent/tools` | 真正读取、搜索、修改和检查的实现。 |

`stdio` 通过子进程的标准输入输出通信；`streamable-http` 通过 HTTP 地址通信。二者是连接方式，不是两份不同的代码工具。

下文的“修改后必须验证”由 Bit Agent 运行框架执行。其他 Host 直接调用 MCP 工具时，不能把 Server 的存在当成整套任务验收流程已自动接好。

Bit Agent 可以继续使用进程内 Python 工具，也可以把同一套受控工具通过 Model Context
Protocol 暴露给 Bit Agent 或其他 MCP Host。工具实现只有一份，MCP Server 只是协议适配层。

其中 `run_tests` 负责 pytest，`run_checks` 只允许执行预定义的 `lint`、`format`、
`typecheck` 和 `build`，不会把任意 Shell 权限交给模型。代码修改后，Agent 必须同时通过
pytest 和 Ruff lint 才能结束任务。

## 启动 stdio MCP Server

```powershell
.\.venv\Scripts\python.exe -m bit_agent.mcp_server `
  --workspace "D:\path\to\repository"
```

`workspace` 由启动 Server 的可信宿主指定，不会出现在提供给模型的工具参数中。所有模型路径
仍然必须是相对于该工作区的路径，并继续经过 Bit Agent 的路径安全校验。

通用 MCP Host 配置示例：

```json
{
  "mcpServers": {
    "bit-agent": {
      "command": "D:\\myproject\\AI Agent\\.venv\\Scripts\\python.exe",
      "args": [
        "-m",
        "bit_agent.mcp_server",
        "--workspace",
        "D:\\path\\to\\repository"
      ]
    }
  }
}
```

## 启动 Streamable HTTP Server

```powershell
.\.venv\Scripts\python.exe -m bit_agent.mcp_server `
  --workspace "D:\path\to\repository" `
  --transport streamable-http `
  --host 127.0.0.1 `
  --port 8765
```

本地 HTTP 端点为 `http://127.0.0.1:8765/mcp`。当前实现默认只绑定回环地址；公开部署前
必须另外增加认证、TLS 和访问控制。

## Agent 中切换 MCP

```python
from bit_agent.agent import run_agent
from bit_agent.mcp_server import create_mcp_server
from bit_agent.tool_provider import MCPToolProvider

server = create_mcp_server(workspace_root)
provider = MCPToolProvider(server)

result = await run_agent(
    prompt,
    workspace_root=workspace_root,
    tool_provider=provider,
)
```

这里使用的是 MCP SDK 的内存传输，适合嵌入和测试；stdio 与 Streamable HTTP 使用相同的
`MCPToolProvider`，只需更换它接收的 Server/Transport。

## 反过来：让 Bit Agent 使用别人的 MCP Server（外部工具）

上面几节讲的是把 Bit Agent 的工具开放出去。桌面版也能接入其他 MCP Server，把它们的工具交给主 Agent，例如查文档、读 Issue、查数据库。

在侧栏“外部工具”中添加服务：

| 类型 | 填写 | 说明 |
| --- | --- | --- |
| 本机命令（stdio） | 命令、参数（每行一个）、可选的环境变量（`KEY=VALUE`） | 命令在当前工作区目录下运行；环境变量的值用 Windows 系统加密保存，页面之后只显示变量名 |
| 远程地址（HTTP） | Streamable HTTP 地址、可选的请求头（每行一个 `Name: Value`，如 `Authorization: Bearer <令牌>`） | 远程地址必须是 HTTPS，本机地址允许 HTTP；请求头的值用 Windows 系统加密保存，页面之后只显示名称；带请求头的连接不跟随重定向，避免令牌被带到别的站点 |

每个服务可以单独启用或停用，并可以点“测试”连接一次、列出它提供的工具（不调用工具）。保存后从下一轮任务开始生效。

运行规则：

- 每轮任务开始时按顺序连接启用的服务，每个最多等 30 秒。连不上的只在执行记录里提示“外部工具连接失败”，任务照常进行。
- 工具以 `mcp__<服务名>__<工具名>` 的名字提供给**主 Agent**；调查子 Agent 和独立验收 Agent 用不到。
- 外部工具在本机或远程服务上运行，**不在隔离环境中，也不进入改动审阅**。所以：
  - “只读模式”下不连接外部工具；
  - “逐次确认”模式下每次调用都要确认，可以选“本对话内都批准”（按服务计算，同一对话的后续轮次也有效）；
  - “允许修改”模式下仍然逐次确认，除非你把该服务标为“自动批准”。
- stdio 服务只拿到运行必需的系统环境变量（路径、用户目录等）和你为它填写的变量，拿不到模型密钥。
- 配置只来自你本机的设置，不读取项目里的文件：克隆下来的仓库不能替你决定在本机运行什么命令。

开发模式没有桌面托管的运行服务时，可以在启动前设置环境变量 `BIT_AGENT_MCP_SERVERS`，值是服务列表的 JSON，例如：

```json
[{"name": "docs", "type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer <令牌>"}}]
```

运行服务读取后会立即把它从自己的环境变量里移除，避免 Git、Docker 等子进程继承其中的密钥。对应代码在 `services/agent/src/bit_agent/tool_provider/external.py`。
