import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// 官方 SDK 把所有授权挂在同一个沙箱账户上，两次运行重叠时能互相读写对方的工作区。
// 同一时间只允许一个运行；命名管道随进程退出自动释放，不会留下失效的锁。
export const sandboxLockName = "\\\\.\\pipe\\bit-agent-os-sandbox";
const retryMilliseconds = 200;

function listen(name: string): Promise<Server | null> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(name, () => { server.unref(); resolve(server); });
  });
}

export async function acquireSandboxLock(signal: AbortSignal, name = sandboxLockName): Promise<() => Promise<void>> {
  for (;;) {
    signal.throwIfAborted();
    const server = await listen(name);
    if (server) return () => new Promise<void>(resolve => { server.close(() => resolve()); });
    try {
      await delay(retryMilliseconds, undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
}
