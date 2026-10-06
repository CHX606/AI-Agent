# 图片上传与粘贴验收（2026-10-05）

## 本轮范围

- 输入框新增图片选择按钮，支持多张图片；复制图片或截图后可在输入框 Ctrl+V 粘贴。
- 附件显示缩略图和文件名，可逐张删除；读取中和错误反馈显示在输入区，普通文字粘贴沿用原行为。
- 新聊天、续聊、引导、排队和问题回答均可附图，也允许只发图片。消息及历史恢复保留图片。
- 复用 OpenAI Agents SDK：Responses 接口收到原生 `input_image`，Chat Completions 由 SDK 转换为原生 `image_url`；当前选择的模型不变。
- 图片回答和补充输入持久化，崩溃后未消费的图片能恢复；确认问题的图片回答不代表操作授权。
- 上下文估算不把 Base64 当成文字 token；需要摘要或独立验收时图片仍按视觉内容传递。
- PNG、JPEG、WebP、非动画 GIF；每条最多 5 张，单张不超过 5 MiB，总计不超过 20 MiB。检查文件名、MIME、Base64 和文件签名。
- SSE、工具结果、诊断只保存图片元信息；完整图片用于模型输入和会话恢复。

没有新增依赖、模型能力开关、调试菜单或图片自动替换模型功能。原有未提交改动保留，本轮未提交、未推送。

## 自动化验证

- `pnpm lint`、`pnpm typecheck` 通过；JS/Python 架构约束通过。
- `pnpm test`：桌面 353 项、Gateway 68 项、诊断 2 项通过；Gateway 2 项跳过。
- Python 全量：697 项通过、6 项跳过，250.29 秒；使用系统 Temp 作为 `--basetemp`。
- 随后新增审批图片回答恢复 2 个参数化用例，专项通过；这 2 项未包含在前述全量收集结果中。
- Python 完整 Ruff 通过。
- Python 跳过项：2 个需显式启用的真实 OS 独立验收，2 个未配置真实 PostgreSQL/LLM 的集成测试，2 个当前环境已安装 build/mypy 的缺失模块用例。常规真实 OS 沙箱测试通过。
- 真实 SDK 配合 MockTransport 验证 Responses、Chat Completions 的图片请求；包括纯图、图文、运行中补充、恢复和图片回答。
- 真实 Electron 组件验收 14 个断言通过：`tmp/image-composer-qqiG4q/result.json`。

## 便携版验收

构建：`release/BitAgent-2026-10-05T08-24-52-422Z/Bit Agent.exe`。保留整个发布目录。

正式 exe 验收通过：`tmp/packaged-acceptance-2yxGLU/result.json` 的 `passed`、`imageInput.nativeCtrlV` 均为 `true`。

- 实测系统剪贴板 Ctrl+V、文件选择、预览、删除、纯图片发送、图文续聊、历史重开和图片实际解码。
- 两轮使用不同 PNG；SDK 图片 URL 与对应附件字节完全一致，每条消息恰好一个图片块，历史图片来源及顺序正确。
- 启动、对话、审批、Markdown、仓库、工作区选择、图片草稿、图片历史，共 32 个明暗主题及两种窗口宽度布局通过，已查看最终截图。
- 运行使用独立临时数据和本地模拟模型；在线模型实际识图效果尚未验收。剪贴板的原有多格式内容在测试后恢复。

## 本轮新增或修改文件行数

仅列本次图片功能涉及的文件，不将仓库原有其他未提交文件列入。为遵守项目限制，原先超限的 HTTP、运行、交互、存储和验收文件按既有职责拆分，保留旧调用及测试补丁入口。

生产源码 75 个，最大 255 行；Python 与 TypeScript AST 检查函数不超过 40 行、控制流程嵌套不超过 3 层。测试和验收脚本按项目规则不受源文件行数限制。

