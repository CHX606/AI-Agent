# 修改后的验证：怎样判断“改完了”

更新日期：2026-09-30。本文说明桌面任务中 `verify_project` 的规则：它检查哪些文件、跑哪些命令、怎样和修改前对比，以及在没法验证时怎样如实告诉你。

## 一句话版本

Agent 改了文件以后必须调用 `verify_project`。它只追究**这一轮改动新带来的问题**，项目里原本就有的失败测试和 lint 问题不会让任务卡住；没有能运行的检查时，任务可以结束，但界面明确显示“无法验证”，不会显示成“通过”。

## 四种结论

| 结论 | 什么时候出现 | Agent 能否结束 | 界面显示 |
| --- | --- | --- | --- |
| `PASSED` | 检查通过；或者失败项在修改前就存在 | 能（开启独立验收时还要通过 `verify_task`） | 通过 |
| `FAILED` | 出现了修改前没有的失败 | 不能，需要继续修复 | 未通过 |
| `UNVERIFIED` | 没有能运行的检查（见下表） | 能，最终回答必须说明哪些改动没验证 | 无法验证（琥珀色），检查器下方列出原因 |
| `NOT_APPLICABLE` | 只改了文档、图片、`.gitignore` 这类文件 | 能 | 无需检查 |

`UNVERIFIED` 和 `NOT_APPLICABLE` 都不会触发独立验收，也不会提炼长期记忆。这时 Agent 如果仍调用 `verify_task`，会得到“无需独立验收”的提示（界面上是中性的灰色，不是失败），并且不会因此被要求重新验证。

常见的 `UNVERIFIED` 原因：

| 原因 | 怎样解决 |
| --- | --- |
| 找不到所属项目（例如 Go、Rust、Java 文件） | 在 `.bit-agent/verify.json` 配置验证命令，见下文 |
| 多包 Node 工作区、未写明 pnpm 版本 | 同上，或按提示补齐 `packageManager` |
| 项目没有测试（pytest 收集不到任何测试） | 给项目补测试 |
| 修改前后都没有通过的测试，或检查在修改前就失败且无法逐条比对 | 先修好项目自己的测试环境 |
| Docker 没有运行或没有安装 | 启动 Docker Desktop，让 Agent 重新验证 |
| `.bit-agent/verify.json` 写错了 | 按提示修正配置 |

如果 Agent 连续多次想结束却不运行任何验证，任务会提前停止，不再把最大轮数用完。

## 前后对比怎样做

1. 先在当前代码上运行检查。通过就结束，不做对比。
2. 有检查失败时，框架复制一份工作区，把本轮改过的文件恢复成修改前的内容（来自改动审阅记录的“修改前快照”），在同一个隔离环境里再跑同一条命令。
3. 比较两次结果：

| 检查 | 比较方式 |
| --- | --- |
| pytest | 逐条比较 `FAILED` / `ERROR` 的测试编号，只把新出现的算作失败；修改前后都没有任何通过的测试时判为 `UNVERIFIED` |
| Ruff | 按“文件 + 规则编号”统计问题数量，只把增加的部分算作失败 |
| 其他命令 | 修改前通过、修改后失败 → `FAILED`；修改前就失败 → `UNVERIFIED` |

只有本轮每个改动文件都有修改前快照时才做对比。比如上一轮任务中断、这一轮接着验证，就没有完整快照，这时检查失败直接按 `FAILED` 处理，不会误把新问题当成旧问题。

原工作区在整个过程中不会被改动；对比副本用完即删。

## 默认检查哪些内容

| 改动文件所在的项目 | 识别依据 | 运行的命令 |
| --- | --- | --- |
| Python | 目录里有 `pyproject.toml`、`pytest.ini`、`setup.cfg`、`setup.py`、`tox.ini` 或任意 `requirements*.txt`；什么都没有的 `.py` 文件在工作区根目录验证 | `pytest -q -rfE`；Ruff **只检查本轮改到的 `.py` 文件** |
| Node 单包 | 有 `package.json` 和 `test` 脚本，并至少有 `lint`、`typecheck`、`build` 之一 | `npm`/`pnpm run test` 及已有的质量脚本 |
| 文档等 | `.md`、`.rst`、图片、`LICENSE`、`CHANGELOG`、`.gitignore` 等 | 不运行检查 |

