# RepoPilot 工具设计 v0.1

## 1. 设计目标

RepoPilot 只能通过受控工具读取、搜索、修改代码和运行测试。

所有工具必须满足：

- 输入和输出结构化
- 只能访问当前工作区
- 每次调用都有唯一 ID
- 记录耗时、错误和影响的文件
- 支持超时和输出截断
- 错误必须说明是否可以重试
- 禁止将任意 Shell 权限交给模型

`workspace_root` 由可信的 Worker 注入，模型不能自行指定或修改。

## 2. MVP 工具清单

| 工具 | 类型 | 用途 | 实现时间 |
|---|---|---|---|
| `list_files` | 只读 | 查看目录和文件 | Day 2 |
| `search_code` | 只读 | 使用 ripgrep 搜索代码 | Day 2 |
| `read_file` | 只读 | 按行读取文本文件 | Day 2 |
| `apply_patch` | 写入 | 使用补丁修改文件 | Day 3 |
| `run_tests` | 执行 | 运行允许的 pytest 测试 | Day 3 |
| `git_diff` | 只读 | 查看 Agent 产生的修改 | 后续 |

第一版不提供任意 `shell`、`delete_file` 和 `move_file` 工具。

## 3. 统一工具调用格式

```json
{
  "tool_call_id": "call_01",
  "tool_name": "read_file",
  "arguments": {
    "path": "src/auth.py",
    "start_line": 1,
    "end_line": 200
  }
}
```

## 4. 统一工具结果格式

```json
{
  "tool_call_id": "call_01",
  "tool_name": "read_file",
  "status": "SUCCESS",
  "output": "文件内容",
  "error": null,
  "metadata": {
    "duration_ms": 12,
    "truncated": false,
    "affected_paths": ["src/auth.py"]
  }
}
```

失败结果：

```json
{
  "tool_call_id": "call_01",
  "tool_name": "read_file",
  "status": "ERROR",
  "output": null,
  "error": {
    "code": "FILE_NOT_FOUND",
    "message": "文件不存在：src/auth.py",
    "retryable": true
  },
  "metadata": {
    "duration_ms": 3,
    "truncated": false,
    "affected_paths": []
  }
}
```

## 5. 工具状态

| 状态 | 含义 |
|---|---|
| `SUCCESS` | 工具执行成功 |
| `ERROR` | 工具执行失败 |
| `REJECTED` | 调用违反安全规则 |
| `TIMEOUT` | 超过执行时间 |

## 6. 错误类型

| 错误码 | 含义 | 是否通常可重试 |
|---|---|---|
| `INVALID_ARGUMENT` | 参数格式错误 | 是 |
| `PATH_OUTSIDE_WORKSPACE` | 路径越过工作区 | 否 |
| `FILE_NOT_FOUND` | 文件不存在 | 是 |
| `NOT_A_TEXT_FILE` | 目标不是文本文件 | 否 |
| `RESULT_LIMIT_EXCEEDED` | 结果数量过多 | 是 |
| `PATCH_REJECTED` | 补丁无法应用 | 是 |
| `COMMAND_NOT_ALLOWED` | 命令不在白名单 | 否 |
| `PROCESS_TIMEOUT` | 测试运行超时 | 是 |
| `OUTPUT_LIMIT_EXCEEDED` | 输出超过限制 | 是 |
| `INTERNAL_ERROR` | 未预期的内部错误 | 视情况判断 |

## 7. 工具定义

### list_files

列出工作区中的目录和文件。

输入：

```json
{
  "path": "",
  "max_depth": 2,
  "include_hidden": false
}
```

限制：

- `path` 必须是工作区相对路径
- 默认不返回 `.git`、`.venv` 和 `node_modules`
- 最大深度不能超过配置上限
- 返回数量必须受限

### search_code

使用 `rg` 搜索代码内容。

输入：

```json
{
  "query": "login",
  "path": "src",
  "glob": "*.py",
  "max_results": 50
}
```

限制：

- 不允许模型拼接完整 Shell 命令
- 参数以独立参数传递给 `rg`
- 默认忽略二进制文件和 Git 忽略项
- 限制匹配数量和输出长度

### read_file

按行读取文本文件。

输入：

```json
{
  "path": "src/auth.py",
  "start_line": 1,
  "end_line": 200
}
```

限制：

- 只读取工作区内的普通文本文件
- 禁止读取 `.env`、密钥和 Git 内部文件
- 单次读取行数和字节数受限
- 返回内容必须带行号

### apply_patch

使用统一 Diff 补丁修改文件。

输入：

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/auth.py\n...\n*** End Patch"
}
```

限制：

- 修改前检查补丁中的所有路径
- 禁止修改工作区之外的文件
- 禁止修改 `.git`、`.env` 和密钥文件
- 失败时不能留下只应用一半的补丁
- 返回实际修改的文件列表

### run_tests

运行受控的 pytest 命令。

输入：

```json
{
  "target": "tests/test_auth.py",
  "timeout_seconds": 60
}
```

限制：

- 模型不能提交任意 Shell 命令
- Worker 固定执行 `python -m pytest`
- `target` 必须位于工作区
- 必须限制运行时间和输出长度
- 记录退出码、stdout、stderr 和耗时

### git_diff

获取当前工作区的 Git Diff。

输入：

```json
{
  "paths": []
}
```

限制：

- 只允许读取 Diff
- 不允许执行 commit、push 或 reset
- 输出超过限制时必须截断并标记