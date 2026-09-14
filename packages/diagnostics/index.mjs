import pino from "pino";
import { createStream } from "rotating-file-stream";
import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, lstatSync, unlinkSync, appendFileSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// The allowlist is the shared transport boundary. Bodies, headers, messages and raw stacks
// never reach a sink, even if a caller accidentally passes a complete error/request.
const fields = new Set(`time level process pid version session_id task_id tool_call_id run_id agent_id
diagnostic_id request_id provider_request_id operation event status status_code error_code error_type
error_description duration_ms retry_count timeout_ms phase phase_since last_activity elapsed_ms
streamed bytes exit_code signal reason method route frames count dropped available cause_type
rpc_id event_id sequence timestamp terminal source`.split(/\s+/u));
const secrets = new Set();
export function registerSecret(value) { if (typeof value === "string" && value.length >= 4) secrets.add(value); }
export function redact(value) {
  let text = String(value);
  const activeSecrets = [...secrets, ...Object.entries(process.env)
    .filter(([key]) => /key|token|secret|password/iu.test(key)).map(([, val]) => val)];
  for (const secret of activeSecrets) if (secret && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[\w-]+/gu, "[REDACTED]")
    .replace(/(?:https?:\/\/)[^\s]+/giu, "[URL]")
    .replace(/[A-Z]:[\\/][^\s]+/giu, "[PATH]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[EMAIL]")
    .replace(/(?:api[_-]?key|authorization|password|token)\s*[=:]\s*[^\s,;}]+/giu, "[REDACTED]")
    .slice(0, 512);
}
export function safeFields(input) {
  if (!input || typeof input !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!fields.has(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") result[key] = value;
    else if (typeof value === "string") result[key] = redact(value);
    else if (key === "frames" && Array.isArray(value)) result[key] = value.slice(-12).map(v => redact(String(v)));
  }
  return result;
}
export function diagnosticId(error) {
  if (error && /^D-[a-f0-9]{16}$/u.test(error.diagnostic_id ?? "")) return error.diagnostic_id;
  const id = `D-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try { if (error && typeof error === "object") error.diagnostic_id = id; } catch { /* frozen exception */ }
  return id;
}
export function publicError(id, message = "操作未完成，请查看日志与诊断") { return `${message}（诊断编号：${id}）`; }
export function errorFields(error) {
  // Capture locations only. Error.message/stack's first line may contain entire request bodies.
  const frames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 13)
    .map(line => line.replace(/.*[\\/]/u, "").trim()) : [];
  return safeFields({ error_type: error?.name ?? typeof error, error_code: error?.code,
    status_code: error?.statusCode, cause_type: error?.cause?.name, frames });
}
export function defaultLogDirectory() {
  return process.env.BIT_AGENT_LOG_DIR ?? join(process.env.BIT_AGENT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "BitAgent", "runtime"), "logs");
}
export function createDiagnostics(options) {
  const directory = options.directory ?? defaultLogDirectory();
  const processName = options.process;
  if (!["electron", "gateway", "python"].includes(processName)) throw new Error("Invalid diagnostic process");
  const location = join(directory, processName);
  let stream;
  let available = true;
  let dropped = 0;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 4;
  const retention = (options.retentionDays ?? 7) * 86400000;
  const prune = () => {
    try {
      for (const name of readdirSync(location)) {
        if (!/^(?:current|[0-9-]+)\.jsonl$/u.test(name)) continue;
        const file = join(location, name);
        if (lstatSync(file).isFile() && Date.now() - lstatSync(file).mtimeMs > retention) unlinkSync(file);
      }
    } catch { available = false; }
  };
  try {
    mkdirSync(location, { recursive: true });
    prune();
    stream = createStream((time, index) => time ? `${time.getTime()}-${index}.jsonl` : "current.jsonl", {
      path: location, size: `${maxBytes}B`, interval: "1d", maxFiles: maxFiles - 1,
      maxSize: `${maxBytes * (maxFiles - 1)}B`, history: "rotation.history", immutable: false,
    });
    stream.on("error", () => { available = false; });
    stream.on("warning", () => { available = false; });
    stream.on("rotated", prune);
  } catch { available = false; }
  // Never forward a raw Pino record. Even framework logging passes through this projection.
  const destination = { write(line) {
    try {
      if (!stream || stream.destroyed || stream.writableLength > 256 * 1024) { dropped++; return; }
      const record = JSON.parse(line);
      const clean = safeFields(record);
      clean.event ??= "framework";
      if (record.err) Object.assign(clean, safeFields(record.err));
      stream.write(JSON.stringify(clean) + "\n");
    } catch { available = false; }
  } };
  const logger = pino({ level: "info", base: { process: processName, pid: process.pid,
    version: options.version ?? process.env.BIT_AGENT_VERSION ?? "0.1.0",
    session_id: null, task_id: null, tool_call_id: null },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label.toUpperCase() }) },
    serializers: { err: errorFields, req: () => undefined, res: () => undefined },
  }, destination);
  return {
    directory, logger, available: () => available && dropped === 0,
    record(level, event, values = {}) {
      try {
        if (level === "fatal") {
          appendFileSync(join(location, "current.jsonl"), JSON.stringify({ time: new Date().toISOString(),
            level: "FATAL", process: processName, pid: process.pid, version: options.version ?? process.env.BIT_AGENT_VERSION ?? "0.1.0",
            session_id: null, task_id: null, tool_call_id: null, ...safeFields(values), event }) + "\n");
        } else logger[level]({ ...safeFields(values), event });
      } catch { available = false; }
    },
    failure(event, error, values = {}) {
      const id = diagnosticId(error);
      this.record("error", event, { ...errorFields(error), ...values, diagnostic_id: id });
      return id;
    },
    async flush() {
      if (!stream || stream.destroyed) return;
      await new Promise(resolve => { try { stream.write("", () => resolve()); } catch { resolve(); } });
    },
    async close() {
      if (!stream || stream.destroyed) return;
      await new Promise(resolve => { stream.once("error", resolve); stream.end(resolve); });
    },
  };
}
export function installProcessDiagnostics(service) {
  // Monitor does not swallow fatal exceptions or change Node's exit behavior.
  process.on("uncaughtExceptionMonitor", error => service.record("fatal", "process_uncaught", {
    ...errorFields(error), diagnostic_id: diagnosticId(error),
  }));
  process.on("warning", warning => service.record("warn", "process_warning", errorFields(warning)));
}
export async function exportDiagnostics({ directory, destination, version, snapshot, unavailable = false }) {
  const zip = new AdmZip();
  const id = diagnosticId();
  const skipped = [];
  let count = 0;
  let remaining = 48 * 1024 * 1024;
  for (const processName of ["electron", "gateway", "python"]) {
    const folder = join(directory, processName);
    try {
      if (lstatSync(folder).isSymbolicLink()) { skipped.push(processName); continue; }
      for (const name of readdirSync(folder).sort()) {
        if (!/^(?:current\.jsonl(?:\.\d+)?|[0-9-]+\.jsonl)$/u.test(name)) continue;
        const path = join(folder, name);
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > remaining) { skipped.push(`${processName}/${name}`); continue; }
          remaining -= stat.size;
          const lines = (await readFile(path, "utf8")).split("\n").flatMap(line => {
            try { const record = safeFields(JSON.parse(line)); return record.time ? [JSON.stringify(record)] : []; }
            catch { return []; } // partial final write / non-JSON / legacy text is excluded
          });
          zip.addFile(`logs/${processName}/${basename(name)}`, Buffer.from(lines.join("\n") + "\n")); count++;
        } catch { skipped.push(`${processName}/${name}`); }
      }
    } catch { skipped.push(processName); }
  }
  const project = value => Array.isArray(value) ? value.slice(0, 1000).map(project)
    : value && typeof value === "object" ? { ...safeFields(value),
      ...Object.fromEntries(["tasks", "events"].filter(key => Array.isArray(value[key])).map(key => [key, project(value[key])])) } : undefined;
  zip.addFile("runtime.json", Buffer.from(JSON.stringify(project(snapshot) ?? {}, null, 2)));
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({ schema: 1, diagnostic_id: id,
    created_at: new Date().toISOString(), version: redact(version), platform: process.platform,
    runtime_unavailable: unavailable, skipped, files: count,
    excluded: ["API keys", "headers", "prompts", "transcript", "database", "user files", "crash dumps"],
  }, null, 2)));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, zip.toBuffer(), { flag: "wx" }); await rename(temporary, destination); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { path: destination, files: count, diagnostic_id: id };
}
