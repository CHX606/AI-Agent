import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("GET /health", () => {
  it("returns the Gateway health information", async () => {
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        service: "repopilot-gateway",
        version: "0.1.0",
      });
    } finally {
      await app.close();
    }
  });
});