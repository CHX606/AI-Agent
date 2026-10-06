import { connect } from "node:net";

/** 常见前端/后端开发服务器端口：Vite、Next/React、Angular、Django/FastAPI、Flask 等。 */
export const COMMON_DEV_PORTS = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888];

function listening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 只连本机回环地址，不发任何数据；返回正在监听的端口。 */
export async function detectLocalServers(ports = COMMON_DEV_PORTS, timeoutMs = 300): Promise<number[]> {
  const results = await Promise.all(ports.map(async (port) => ((await listening(port, timeoutMs)) ? port : null)));
  return results.filter((port): port is number => port !== null);
}
