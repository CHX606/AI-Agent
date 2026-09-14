import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import { describe, expect, it } from "vitest";

import { RedisTaskStore } from "../src/infrastructure/persistence/redis-task-store.js";

const redisUrl = process.env.BIT_AGENT_TEST_TASK_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;

integration("RedisTaskStore integration", () => {
  it("shares queue, state, cancellation, and events with the Worker protocol", async () => {
    const url = redisUrl!;
    const namespace = `bit-agent:test:${randomUUID()}`;
    const queueKey = `${namespace}:queue`;
    const store = await RedisTaskStore.connect(url, {
      keyPrefix: namespace,
      queueKey,
      taskTtlSeconds: 60,
    });
    const client = createClient({ url });
    await client.connect();

    try {
      const task = await store.createTask({
        objective: "检查任务协议",
        workspace_root: "D:\\workspace",
      });
      const queued = await client.lPop(queueKey);
      expect(JSON.parse(queued ?? "{}").task_id).toBe(task.task_id);

      await client.hSet(`${namespace}:${task.task_id}`, {
        status: "RUNNING",
        updated_at: new Date().toISOString(),
      });
      const cancellation = await store.requestCancellation(task.task_id);
      expect(cancellation.changed).toBe(true);
      expect(cancellation.task?.status).toBe("CANCELLATION_REQUESTED");

      const event = {
        trace_id: "trace-1",
        run_id: "run-1",
        sequence: 1,
        event_type: "AGENT_STARTED",
      };
      await client.xAdd(`${namespace}:${task.task_id}:events`, "*", {
        event: JSON.stringify(event),
      });
      const events = await store.readEvents(task.task_id, "0-0", 1);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe("AGENT_STARTED");
      expect(events[0]?.data).toEqual(event);
    } finally {
      const keys = await client.keys(`${namespace}:*`);
      if (keys.length > 0) {
        await client.del(keys);
      }
      await Promise.all([client.close(), store.close()]);
    }
  });
});
