# Gateway：接收任务的服务

这是用 TypeScript 写的 HTTP 服务。默认通过本地 RPC 把任务交给 Python AgentRuntime，由 SQLite 保存；Redis/Worker 链路需要显式选择。

Gateway 还负责查询状态、处理取消请求，以及把执行事件通过 SSE 转发给客户端。

## 文件怎么分工

| 文件或目录 | 作用 |
| --- | --- |
| `src/index.ts`、`src/bootstrap.ts` | 启动与适配器装配入口。 |
| `src/transport/http/app.ts` | Fastify 路由与 SSE，只依赖接口。 |
| `src/domain/protocol.ts` | 任务字段、状态和校验。 |
| `src/application/ports/task-store.ts` | 任务操作接口。 |
| `src/infrastructure/runtime/local-task-store.ts` | Python 子进程与 RPC 适配器。 |
| `src/infrastructure/persistence/` | Redis 与测试内存适配器。 |
| `src/infrastructure/observability/` | Gateway 日志适配器。 |
| `test` | 接口和存储测试。 |
| `package.json` | 依赖和启动、测试、构建脚本。 |
| `tsconfig.json` | TypeScript 编译配置。 |
| `vitest.config.ts` | 测试工具配置。 |

HTTP 层不创建存储，装配入口负责选择实现。`buildApp` 提供测试默认值，`createHttpApp` 必须接收接口依赖。分层规则见 [架构说明](../../docs/ARCHITECTURE.md)。

## 从项目根目录运行

```powershell
pnpm --dir apps/gateway dev
```

`dev` 会监视源码变化；`start` 直接启动；`build` 运行 TypeScript 编译；`test` 执行测试；当前 `lint` 和 `typecheck` 都调用 TypeScript 的类型检查。

默认本地模式不需要 Redis。默认监听 `http://127.0.0.1:3000`。

接口与启动顺序见 [Gateway / Worker 说明](../../docs/GATEWAY_WORKER.md)。
