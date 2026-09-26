# 2026-09-25 结构优化验证记录

这一轮是结构与工程化优化，没有新增用户功能。下面记录做了什么、怎样验证、哪些没有验证。

## 改动范围

| 改动 | 说明 |
| --- | --- |
| 代码规范与 CI | 修复 119 个 Ruff 报错；新增 GitHub Actions（Windows），运行 Ruff、pytest、import-linter、类型检查、vitest、dependency-cruiser。 |
| 验证状态机 | 修改后能否结束的规则从 `run_agent` 抽到 `agent/verification.py`，新增 35 个单元测试；同一组测试对旧的内联实现也全部通过。 |
| 删除旧 Redis 链路 | Gateway `RedisTaskStore`、Python `worker` 包、Redis 存储与相关 infra、文档；最后一版保留在 git 标签 `legacy-redis`。 |
| 工具链与锁文件 | `.node-version`、`.python-version`、`mise.toml`；Python 依赖由 `uv.lock` 锁定，CI 使用 `uv sync --locked`。 |
| 事件推送 | 读事件从固定每秒轮询改为写入即唤醒，流式回答不再按 1 秒分段出现。 |
| Gateway 接口 | `TaskStore` 所有方法改为必填，删除 9 处“501 不支持”分支；令牌改用常量时间比较。 |
| `run_agent` 拆分 | 约 700 行的函数改为 `_AgentRun` 对象，每个方法一件事；工具分发移到 `agent/tool_dispatch.py`，`tool_operation` 改为查表（295 种输入与旧实现输出一致）。 |
| 测试产物 | 测试不再往仓库 `artifacts/` 写事件文件（`BIT_AGENT_ARTIFACTS_DIR`）。 |
| 桌面渲染层 | `renderer/main.ts` 从 1060 行拆出仓库浏览、任务历史、操作卡片与公共工具模块。 |
| 便携包 | 只打包运行时 Python 依赖，严格按 `uv.lock`；pytest、ruff 等开发工具不再进入发布包（site-packages 99 MB → 69 MB）。 |

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Python 测试 | 414 通过，11 跳过（跳过项需要 Docker 沙箱镜像、PostgreSQL 或真实模型） |
| Ruff lint / format | 通过 |
| import-linter 分层规则 | 4 条全部保持 |
| Gateway 测试 | 26 通过，2 跳过（真实串联测试默认跳过，见下行） |
| Gateway 真实串联测试（`BIT_AGENT_TEST_LOCAL_RUNTIME=1`、`BIT_AGENT_TEST_ROUND_BUDGET=1`） | 2 通过；覆盖真实 Python 进程与流式输出 |
| Desktop 测试 / 类型检查 / 构建 | 45 通过 / 通过 / 通过 |
| dependency-cruiser | 无违规 |
| 便携包端到端验收 `scripts/accept-packaged.mjs` | 通过：启动真实 exe，使用本地假模型完成流式回答、修改文件、提问审批、暂停、改动审阅，20 张浅色/深色、两种宽度的布局检查全部通过 |

## 没有验证的部分

- 真实在线模型、真实 Docker 沙箱内的 `run_tests` / `run_checks` / `verify_project`。
- PostgreSQL 长期记忆与真实 LLM 记忆巩固。
- GitHub Actions 工作流本身：写好后尚未在 GitHub 上运行过。
