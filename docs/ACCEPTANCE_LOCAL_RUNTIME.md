> 这是较早的本地运行重构验收。后续权限、交互和便携包验收请看 [最新报告](ACCEPTANCE_PRODUCT_HARDENING.md)。

# 本地运行版验收记录

验收日期：2026-09-09。

## 结论

本轮本地运行链路通过验收。它已经不是只能看代码的方案：实际启动了 Gateway、Python 执行进程和 Electron 页面，验证了提交任务、继续对话、恢复记录、切换目录和取消任务。

这不等于已经完成正式发布。真实在线模型、真实 Docker 沙箱、打包后的安装程序仍需要单独验收。

## 本轮检查结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| Python 回归 | 225 项通过，6 项跳过 | 跳过项需要 Docker 或项目沙箱镜像 |
| Desktop 和 Gateway 常规测试 | 15 项通过，2 项跳过 | 一个是 Redis 集成测试；另一个是下面单独启用的本地串联验收 |
| 本地串联验收 | 1 项通过 | 一个测试包含 HTTP、SSE、Python 重启及真实 Electron 操作等多个场景 |
| TypeScript 类型检查 | 通过 | Desktop 主进程、页面和 Gateway |
| 桌面构建 | 通过 | 生成 Electron 使用的主进程和页面文件，不是生成安装包 |
| 本轮 Python 文件的 Ruff 检查 | 通过 | 新运行模块、Agent 运行入口和新增测试；不代表对所有历史文件做了格式重写 |

Python 回归明确排除了 `test_memory_backends_integration.py`、`test_worker_redis_integration.py` 和 `test_mcp_integration.py`，因此不能据此宣称 Redis、PostgreSQL 或外部 MCP 集成通过验收。

## 具体验证了什么

| 用户操作或边界 | 验收方式 |
| --- | --- |
| 不启动 Redis，也能提交和执行任务 | Gateway 通过本机输入输出通道调用真实 Python 进程 |
| 同一对话继续提问 | 模拟模型实际收到第一轮和第二轮的输入，第二轮回答包含第一轮标记 |
| 关闭执行进程后再继续 | 关闭并重新启动 Python，使用同一 SQLite 目录，继续原对话仍能取得原内容 |
| 会话列表不只依赖页面缓存 | 清除验收页面的历史列表缓存后重新加载，仍能从后端恢复会话及旧消息 |
| 工作记忆不因 TTL 到期消失 | 写入时传入 1 秒 TTL，超过 1 秒后仍可读取；本地存储有意不使用 TTL |
| 关闭多 Agent | 模型可用工具中没有 `delegate_tasks` |
| 开启多 Agent | 模拟主模型调用委派工具，两个调查子 Agent 实际运行并返回结果 |
| 智能模式 | 主模型可以使用委派工具；简单任务不额外调用一个“分类模型” |
| 子 Agent 的权限 | 可用工具只有列目录、读文件和搜代码，没有写文件、运行测试或继续委派的权限 |
| 排队时取消 | 状态变为取消，不再执行该任务 |
| 正在执行时取消 | 当前任务结束为取消状态 |
| 协程尚未开始就取消 | 对话忙碌标记能释放，之后可以继续提交 |
| 同一个目录同时提交任务 | 写入同一工作目录的任务依次执行 |
| 不同目录提交任务 | 在设置的并发上限内可以同时执行 |
| 手动修改目录 | 开始新对话，不把原文件夹的历史继续带入新目录 |
| 页面实时事件 | 收到真实 Gateway 返回的 SSE，事件记录和完成状态能显示 |

TTL 测试不是等待了 24 小时；它验证的是本地存储没有执行到期删除。进程恢复测试使用了干净关闭再启动，没有模拟断电或磁盘损坏。

## 验收中修复的问题

1. 任务还未开始就取消时，可能留下一直忙碌的对话标记。
2. 手动修改目录输入框时，旧目录比较不正确，可能没有切断原对话。
3. 恢复工作记忆时，普通的继续提问不应意外覆盖最初任务目标；只有明确传入新目标时才更新。
4. 本轮 Python 的导入、长行和格式问题。
5. 新验收脚本的 TypeScript 环境变量类型，以及隐藏 Electron 窗口截图没有及时刷新的问题。

修复后重新运行了对应检查。桌面验收还增加了“任务 ID 必须变化、回答必须包含本轮内容”的断言，不能靠上一轮的完成状态误通过。

## 验收数据在哪里

本轮使用了独立临时目录，不使用日常会话数据库和 Electron 偏好设置。

- Python 回归临时目录：`tmp/acceptance-63a4f0062a004934a5130aab5043445f`。
- 桌面串联验收目录：`tmp/local-acceptance-u7SDnr`。
- 页面截图：`tmp/local-acceptance-u7SDnr/desktop-acceptance.png`。
- 截图时的页面状态：`tmp/local-acceptance-u7SDnr/desktop-state.json`。
- 验收会话数据库：`tmp/local-acceptance-u7SDnr/data/sessions.sqlite3`。

截图时状态为 `COMPLETED`，回答同时包含 `desktop first` 和 `desktop followup`，并展示了一个已保存的旧轮次。

## 还不能据此保证什么

1. **真实模型的能力。** 本轮模型是 localhost 上的模拟 Responses 服务，没有调用付费模型。已验证请求和结果能走通，但没有验证真实模型的回答质量，以及何时委派更合理。
2. **Docker 真正运行成功。** 6 个相关用例因环境缺少 Docker 或沙箱镜像跳过。页面上的任务完成不等于 Docker 测试已经通过。
3. **安装包可直接交给另一台电脑。** 本轮执行的是桌面构建和开发环境中的真实 Electron，不是打包安装后的 `.exe` 验收。Python 运行环境、依赖和启动方式的随包交付仍需处理。
4. **Redis、PostgreSQL、外部 MCP 兼容性。** 本轮没有连接这些真实服务；保留旧适配器不等于这次重新验证了它们。
5. **异常关机后的所有副作用。** 已验证正常重启恢复及取消边界，尚未做断电、数据库损坏、磁盘写满等故障演练。取消任务也不意味着已执行的文件修改会自动撤销。

## 如何再次运行

在项目根目录运行类型检查和普通 Node 测试：

```powershell
pnpm -r typecheck
pnpm test
pnpm desktop:build
```

单独启用真实桌面串联验收。需要项目 `.venv`、Node 依赖和已经构建的桌面文件；不需要提供真实模型密钥：

```powershell
$env:BIT_AGENT_TEST_LOCAL_RUNTIME = "1"
try {
    pnpm --dir apps/gateway exec vitest run test/local-runtime.integration.test.ts
} finally {
    Remove-Item Env:BIT_AGENT_TEST_LOCAL_RUNTIME -ErrorAction SilentlyContinue
}
```

Python 本地回归，使用新的独立临时目录：

```powershell
$base = Join-Path (Get-Location) ("tmp/acceptance-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $base | Out-Null
$env:PYTHONUTF8 = "1"
.\.venv\Scripts\python.exe -m pytest -q --tb=short --basetemp (Join-Path $base "pytest") --ignore=services/agent/tests/test_memory_backends_integration.py --ignore=services/agent/tests/test_worker_redis_integration.py --ignore=services/agent/tests/test_mcp_integration.py
```

运行说明见 [本地运行方式](LOCAL_RUNTIME.md)。
