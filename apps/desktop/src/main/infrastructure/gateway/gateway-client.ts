import { diagnosticId, publicError, type DiagnosticPort } from "@bit-agent/diagnostics";
import { normalizeGatewayUrl } from "../../../shared/gateway-url.js";

import type { GatewayClientPort } from "../../application/ports.js";

export class GatewayClient implements GatewayClientPort {
  constructor(private readonly diagnostics: DiagnosticPort,
    private readonly headers: (url: string) => Record<string, string>,
    private readonly transport: typeof fetch = fetch) {}

  async request(gatewayUrl: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const started = performance.now();
    const request_id = diagnosticId();
    const parts = path.split("/");
    const fields = { request_id, task_id: parts[2] === "tasks" ? parts[3] : undefined,
      session_id: parts[2] === "sessions" ? parts[3] : undefined, method: init?.method ?? "GET" };
    try {
      const base = normalizeGatewayUrl(gatewayUrl);
      const timeout = AbortSignal.timeout(30_000);
      const response = await this.transport(`${base}${path}`, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        headers: { accept: "application/json", ...this.headers(base),
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...init?.headers, "x-request-id": request_id },
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = new Error("Gateway error");
        const id = payload && typeof payload === "object" && "diagnostic_id" in payload
          && /^D-[a-f0-9]{16}$/u.test(String(payload.diagnostic_id)) ? payload.diagnostic_id : diagnosticId(error);
        throw Object.assign(error, { diagnostic_id: id, statusCode: response.status });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid JSON object");
      return payload as Record<string, unknown>;
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      const id = this.diagnostics.failure("gateway_request_failed", error, { ...fields,
        duration_ms: performance.now() - started, timeout_ms: 30_000 });
      throw Object.assign(new Error(publicError(id, "请求未完成，请检查本地运行服务")), { diagnostic_id: id });
    }
  }
}
