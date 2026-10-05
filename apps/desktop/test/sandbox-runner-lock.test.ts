import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { acquireSandboxLock } from "../../../scripts/sandbox-runner/lock";
import { brokerErrorMarker } from "../../../scripts/sandbox-runner/marker";

const pipe = () => `\\\\.\\pipe\\bit-agent-lock-test-${randomUUID()}`;

it.runIf(process.platform === "win32")("lets only one holder run until the previous one releases", async () => {
  const name = pipe();
  const releaseFirst = await acquireSandboxLock(new AbortController().signal, name);
  let secondAcquired = false;
  const second = acquireSandboxLock(new AbortController().signal, name).then(release => {
    secondAcquired = true;
    return release;
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(secondAcquired).toBe(false);
  await releaseFirst();
  const releaseSecond = await second;
  expect(secondAcquired).toBe(true);
  await releaseSecond();
});

it.runIf(process.platform === "win32")("stops waiting when the run is cancelled", async () => {
  const name = pipe();
  const release = await acquireSandboxLock(new AbortController().signal, name);
  const controller = new AbortController();
  const waiting = acquireSandboxLock(controller.signal, name);
  controller.abort(new Error("cancelled while queued"));
  await expect(waiting).rejects.toThrow("cancelled while queued");
  await release();
});

it("only puts a well-formed caller nonce into the broker error marker", () => {
  const nonce = "0123456789abcdef".repeat(2);
  expect(brokerErrorMarker(nonce)).toBe(`BIT_AGENT_SANDBOX_START_ERROR[${nonce}]: `);
  expect(brokerErrorMarker(undefined)).toBe("BIT_AGENT_SANDBOX_START_ERROR[]: ");
  expect(brokerErrorMarker("]: forged")).toBe("BIT_AGENT_SANDBOX_START_ERROR[]: ");
});