| 文件（相对仓库根目录） | 行数 |
| --- | ---: |
| `apps/desktop/src/shared/image-input.ts` | 58 |
| `apps/desktop/src/shared/contracts.ts` | 182 |
| `apps/desktop/src/main/application/task-input.ts` | 28 |
| `apps/desktop/src/main/application/task-interaction-input.ts` | 25 |
| `apps/desktop/src/main/transport/task-ipc.ts` | 50 |
| `apps/desktop/src/renderer/attachments/file-input.ts` | 32 |
| `apps/desktop/src/renderer/attachments/composer-images.ts` | 137 |
| `apps/desktop/src/renderer/attachments/message-images.ts` | 51 |
| `apps/desktop/src/renderer/attachments/attachments.css` | 28 |
| `apps/desktop/src/renderer/application/message.ts` | 24 |
| `apps/desktop/src/renderer/application/context.ts` | 158 |
| `apps/desktop/src/renderer/application/state.ts` | 151 |
| `apps/desktop/src/renderer/application/run.ts` | 70 |
| `apps/desktop/src/renderer/application/run-submit.ts` | 78 |
| `apps/desktop/src/renderer/application/run-restore.ts` | 121 |
| `apps/desktop/src/renderer/application/composer.ts` | 130 |
| `apps/desktop/src/renderer/application/queue.ts` | 56 |
| `apps/desktop/src/renderer/main.ts` | 194 |
| `apps/desktop/src/renderer/interaction/controller.ts` | 207 |
| `apps/desktop/src/renderer/previous-turns.ts` | 133 |
| `apps/desktop/src/renderer/session-view.ts` | 36 |
| `apps/desktop/src/renderer/stream-view.ts` | 231 |
| `apps/gateway/src/domain/image-input.ts` | 43 |
| `apps/gateway/src/domain/protocol.ts` | 86 |
| `apps/gateway/src/infrastructure/persistence/memory-task-store.ts` | 173 |
| `apps/gateway/src/infrastructure/runtime/local-task-store.ts` | 255 |
| `apps/gateway/src/transport/http/app.ts` | 37 |
| `apps/gateway/src/transport/http/security.ts` | 36 |
| `apps/gateway/src/transport/http/runtime-routes.ts` | 25 |
| `apps/gateway/src/transport/http/session-routes.ts` | 28 |
| `apps/gateway/src/transport/http/configuration-routes.ts` | 25 |
| `apps/gateway/src/transport/http/change-routes.ts` | 24 |
| `apps/gateway/src/transport/http/task-routes.ts` | 46 |
| `apps/gateway/src/transport/http/task-events.ts` | 41 |
| `services/agent/src/bit_agent/agent/runtime.py` | 98 |
| `services/agent/src/bit_agent/agent/run_setup.py` | 112 |
| `services/agent/src/bit_agent/agent/run_protocol.py` | 151 |
| `services/agent/src/bit_agent/agent/run_state.py` | 82 |
| `services/agent/src/bit_agent/agent/run_events.py` | 109 |
| `services/agent/src/bit_agent/agent/run_input.py` | 63 |
| `services/agent/src/bit_agent/agent/run_tools.py` | 135 |
| `services/agent/src/bit_agent/agent/run_model.py` | 217 |
| `services/agent/src/bit_agent/agent/run_completion.py` | 127 |
| `services/agent/src/bit_agent/runtime/application/service.py` | 97 |
| `services/agent/src/bit_agent/runtime/application/service_protocol.py` | 52 |
| `services/agent/src/bit_agent/runtime/application/task_submission.py` | 141 |
| `services/agent/src/bit_agent/runtime/application/task_execution.py` | 107 |
| `services/agent/src/bit_agent/runtime/application/task_run_configuration.py` | 136 |
| `services/agent/src/bit_agent/runtime/application/task_observation.py` | 148 |
| `services/agent/src/bit_agent/runtime/application/session_commands.py` | 93 |
| `services/agent/src/bit_agent/runtime/application/change_commands.py` | 145 |
| `services/agent/src/bit_agent/runtime/application/model_commands.py` | 93 |
| `services/agent/src/bit_agent/runtime/application/interaction.py` | 197 |
| `services/agent/src/bit_agent/runtime/application/interaction_requests.py` | 149 |
| `services/agent/src/bit_agent/runtime/application/interaction_questions.py` | 68 |
| `services/agent/src/bit_agent/runtime/application/acceptance.py` | 136 |
| `services/agent/src/bit_agent/runtime/application/acceptance_input.py` | 31 |
| `services/agent/src/bit_agent/runtime/application/acceptance_provider.py` | 155 |
| `services/agent/src/bit_agent/runtime/transport/rpc.py` | 108 |
| `services/agent/src/bit_agent/images/__init__.py` | 12 |
| `services/agent/src/bit_agent/images/content.py` | 31 |
| `services/agent/src/bit_agent/images/validation.py` | 73 |
| `services/agent/src/bit_agent/images/gif.py` | 35 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage.py` | 95 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_database.py` | 64 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_tasks.py` | 134 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_sessions.py` | 118 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_context.py` | 147 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_migration.py` | 83 |
| `services/agent/src/bit_agent/runtime/infrastructure/storage_events.py` | 80 |
| `services/agent/src/bit_agent/context/multimodal.py` | 37 |
| `services/agent/src/bit_agent/context/serialization.py` | 51 |
| `services/agent/src/bit_agent/context/summarizer.py` | 237 |
| `services/agent/src/bit_agent/context/summary_sources.py` | 27 |
| `services/agent/src/bit_agent/llm/text.py` | 43 |
| `apps/desktop/test/image-composer.fixture.ts` | 101 |
| `apps/desktop/test/image-composer.acceptance.cjs` | 19 |
| `apps/desktop/test/accept-image-composer.mjs` | 30 |
| `apps/desktop/test/image-file-input.test.ts` | 51 |
| `apps/desktop/test/image-input.test.ts` | 52 |
| `apps/desktop/test/image-message-flows.test.ts` | 191 |
| `apps/desktop/test/task-image-ipc.test.ts` | 42 |
| `apps/desktop/test/task-input-images.test.ts` | 49 |
| `apps/desktop/test/image-input-packaged.mjs` | 140 |
| `apps/gateway/test/image-protocol.test.ts` | 128 |
| `services/agent/tests/test_image_context_storage.py` | 182 |
| `services/agent/tests/test_image_inputs.py` | 122 |
| `services/agent/tests/test_image_sdk.py` | 361 |
| `services/agent/tests/test_independent_acceptance.py` | 773 |
| `scripts/accept-packaged.mjs` | 670 |
