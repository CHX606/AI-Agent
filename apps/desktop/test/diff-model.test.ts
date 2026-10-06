import { describe, expect, it } from "vitest";
import { diffStats, parseUnifiedDiff, splitRows } from "../src/renderer/diff/model";

const sample = [
  "--- before/app.py",
  "+++ after/app.py",
  "@@ -3,4 +3,5 @@ def main():",
  " keep = 1",
  "-old = 2",
  "-gone = 3",
  "+new = 2",
  "",
  "+added = 4",
  " tail = 5",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("unified diff model", () => {
  it("numbers old and new lines and skips file headers", () => {
    const rows = parseUnifiedDiff(sample);
    expect(rows.map(row => [row.kind, row.oldLine, row.newLine, row.text])).toEqual([
      ["hunk", null, null, "@@ -3,4 +3,5 @@ def main():"],
      ["context", 3, 3, "keep = 1"],
      ["remove", 4, null, "old = 2"],
      ["remove", 5, null, "gone = 3"],
      ["add", null, 4, "new = 2"],
      ["context", 6, 5, ""],
      ["add", null, 6, "added = 4"],
      ["context", 7, 7, "tail = 5"],
      ["note", null, null, "No newline at end of file"],
    ]);
    expect(diffStats(rows)).toEqual({ added: 2, removed: 2 });
  });

  it("treats lines that start with -- or ++ inside a hunk as content, not headers", () => {
    const rows = parseUnifiedDiff("@@ -1,2 +1,2 @@\n--- SQL comment\n+++ counter\n-x\n+y\n");
    expect(rows.slice(1).map(row => [row.kind, row.text])).toEqual([
      ["remove", "-- SQL comment"], ["add", "++ counter"], ["remove", "x"], ["add", "y"],
    ]);
  });

  it("handles a new file and multiple hunks", () => {
    const rows = parseUnifiedDiff("@@ -0,0 +1 @@\n+print('hi')\n@@ -10 +11 @@\n-a\n+b\n");
    expect(rows.map(row => [row.kind, row.oldLine, row.newLine])).toEqual([
      ["hunk", null, null], ["add", null, 1], ["hunk", null, null], ["remove", 10, null], ["add", null, 11],
    ]);
  });

  it("pairs removals with following additions for the split view", () => {
    const split = splitRows(parseUnifiedDiff(sample));
    const shape = split.map(row => row.kind === "pair"
      ? [row.left?.text ?? null, row.right?.text ?? null] : [row.kind]);
    expect(shape).toEqual([
      ["hunk"],
      ["keep = 1", "keep = 1"],
      ["old = 2", "new = 2"],
      ["gone = 3", null],
      ["", ""],
      [null, "added = 4"],
      ["tail = 5", "tail = 5"],
      ["note"],
    ]);
  });
});
