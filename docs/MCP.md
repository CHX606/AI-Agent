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