项目没有自己的 Ruff 配置（`ruff.toml`、`.ruff.toml` 或 `pyproject.toml` 里的 `[tool.ruff]`）时，只检查 `E9`、`F` 两类：语法错误和明显缺陷（未定义的名字、未使用的导入等），不把 Ruff 默认的风格规则强加给从没用过它的项目。有配置时完全按项目自己的规则。

Ruff 固定忽略 `EXE001`、`EXE002`：Windows 文件挂进 Linux 容器后都显示为可执行（权限 777），这两条规则会对每个文件误报。

## 项目自定义：`.bit-agent/verify.json`

在项目根目录放一个 `.bit-agent/verify.json`，可以指定验证命令，或者声明哪些文件不需要验证。

```json
{
  "projects": [
    {
      "path": "server",
      "image": "golang:1.23",
      "commands": [["go", "test", "./..."], ["go", "vet", "./..."]],
      "timeout_seconds": 600
    },
    {
      "path": "",
      "language": "python",
      "commands": [["python", "-m", "pytest", "-q", "tests/unit"]]
    }
  ],
  "skip": ["scripts/*", "deploy/**"]
}
```

| 字段 | 含义 |
| --- | --- |
| `path` | 项目目录，相对工作区根目录；`""` 表示根目录。改动文件归属路径最长、包含它的那一项 |
| `language` | `python` 或 `node` 时使用内置的依赖准备；提供 `image` 时可以省略（视为自定义镜像） |
| `image` | 自定义 Docker 镜像。命令在该镜像里、工作区的可写副本中运行；镜像需要自带依赖 |
| `commands` | 1 到 10 条命令，每条是字符串数组，不经过 shell 拼接 |
| `timeout_seconds` | 每条命令的超时，10 到 1800 秒，默认 300 |
| `skip` | 文件匹配模式（`*` 可以跨目录），匹配到的改动不需要验证 |

限制和安全规则：

- 命令仍在隔离容器里运行：**没有网络**、资源受限、原工作区只读。自定义镜像里的命令如果需要下载依赖（例如 `go test` 拉模块），要提前把依赖做进镜像或放进项目（例如 `vendor/`）。
- 配置写错时，验证结果为 `UNVERIFIED` 并说明原因，不会悄悄退回默认规则。
- `.bit-agent/` 下的文件决定“怎样算通过”。Agent 修改这些文件时，**即使在“允许修改”模式下也必须由你逐次确认**，不能选择“本对话内都批准”。

## 沙箱镜像

默认 Python 沙箱镜像 `bit-agent-python-sandbox:0.1.0` 的 Dockerfile 随程序一起分发（`services/agent/src/bit_agent/sandbox/images/python/`）。第一次验证时如果本机没有这个镜像，会自动构建一次，大约需要一两分钟和网络连接；之后直接复用。用 `BIT_AGENT_SANDBOX_IMAGE` 指定其他镜像时不会自动构建，需要你先准备好。

## 对应代码

| 文件 | 作用 |
| --- | --- |
| `runtime/infrastructure/verification.py` | 归类改动、读取项目配置、运行命令、前后对比、得出结论 |
| `runtime/infrastructure/changes.py` | `originals()` 提供本轮修改前的文件内容 |
| `agent/verification.py` | 根据结论决定 Agent 能否结束，记录界面要显示的状态和原因 |
| `runtime/application/delegation.py` | 调用验证前的权限确认；验证配置改动的强制确认 |
| `sandbox/environment.py` | 默认沙箱镜像的自动构建 |
| `sandbox/docker.py` | `custom` 镜像的执行方式、Docker 状态检查 |

表中 Python 路径都位于 `services/agent/src/bit_agent/`。
