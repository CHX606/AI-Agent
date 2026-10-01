# 文档导航：遇到什么问题看哪份

这里保存 Bit Agent 自己维护的项目说明。它们解释设计、用途和用法；修改 Markdown 通常只改变说明内容，不会直接改变程序行为。

部分评测 README 还会作为 Agent 的任务材料，因此其中的规则也需要认真维护。

## 推荐阅读顺序

1. [项目结构大白话指南](PROJECT_STRUCTURE.md)：先知道每个目录装的是什么。
2. [项目首页](../README.md)：了解整体用途和本地启动步骤。
3. [Desktop / CLI](CLI_DESKTOP.md)：了解用户操作入口。
4. [Python Agent 目录](../services/agent/README.md)：开始阅读执行逻辑。

## 按问题查找

| 你想知道 | 看这里 |
| --- | --- |
| Agent 主循环怎样基于 OpenAI Agents SDK 运行 | [SDK_RUNTIME.md](SDK_RUNTIME.md) |
| 本地执行进程、会话和数据怎样保存 | [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md) |
| 权限模式、暂停、提问和改动审阅 | [PRODUCT_HARDENING.md](PRODUCT_HARDENING.md)、[INTERACTION.md](INTERACTION.md) |
| 业务、数据与通信层怎样分目录和连接 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 桌面日志在哪里、如何导出诊断包 | [DESKTOP_DIAGNOSTICS.md](DESKTOP_DIAGNOSTICS.md) |
| 某项功能验收过什么、没验收什么 | [validation/](validation/) 下的验收报告 |
| 这个产品已经做了什么、还缺什么 | [PRD.md](PRD.md) |
| Gateway 有哪些接口、任务怎样交给执行进程 | [GATEWAY.md](GATEWAY.md) |
| COMPLETED、PARTIAL、FAILED 是什么意思 | [STATE_MACHINE.md](STATE_MACHINE.md) |
| 模型怎么读文件、改文件和运行检查 | [TOOLS.md](TOOLS.md) |
| 改完代码怎样验证、“无法验证”是什么意思、怎样给其他语言配置检查 | [VERIFICATION.md](VERIFICATION.md) |
| 怎样用 AGENTS.md 告诉 Agent 项目约定、怎样把改动提交到 Git | [PROJECT_CONFIG.md](PROJECT_CONFIG.md) |
| 项目依赖怎样自动下载、环境怎样缓存 | [ENVIRONMENT.md](ENVIRONMENT.md) |
| 多个 Agent 怎样分工 | [MULTI_AGENT.md](MULTI_AGENT.md) |
| 当前任务记忆和长期记忆有什么区别 | [MEMORY.md](MEMORY.md) |
| 历史太长时怎样处理 | [CONTEXT.md](CONTEXT.md) |
| 怎样把工具提供给其他客户端 | [MCP.md](MCP.md) |
| 出错以后在哪里找过程和结果 | [OBSERVABILITY.md](OBSERVABILITY.md) |
| Docker、数据库配置做什么 | [infra 说明](../infra/README.md) |
| 评测原题和完成后的副本有什么区别 | [evals 说明](../evals/README.md)、[.test-runs 说明](../.test-runs/README.md) |

说明文档只写"现在是什么样"；某次验收跑了什么、结果如何，统一记录在 `docs/validation/` 的报告里，报告保留当时的事实，不随后续修改更新。临时工作区、日志、测试用户配置和 EXE 发布包只保留在本机，不随源码提交。
