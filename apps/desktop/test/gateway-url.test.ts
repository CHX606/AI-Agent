import { describe, expect, it } from "vitest";

import { normalizeGatewayUrl } from "../src/shared/gateway-url.js";

describe("normalizeGatewayUrl", () => {
  it("accepts local http and removes paths", () => {
    expect(normalizeGatewayUrl("http://127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000");
  });

  it("requires https for remote hosts", () => {
    expect(() => normalizeGatewayUrl("http://example.com")).toThrow("必须使用 https");
    expect(normalizeGatewayUrl("https://agent.example.com/api")).toBe(
      "https://agent.example.com",
    );
  });
});
