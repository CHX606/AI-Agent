# 设计缺陷修复验证

日期：2026-09-12。范围：本次确认的 5 项设计缺陷；源码及开发构建已更新。

归档于 2026-09-14。以下测试结果和发布包说明属于原验收日期，不代表后续构建的状态；文中的 `tmp/` 路径均相对于项目根目录。

原 Python 验收临时目录已移至 `tmp/archived-pytest-20260914/pytest-design-fixes-all`；下面保留当时执行的原始命令。

## 修复与兼容性

1. 删除权限根据补丁解析结果判断，覆盖 unified diff 的 `/dev/null` 和 Begin Patch 删除。普通编辑、新增、清空文件内容及既有 confirm/read_only 模式保持原行为。
2. 任务执行与改动审阅共用工作区预约；父子目录互斥，互不重叠目录仍并行。排队取消不泄漏预约，等用户时继续释放执行名额。
3. 超过摘要输入预算的历史分段送摘要器，全部成功后才替换原历史。摘要未完成时保留原文；超过硬上限则明确停止。摘要本身仍受字段和 token 预算限制，不承诺所有事实永不丢失。
4. 普通回答与接收状态同事务保存，上下文保存成功时确认消费；中断续聊恢复且去重。批准类回答不会作为待执行操作重放。SQLite 新增独立表，保留既有会话结构与数据。
5. 健康检查区分正常、暂不可用和执行进程退出。临时故障保持按游标退避重连，明确退出时停止重试并提示重启。受管理进程退出判断仅作用于对应地址的订阅。

## 验证结果

- Python 全量：`python -m pytest -q --basetemp=tmp/pytest-design-fixes-all`，337 passed，12 skipped。跳过项涉及 Docker 沙箱、未配置的 Redis/PostgreSQL 和在线模型集成。
- Node 工作区：`pnpm -r test`，Desktop 40、Gateway 25、Diagnostics 2 项通过；Gateway 默认跳过 3 项可选集成，随后单独启用本地运行集成并通过。
- 类型检查：`pnpm -r typecheck` 通过。
- 架构检查：`pnpm architecture:check` 通过，JavaScript 无违规，Python 4 项约束全部满足。
- 构建：`pnpm -r build` 通过；最后一次地址绑定修正后再次完成类型、架构、Desktop 构建和事件流定向测试（6 项通过）。
- 本地集成：启用 `BIT_AGENT_TEST_LOCAL_RUNTIME=1` 运行 `test/local-runtime.integration.test.ts`，1 passed。覆盖真实 Gateway、Python、Electron，使用本地假模型和独立数据；验证续聊、重启恢复、多 Agent、取消、SSE 断线后按游标恢复、会话切换与重载。
- 首次 Electron 集成在受限环境中因 GPU 子进程启动异常失败；相同测试在正常系统权限下通过，未更改产品启动参数或系统依赖。
- Python 变更文件 Ruff 与修复前备份对比：原有 53 项长注释行长提示保持不变，新增问题 0；其他变更 Python 文件 Ruff 通过。
- 独立复核：上下文替换的异常边界、回答事务与去重、批准不重放、预约取消清理均已复核；额外 100 轮取消预约压力检查通过。

## 验收材料

- 修复前源码备份：`tmp/design-fixes-before-20260912/`
- 变更文件及 Ruff 基线对比：[变更清单](design-fixes-2026-09-12-changes.json)
- 桌面验收记录：`tmp/local-acceptance-QvhDTZ/desktop-state.json`
- 已人工查看的桌面截图：`tmp/local-acceptance-QvhDTZ/desktop-acceptance.png`

未连接真实付费模型或生产数据库。现有 release 目录中的旧发布包没有重新生成；它们不包含此次源码修复。
