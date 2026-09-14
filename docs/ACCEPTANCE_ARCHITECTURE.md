# 目录分层验收

日期：2026-09-11。目录及依赖规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 已完成

- 实际迁移 23 个原有源码文件，另外拆出 Electron 通信入口、偏好适配器及端口，新增 Gateway 装配入口、Python 领域约定。
- 更新源码和测试导入、preload 位置、文档引用。默认启动命令保持可用。
- Python 任务业务通过接口获取 SQLite、改动记录和项目验证；Fastify 与 Electron IPC 不再导入具体存储或网络适配器。
- 迁移前已有修改保留在原文件内容及 `tmp/architecture-before/` 副本中，移动表为其中的 `moves.json`。没有迁移用户数据库或历史任务数据。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm lint`，含类型和架构检查 | 通过 |
| TypeScript / JavaScript 依赖 | 60 个模块、121 条依赖，无违规 |
| Python 依赖 | 101 个文件、261 条依赖，4 条约束全部通过 |
| 违规引用反向验证 | 临时让业务导入存储，两种检查均退出 1；移除临时文件后通过 |
| Python 完整回归 | 282 passed、12 skipped |
| JavaScript 常规回归 | 日志 2、桌面 34、Gateway 21 项通过；Gateway 3 项默认跳过 |
| 单独启用本地集成验收 | 通过真实 Gateway、Python、SQLite、Electron 的连续对话、重启恢复、取消与 SSE 重连 |
| 单独启用轮次预算集成 | 通过真实 Gateway → Python → SDK → 工具 → SQLite 链路 |
| Gateway 构建、桌面构建及便携包生成 | 通过 |

额外桌面集成验收更新了已过时的模式按钮选择器，并发现、修复 Web Awesome 内嵌图标被 CSP 拦截的问题：仅允许 `data:` 资源获取，没有开放 renderer 的 HTTP 网络访问。

## 最终便携包

`release/BitAgent-2026-09-11T06-57-12-712Z/Bit Agent.exe`。

诊断桌面复验产物：`tmp/diagnostics-desktop-CGF22B/`。验收使用真实 Electron、Gateway、Python、SQLite，以及本机模型接口夹具。原生保存窗口的选择结果由测试替身提供。

真实服务商、真实 Docker/Redis/PostgreSQL、系统断电与 OS/native 崩溃不属于本次已通过的验收。此前缺少 Electron 和旧选择器导致的集成失败已修复，并重跑通过。
