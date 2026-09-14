import { afterEach, expect, test, vi } from "vitest";
import { watchTaskStream } from "../src/main/transport/task-event-stream.js";
import type { TaskEvent } from "../src/shared/contracts.js";

afterEach(() => vi.useRealTimers());

const request = { gatewayUrl: "http://127.0.0.1:3000", taskId: "existing-task" };
const diagnostics = { record() {}, failure: () => "D-1234567890abcdef" };
const eventResponse = (id: string) => new Response(`id: ${id}\nevent: MODEL_TEXT_DELTA\ndata: {"text":"saved event"}\n\n`, {
  headers: { "content-type": "text/event-stream" },
});
const healthResponse = (state: "ready" | "unavailable" | "stopped") => Response.json({
  service: "bit-agent-gateway", runtime_status: state, restart_required: state === "stopped",
}, { status: state === "ready" ? 200 : 503 });
const states = (events: TaskEvent[]) => events.filter(event => event.event_type === "desktop_connection_state").map(event => event.data);

test("confirmed runtime exit ends the watcher with an explicit restart requirement", async () => {
  const events: TaskEvent[] = [];
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse("7-0"))
    .mockResolvedValueOnce(healthResponse("stopped"));
  const requestJson = vi.fn().mockRejectedValue(new Error("runtime stopped"));
  await watchTaskStream(request, { signal: new AbortController().signal, diagnostics, transport,
    managedHeaders: () => ({ authorization: "Bearer local-test" }), requestJson,
    emit: event => events.push(event), isActive: () => true, managedStopped: () => false });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]?.[0]).toBe(`${request.gatewayUrl}/health`);
  expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer local-test" });
  expect(states(events)).toEqual([
    { connected: true, resumed: false },
    expect.objectContaining({ connected: false, restart_required: true, message: expect.stringContaining("重新启动应用") }),
  ]);
  expect(events.some(event => event.event_type === "desktop_stream_ended")).toBe(false);
});

test.each(["ready", "unavailable", "unreachable"] as const)("a %s health probe keeps transient reconnects and the saved event cursor", async (health) => {
  vi.useFakeTimers();
  const events: TaskEvent[] = [];
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse("7-0"));
  if (health === "unreachable") transport.mockRejectedValueOnce(new Error("temporary disconnect"));
  else transport.mockResolvedValueOnce(healthResponse(health));
  transport.mockResolvedValueOnce(eventResponse("8-0"));
  const requestJson = vi.fn().mockResolvedValueOnce({ status: "RUNNING" }).mockResolvedValueOnce({ status: "COMPLETED" });
  const watching = watchTaskStream(request, { signal: new AbortController().signal, diagnostics, transport,
    managedHeaders: () => ({}), requestJson, emit: event => events.push(event),
    isActive: () => true, managedStopped: () => false });
  await vi.advanceTimersByTimeAsync(0);
  expect(states(events)).toContainEqual(expect.objectContaining({ connected: false, restart_required: false }));
  expect(transport).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  await watching;
  expect(transport.mock.calls[2]?.[0]).toBe(`${request.gatewayUrl}/v1/tasks/existing-task/events?after=7-0`);
  expect(events.filter(event => event.id !== null).map(event => event.id)).toEqual(["7-0", "8-0"]);
  expect(states(events).at(-1)).toEqual({ connected: true, resumed: true });
  expect(events.at(-1)?.event_type).toBe("desktop_stream_ended");
  expect(requestJson.mock.calls.every(([, path]) => path === "/v1/tasks/existing-task")).toBe(true);
});

test("a confirmed managed Gateway exit does not retry an unreachable port", async () => {
  const events: TaskEvent[] = [];
  const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));
  await watchTaskStream(request, { signal: new AbortController().signal, diagnostics, transport,
    managedHeaders: () => ({}), requestJson: vi.fn(), emit: event => events.push(event),
    isActive: () => true, managedStopped: () => true });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(states(events)).toEqual([expect.objectContaining({ connected: false, restart_required: true })]);
});

test("unwatch during transient backoff aborts without another connection", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("connection interrupted"))
    .mockResolvedValueOnce(healthResponse("unavailable"));
  const watching = watchTaskStream(request, { signal: controller.signal, diagnostics, transport,
    managedHeaders: () => ({}), requestJson: vi.fn(), emit: () => {},
    isActive: () => true, managedStopped: () => false });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await watching;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(transport).toHaveBeenCalledTimes(2);
});
