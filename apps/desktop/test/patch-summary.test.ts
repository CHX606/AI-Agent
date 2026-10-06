import { describe, expect, it, vi } from "vitest";
import { mergePatchSummaries, patchDiffSummary, patchPaths } from "../src/renderer/stream/patch-summary";

describe("patch statistics", () => {
  it("uses the complete structured paths, rather than a truncated display target", () => {
    expect(patchPaths({ affected_paths: ["a,b.py", "space name.py"] })).toEqual({ paths: ["a,b.py", "space name.py"] });
    expect(patchPaths({ affected_paths: ["ok.py", 3] })).toBeUndefined();
    expect(patchPaths({ operation: { target: "a.py, b.py" } })).toBeUndefined();
  });

  it("counts actual removed lines for a whole-file deletion", () => {
    const diff = "--- before/obsolete.py\n+++ after/obsolete.py\n@@ -1,2 +0,0 @@\n-old one\n-old two\n";
    expect(patchDiffSummary([{ path: "obsolete.py", diff }])).toEqual({ paths: ["obsolete.py"], added: 0, removed: 2 });
  });

  it("counts body lines beginning with plus and minus signs without counting file headers or context", () => {
    const diff = "--- before/a.py\n+++ after/a.py\n@@ -1,2 +1,2 @@\n---old\n+++new\n context\n";
    expect(patchDiffSummary([{ path: "a.py", diff }])).toEqual({ paths: ["a.py"], added: 1, removed: 1 });
  });

  it("accumulates multiple hunks and files", () => {
    const files = [
      { path: "a.py", diff: "@@ -1 +1 @@\n-old\n+new\n@@ -8,0 +9,2 @@\n+one\n+two\n" },
      { path: "b.py", diff: "@@ -1,0 +1 @@\n+three\n" },
    ];
    expect(patchDiffSummary(files)).toEqual({ paths: ["a.py", "b.py"], added: 4, removed: 1 });
  });

  it("retains file identities without presenting a truncated diff as a complete total", () => {
    expect(patchDiffSummary([{ path: "large.py", diff: "@@ -0,0 +1 @@\n+one", truncated: true },
      { path: "small.py", diff: "@@ -0,0 +1 @@\n+two" }])).toEqual({ paths: ["large.py", "small.py"] });
  });

  it.each(["Win32", "Linux x86_64"])("deduplicates case according to the host filesystem on %s", platform => {
    vi.stubGlobal("navigator", { platform });
    try {
      const changes = [{ paths: ["src/app.py"], added: 1, removed: 0 }, { paths: ["SRC/App.py"], added: 1, removed: 0 }];
      expect(mergePatchSummaries(changes)).toEqual({
        text: `修改了 ${platform === "Win32" ? 1 : 2} 个文件`, result: "+2 −0",
      });
    } finally { vi.unstubAllGlobals(); }
  });
});
