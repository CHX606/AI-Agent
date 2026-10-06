import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1];
if (!content) throw new Error("生产页面缺少内容安全策略");
const policy = Object.fromEntries(content.split(";").map(directive => {
  const [name, ...sources] = directive.trim().split(/\s+/u);
  return [name, sources];
}));

describe("production Markdown content security policy", () => {
  it("allows web images while preserving existing local and data image sources", () => {
    expect(policy["img-src"]).toEqual(["'self'", "data:", "http:", "https:"]);
  });

  it("keeps scripts, styles, connections and default sources restricted", () => {
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'"]);
    expect(policy["style-src"]).toEqual(["'self'"]);
    expect(policy["connect-src"]).toEqual(["data:"]);
    expect(Object.keys(policy).sort()).toEqual(["connect-src", "default-src", "img-src", "script-src", "style-src"]);
  });
});
