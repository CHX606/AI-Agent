# Desktop：你看到的桌面窗口

这里是 Bit Agent 的 Electron 客户端。它提供选项目、发任务、看事件和结果、浏览目录及预览文本的界面。

真正的 Agent 任务由 Gateway 和 Python AgentRuntime 执行，窗口是操作入口之一。

## 目录和文件怎么分工

| 位置 | 大白话解释 |
| --- | --- |
| `src/main/main.ts` | 装配实现，并向 IPC 注入接口。 |
| `src/main/application/` | 任务输入规则与 Gateway、文件、运行服务等端口。 |
| `src/main/transport/electron.ts` | 窗口、生命周期、IPC 和事件转发。 |
| `src/main/transport/preload.cts` | 给页面提供一小组受控接口。 |
| `src/main/infrastructure/persistence/` | 文件预览、主题与执行设置保存。 |
| `src/main/infrastructure/gateway/` | HTTP 客户端实现。 |
| `src/main/infrastructure/runtime/` | 受管子进程和模型设置。 |
| `src/main/infrastructure/observability/` | 日志与诊断包导出。 |
| `src/renderer/main.ts` | 处理页面按钮、目录树、任务和事件交互。 |
| `src/renderer/styles.css` | 控制页面外观。 |
| `src/renderer/presentation.ts` | 把任务数据整理成适合显示的内容。 |
| `src/renderer/markdown.ts` | 处理 Markdown 文本呈现。 |
| `src/shared` | 两边使用的数据约定和 Gateway 地址规则。 |
| `renderer/index.html` | 页面结构入口。 |
| `test` | 桌面相关模块测试。 |
| `dist` | 构建结果，存在时由构建命令管理。 |

主进程能处理必要的本机能力；页面进程通过 preload 调用允许的接口。它们分开，是为了控制页面能做什么。

IPC 通过端口调用适配器，具体实现只在 `main.ts` 装配。执行 `pnpm architecture:check` 可检查依赖边界，详见 [架构说明](../../docs/ARCHITECTURE.md)。

## 从项目根目录运行

```powershell
pnpm desktop:dev
```

这会先构建，再启动 Electron。只构建用 `pnpm desktop:build`。

构建会重新生成 `dist`，不要把需要保留的手工修改放在这个目录里。界面源码在 `src` 和 `renderer/index.html`。

## 和 .electron-cache 的区别

这里保存的是我们写的客户端代码。`.electron-cache` 保存安装过程中下载的 Electron 运行环境，两者承担不同工作。

详细使用方法见 [Desktop / CLI 说明](../../docs/CLI_DESKTOP.md)。
