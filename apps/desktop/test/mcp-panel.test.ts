import { expect, it } from "vitest";

import { describeServer, parseArgs, parseEnv } from "../src/renderer/mcp-format.js";

it("splits arguments by line and ignores blanks", () => {
  expect(parseArgs("-y\r\n\n  @scope/server  \n")).toEqual(["-y", "@scope/server"]);
});

it("parses KEY=VALUE lines and keeps '=' inside values", () => {
  expect(parseEnv("TOKEN=a=b\n\nOTHER=")).toEqual({ TOKEN: "a=b", OTHER: "" });
  expect(() => parseEnv("not a pair")).toThrow("KEY=VALUE");
  expect(() => parseEnv("1BAD=x")).toThrow("KEY=VALUE");
});

it("describes stdio and http servers", () => {
  expect(describeServer({ name: "a", type: "stdio", command: "npx", args: ["-y", "x"], enabled: true, auto_approve: false }))
    .toBe("npx -y x");
  expect(describeServer({ name: "b", type: "http", url: "https://x.test/mcp", enabled: true, auto_approve: false }))
    .toBe("https://x.test/mcp");
});
