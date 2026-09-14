# Agent 工具：模型怎样真正操作文件

更新日期：2026-09-09。本文按当前提供给模型的参数说明，不再沿用早期计划中的工具列表。

## 工具是做什么的

模型说“我想看这个文件”，并不等于文件已经被读取。它需要发出结构化的工具请求，由本项目的 Python 代码执行，再把结果交回模型。

你可以把工具理解成几只用途固定的手：一只翻目录、一只读文件、一只搜索、一只改文件，还有两只负责测试和检查。

工作区根目录由启动程序或 Worker 指定。模型提供的路径是这个目录下面的相对路径，不能靠工具参数换成另一个工作区。

## 六个基础工具和本地运行新增工具

| 工具 | 实际用途 | 模型传入的参数 |
| --- | --- | --- |
| `list_files` | 查看文件和文件夹名字，不读正文。 | `path`、`max_depth` |
| `read_file` | 读取 UTF-8 文本并带上行号。 | `path` |
| `search_code` | 用 ripgrep 搜索代码内容。 | `query`、`path` |
| `apply_patch` | 按补丁创建、修改或删除文件。 | `patch` |
| `run_tests` | 在受控沙箱中运行 pytest。 | `target` |
| `run_checks` | 运行预定义的静态检查、格式检查、类型检查或构建。 | `check`、`paths` |

默认本地运行还提供 `verify_project`（按实际改动选择语言验证）、`ask_user`（向用户提问）和按模式开放的 `delegate_tasks`（委派只读调查）。子 Agent 仍只有阅读和搜索工具。

用户通过桌面的改动审阅查看真实差异并有条件撤销；没有向模型提供 `git_diff` 工具。评测器可以通过文件快照生成 Diff；这与模型能不能调用某个工具是两回事。

测试沙盒默认使用 `bit-agent-python-sandbox:0.1.0`。Harness 会在测试或检查前自动读取项目依赖，构建并缓存依赖镜像；测试容器保持无网络、只读工作区和资源限制。支持范围和 OCR 系统包声明见 [自动环境准备](ENVIRONMENT.md)。也可通过 `BIT_AGENT_SANDBOX_IMAGE` 选择预置基础镜像，例如：

```powershell
docker build -t bit-agent-python-web-sandbox:0.1.0 infra/sandbox/python-web
```

## 常见调用例子

查看根目录的第一层：

```json
{"path": "", "max_depth": 0}
```

读一个文件：

```json
{"path": "src/calculator.py"}
```

搜索：

```json
{"query": "calculate", "path": "src"}
```

运行测试：

```json
{"target": "tests"}
```

检查改动过的 Python 文件：

```json
{"check": "lint", "paths": ["src/calculator.py"]}
```

这些例子分别对应上面的工具，不能把一个工具的参数随意加到另一个工具上。当前模型接口没有早期文档中的 `start_line`、`end_line`、`glob`、`include_hidden` 或 `timeout_seconds` 参数；运行限制由框架设置。

## run_checks 的四种检查

| `check` | 实际执行方向 | 主要解决什么问题 |
| --- | --- | --- |
| `lint` | Ruff 静态检查 | 例如没使用的导入、不合理写法等。 |
| `format` | Ruff 的 `format --check` | 看格式是否符合要求，不会自动重排源文件。 |
| `typecheck` | mypy | 看类型使用是否符合声明和配置。 |
| `build` | 受控 Python 包构建脚本 | 看项目能否按构建配置生成分发包。 |

`paths` 必须提供检查范围。构建只能指定一个项目目录；根目录使用空字符串，例如：

```json
{"check": "build", "paths": [""]}
```

类型检查和构建是否有意义，取决于目标项目自己的结构和配置。它们不是任意命令执行入口。

## apply_patch 是怎样改文件的

它接受 Git unified diff，也接受 `*** Begin Patch` / `*** End Patch` 格式。补丁写清楚目标文件、旧内容和新内容，工具检查路径及上下文后再应用。

为了避免模型一次生成大量文件导致请求超时，较大的改动应拆成多轮补丁；单次建议只处理不超过 3 个紧密相关文件。

“没有单独的删除工具”不代表不能删除文件：受控补丁本身可以包含 `Delete File`。是否允许应用，由本轮权限模式、明确确认、路径安全和补丁规则共同决定。问答超时不能授予写权限。

## 测试与检查在哪里运行

默认代码工具使用 Docker 沙箱。它为执行准备工作区快照，限制网络、用户权限、内存、CPU 和运行时间，避免把目标代码当作无限制的本机程序运行。

容器中的 Python 环境由 `infra/sandbox/python/Dockerfile` 定义，与项目根目录的 `.venv` 是两个环境。本机安装了某个依赖，不代表沙箱里也已经有它。

## 修改后什么时候允许结束

当前普通 Agent 在成功应用补丁后，会要求：

1. 修改后的 pytest 测试成功。
2. `run_checks(check="lint", ...)` 成功，并覆盖本轮改动文件。

如果后面又修改了代码，前面的验证结果就不再足以证明新版本。这些检查由 Agent 运行框架跟踪，MCP Server 本身主要负责转接工具调用。

## 工具结果怎么读

```json
{
  "tool_call_id": "call_01",
  "tool_name": "read_file",
  "status": "SUCCESS",
  "output": "带行号的文件内容",
  "error": null,
  "metadata": {
    "duration_ms": 12,
    "truncated": false,
    "affected_paths": ["src/calculator.py"]
  }
}
```

| 字段 | 意思 |
| --- | --- |
| `tool_call_id` | 这一次调用的编号，方便把请求和结果对起来。 |
| `status` | 成功、失败、拒绝或超时。 |
| `output` | 正常结果，可能是文本，也可能是结构化对象。 |
| `error` | 失败原因，包括错误码、说明和能否重试。 |
| `duration_ms` | 这次花了多少毫秒。 |
| `truncated` | 输出是否因为太长而被截断。 |
| `affected_paths` | 这次操作关联或影响到哪些文件。 |

`affected_paths` 出现在读取结果里时，不代表文件被修改；需要同时看工具名称。

常见错误有路径越界、文件不存在、参数不合法、补丁无法应用、检查不通过或超时。不要只看到“调用结束”就认为功能检查通过。

## 想看实现，去哪里

- `services/agent/src/bit_agent/llm/tool_schemas.py`：告诉模型工具如何调用。
- `services/agent/src/bit_agent/tools`：具体执行逻辑。
- `services/agent/src/bit_agent/tools/context.py`：超时、读取行数和输出量等限制。
- `services/agent/src/bit_agent/security`：工作区路径边界。
- `services/agent/src/bit_agent/sandbox`：Docker 执行环境。
- `services/agent/src/bit_agent/tool_provider`：本地调用、MCP 调用和工具权限限制。
