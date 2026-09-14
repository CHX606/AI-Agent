import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listRepositoryDirectory,
  readRepositoryFile,
  validateRepositoryWorkspace,
} from "../src/main/infrastructure/persistence/repository";

describe("repository browser filesystem boundary", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "bit-agent-repository-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { force: true, recursive: true });
  });

  it("lists directories first and hides protected entries", async () => {
    await mkdir(join(workspaceRoot, "src"));
    await mkdir(join(workspaceRoot, "node_modules"));
    await writeFile(join(workspaceRoot, "b.py"), "print('b')\n", "utf8");
    await writeFile(join(workspaceRoot, "a.txt"), "a\n", "utf8");
    await writeFile(join(workspaceRoot, ".env"), "TOKEN=secret\n", "utf8");
    await writeFile(join(workspaceRoot, "private.pem"), "secret\n", "utf8");

    const result = await listRepositoryDirectory({ workspaceRoot, path: "" });

    expect(result.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["directory", "src"],
      ["file", "a.txt"],
      ["file", "b.py"],
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reads UTF-8 files and returns preview metadata", async () => {
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "hello.ts"), "export const hello = '你好';\n", "utf8");

    const result = await readRepositoryFile({ workspaceRoot, path: "src/hello.ts" });

    expect(result.content).toContain("你好");
    expect(result.path).toBe("src/hello.ts");
    expect(result.size).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("rejects traversal and protected paths", async () => {
    await writeFile(join(workspaceRoot, ".env"), "TOKEN=secret\n", "utf8");

    await expect(
      listRepositoryDirectory({ workspaceRoot, path: "../" }),
    ).rejects.toThrow("路径不能包含 ..");
    await expect(
      readRepositoryFile({ workspaceRoot, path: ".env" }),
    ).rejects.toThrow("禁止访问受保护的文件或目录");
  });

  it("rejects binary files and bounds large previews", async () => {
    await writeFile(join(workspaceRoot, "binary.dat"), Buffer.from([1, 0, 2, 3]));
    await writeFile(join(workspaceRoot, "large.txt"), Buffer.alloc(1_000_005, 97));

    await expect(
      readRepositoryFile({ workspaceRoot, path: "binary.dat" }),
    ).rejects.toThrow("暂不支持预览二进制文件");
    const large = await readRepositoryFile({ workspaceRoot, path: "large.txt" });
    expect(large.content).toHaveLength(1_000_000);
    expect(large.truncated).toBe(true);
  });

  it("requires an existing absolute directory as workspace", async () => {
    await expect(validateRepositoryWorkspace("relative/path")).rejects.toThrow(
      "工作区必须是绝对路径",
    );
    await expect(validateRepositoryWorkspace(join(workspaceRoot, "missing"))).rejects.toThrow();
  });
});
