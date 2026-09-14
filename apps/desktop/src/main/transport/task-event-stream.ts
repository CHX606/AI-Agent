import { publicError, type DiagnosticPort } from "@bit-agent/diagnostics";
import type { TaskEvent, TaskRequestInput } from "../../shared/contracts.js";
import type { GatewayClientPort } from "../application/ports.js";

interface StreamOptions {
  signal: AbortSignal;
  diagnostics: DiagnosticPort;
  managedHeaders(url: string): Record<string, string>;
  requestJson: GatewayClientPort["request"];
  emit(event: TaskEvent): void;
  isActive(): boolean;
  managedStopped(): boolean;
  transport?: typeof fetch;
}

async function runtimeRestartRequired(gatewayUrl: string, signal: AbortSignal,
  headers: StreamOptions["managedHeaders"], transport: typeof fetch,
  managedStopped: () => boolean): Promise<boolean> {
  if (managedStopped()) return true;
  try {
    const response = await transport(`${gatewayUrl}/health`, {
      headers: { accept: "application/json", ...headers(gatewayUrl) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    const health: unknown = await response.json();
    return response.status === 503 && !!health && typeof health === "object"
      && "service" in health && health.service === "bit-agent-gateway"
      && "runtime_status" in health && health.runtime_status === "stopped"
      && "restart_required" in health && health.restart_required === true;
  } catch {
    // A failed probe alone cannot distinguish a transient disconnect from a stopped service.
    return managedStopped();
  }
}

function parseEventBlock(block: string): TaskEvent | null {
  let id: string | null = null;
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join("\n");
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData) as unknown;
  } catch {
    // 非 JSON 的第三方 SSE 数据仍然原样展示。
  }
  return { id, event_type: eventType, data };
}

/** Resume event delivery only; task creation and task execution are never replayed here. */
export async function watchTaskStream(request: TaskRequestInput, options: StreamOptions): Promise<void> {
  const { signal, diagnostics, managedHeaders, requestJson, emit, isActive, managedStopped } = options;
  const transport = options.transport ?? fetch;
  let cursor = "0-0";
  let attempts = 0;
  const send = (eventType: string, data: unknown) => {
    if (isActive() && !signal.aborted) emit({
      taskId: request.taskId, id: null, event_type: eventType, data,
    } satisfies TaskEvent);
  };
  while (!signal.aborted && isActive()) {
    try {
      const response = await transport(
        `${request.gatewayUrl}/v1/tasks/${encodeURIComponent(request.taskId)}/events?after=${cursor}`,
        { headers: { accept: "text/event-stream", ...managedHeaders(request.gatewayUrl) }, signal },
      );
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      send("desktop_connection_state", { connected: true, resumed: attempts > 0 });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          // 即便 TCP 没断，也不能无限等待一个不再发心跳的连接。
          let timer: ReturnType<typeof setTimeout> | undefined;
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("事件流心跳超时")), 15_000); }),
          ]).finally(() => clearTimeout(timer));
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > 2_000_000) throw new Error("事件流消息过大");
          const blocks = buffer.split(/\r?\n\r?\n/u);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const event = parseEventBlock(block);
            if (event?.id && /^[0-9]+-[0-9]+$/u.test(event.id)) cursor = event.id;
            if (event && isActive() && !signal.aborted) {
              emit({ ...event, taskId: request.taskId });
            }
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (signal.aborted) break;
      const task = await requestJson(request.gatewayUrl, `/v1/tasks/${encodeURIComponent(request.taskId)}`, { signal });
      if (["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(String(task.status))) {
        send("desktop_stream_ended", { task_id: request.taskId });
        return;
      }
      throw new Error("连接提前结束");
    } catch (error) {
      if (signal.aborted) break;
      const restartRequired = await runtimeRestartRequired(request.gatewayUrl, signal, managedHeaders, transport, managedStopped);
      if (signal.aborted || !isActive()) break;
      attempts += 1;
      const id = diagnostics.failure("desktop_sse_interrupted", error, { task_id: request.taskId, retry_count: attempts });
      send("desktop_connection_state", { connected: false, restart_required: restartRequired,
        diagnostic_id: id, message: publicError(id, restartRequired
          ? "本地执行服务已退出，请重新启动应用" : "连接暂时中断，正在尝试恢复") });
      if (restartRequired) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.min(10_000, 500 * 2 ** Math.min(attempts, 5)));
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
