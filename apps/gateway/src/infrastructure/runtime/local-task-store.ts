import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { CreateTaskBody, TaskEvent, TaskRecord, TaskInteractionBody } from "../../domain/protocol.js";
import type { CancellationResult, TaskStore } from "../../application/ports/task-store.js";
import { publicError, type DiagnosticPort } from "@bit-agent/diagnostics";
import { gatewayDiagnostics } from "../observability/diagnostics.js";

function projectDirectory(): string {
  if (process.env.BIT_AGENT_PROJECT_ROOT) return process.env.BIT_AGENT_PROJECT_ROOT;
  let directory = import.meta.dirname;
  while (true) {
    if (existsSync(join(directory, "services", "agent", "src", "bit_agent"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("找不到 Python Agent，请设置 BIT_AGENT_PROJECT_ROOT");
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
  fields: Record<string, unknown>;
  started: number;
}

/** Gateway 只传请求和结果，不参与模型、压缩历史或保存数据库的具体操作。 */
export class LocalTaskStore implements TaskStore {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private stopped = false;
  private closing = false;

  private constructor(private readonly diagnostics: DiagnosticPort) {
    const root = projectDirectory();
    const localPython = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const python = process.env.BIT_AGENT_PYTHON
      ?? (existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");
    this.child = spawn(python, ["-u", "-m", "bit_agent.runtime"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: [join(root, "services", "agent", "src"), process.env.PYTHONPATH]
          .filter(Boolean).join(delimiter),
      },
    });
    this.child.stderr.on("data", (chunk: Buffer) => diagnostics.record("warn", "python_stderr", {
      bytes: chunk.length,
      error_type: chunk.toString().match(/\b([A-Za-z]+(?:Error|Exception)):/u)?.[1],
    }));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as { id: number; result?: unknown; error?: { message?: string; status_code?: number; diagnostic_id?: string } };
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) {
          diagnostics.record(response.error.status_code && response.error.status_code < 500 ? "warn" : "error", "rpc_response_failed", {
            ...pending.fields, status_code: response.error.status_code, diagnostic_id: response.error.diagnostic_id,
            duration_ms: performance.now() - pending.started,
          });
          pending.reject(Object.assign(new Error(response.error.message ?? "本地执行服务返回错误"), {
          statusCode: response.error.status_code ?? 500,
          diagnostic_id: response.error.diagnostic_id,
        })); }
        else pending.resolve(response.result);
      } catch (error) {
        const id = diagnostics.failure("rpc_protocol_failed", error);
        this.fail(Object.assign(new Error(publicError(id)), { diagnostic_id: id }));
        this.child.kill();
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      diagnostics.record(this.closing && code === 0 ? "info" : "error", "python_exit", {
        exit_code: code, signal, reason: this.closing ? "shutdown" : "unexpected",
      });
      this.fail(new Error("本地执行服务已经退出"));
    });
  }

  static async connect(diagnostics: DiagnosticPort = gatewayDiagnostics): Promise<LocalTaskStore> {
    const store = new LocalTaskStore(diagnostics);
    try {
      await store.call("health");
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private fail(error: Error): void {
    this.stopped = true;
    const id = this.closing ? undefined : this.diagnostics.failure("python_unavailable", error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (id) this.diagnostics.record("error", "rpc_interrupted", { ...pending.fields, diagnostic_id: id });
      pending.reject(id ? Object.assign(new Error(publicError(id, "本地运行服务已退出，请重新启动应用")), { diagnostic_id: id }) : error);
    }
    this.pending.clear();
  }

  async health(): Promise<"ready" | "unavailable" | "stopped"> {
    if (this.stopped) return "stopped";
    try {
      await this.call("health", {}, 3_000);
      return "ready";
    } catch {
      return this.stopped ? "stopped" : "unavailable";
    }
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("本地执行服务不可用，请重新启动 Gateway"));
    const id = ++this.sequence;
    const fields = { rpc_id: String(id), operation: method, task_id: params.task_id,
      session_id: params.session_id };
    const started = performance.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("RPC timeout");
        const diagnostic_id = this.diagnostics.failure("rpc_timeout", error, { ...fields, timeout_ms: timeoutMs,
          duration_ms: performance.now() - started });
        reject(Object.assign(new Error(publicError(diagnostic_id, "本地服务响应超时，请先检查会话列表，避免重复提交")), { diagnostic_id }));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, fields, started });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  getChanges(taskId: string): Promise<Record<string, unknown>> {
    return this.call("get_changes", { task_id: taskId });
  }

  diagnosticSnapshot(taskId?: string): Promise<Record<string, unknown>> {
    return this.call("diagnostic_snapshot", taskId ? { task_id: taskId } : {});
  }

  reviewChange(taskId: string, changeId: string, action: string): Promise<Record<string, unknown>> {
    return this.call("review_change", { task_id: taskId, change_id: changeId, action });
  }

  configureModel(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("configure_model", { input });
  }

  createTask(input: CreateTaskBody): Promise<TaskRecord> {
    return this.call("create_task", { input });
  }

  getTask(taskId: string): Promise<TaskRecord | null> {
    return this.call("get_task", { task_id: taskId });
  }

  requestCancellation(taskId: string): Promise<CancellationResult> {
    return this.call("cancel_task", { task_id: taskId });
  }

  interactTask(taskId: string, input: TaskInteractionBody): Promise<TaskRecord> {
    return this.call("interact_task", { task_id: taskId, input });
  }

  readEvents(taskId: string, afterId: string, blockMs: number): Promise<TaskEvent[]> {
    return this.call("read_events", { task_id: taskId, after_id: afterId, block_ms: blockMs });
  }

  listSessions(offset = 0): Promise<Record<string, unknown>> {
    return this.call("list_sessions", { offset });
  }

  getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.call("get_session", { session_id: sessionId });
  }

  setSessionMode(sessionId: string, mode: string): Promise<Record<string, unknown> | null> {
    return this.call("set_mode", { session_id: sessionId, mode });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 30_000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      // 关闭管道让 Python 先保存最后状态；它不会因为用户关窗口而删除会话。
      this.child.stdin.end();
    });
    this.fail(new Error("Gateway 已关闭"));
  }
}
