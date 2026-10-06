import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));
// 假的系统加密：可逆、但磁盘上看不到明文。
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${[...value].reverse().join("")}`),
    decryptString: (value: Buffer) => [...value.toString().slice(4)].reverse().join(""),
  },
}));
vi.mock("@bit-agent/diagnostics", () => ({ registerSecret: vi.fn() }));

import { mcpServerList, resolveMcpServers, writeMcpServers } from "../src/main/infrastructure/runtime/mcp-settings";

beforeEach(() => { state.userData = mkdtempSync(join(tmpdir(), "mcp-settings-")); });
afterEach(() => { rmSync(state.userData, { recursive: true, force: true }); });

const http = { name: "gh", type: "http" as const, url: "https://api.example.com/mcp", enabled: true, auto_approve: false };

it("encrypts http headers, lists only their names and reuses them when not resent", () => {
  const first = resolveMcpServers([{ ...http, headers: { Authorization: "Bearer secret-token" } }]);
  expect(first.plain[0]?.headers).toEqual({ Authorization: "Bearer secret-token" });
  writeMcpServers(first.encrypted);
  expect(readFileSync(join(state.userData, "mcp-servers.json"), "utf8")).not.toContain("secret-token");
  expect(mcpServerList()).toEqual([{ ...http, envKeys: [], headerKeys: ["Authorization"] }]);

  // 页面回传的是列表里的样子（只有 headerKeys），保存时沿用已加密的值。
  const again = resolveMcpServers(mcpServerList());
  expect(again.plain[0]).toEqual({ ...http, headers: { Authorization: "Bearer secret-token" } });
});

it("does not carry secrets across a change between stdio and http", () => {
  writeMcpServers(resolveMcpServers([{ name: "gh", type: "stdio", command: "x", env: { TOKEN: "t" } }]).encrypted);
  const switched = resolveMcpServers([http]);
  expect(switched.plain[0]?.headers).toEqual({});
  expect(switched.plain[0]).not.toHaveProperty("env");
});
