import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileIcon, folderIcon } from "../src/renderer/file-icons";

describe("offline Material Icon Theme", () => {
  it.each([
    ["app.py", "python"], ["src/main.pyi", "python"],
    ["index.ts", "typescript"], ["App.tsx", "react_ts"], ["App.jsx", "react"],
    ["main.go", "go"], ["main.rs", "rust"], ["Main.java", "java"],
    ["index.html", "html"], ["styles.css", "css"], ["config.yaml", "yaml"],
    ["Dockerfile", "docker"], [".env", "tune"], [".env.example", "tune"],
    ["README.md", "readme"], ["package.json", "nodejs"],
    ["pnpm-lock.yaml", "pnpm"], ["Cargo.lock", "lock"], [".gitignore", "git"],
    ["unknown.unrecognized", "file"], ["no_extension", "file"],
  ])("resolves %s to a complete SVG", (name, id) => {
    const icon = fileIcon(name);
    expect(icon.id).toBe(id);
    expect(icon.svg).toContain("<svg");
    expect(icon.svg).toContain("viewBox=");
    expect(icon.svg).toContain("<path");
  });

  it("resolves case-insensitive filenames and Windows paths", () => {
    expect(fileIcon("C:\\project\\APP.TSX").id).toBe("react_ts");
    expect(fileIcon("C:\\project\\README.MD").id).toBe("readme");
  });

  it("keeps unknown files distinct from known languages", () => {
    expect(fileIcon("unknown").svg).not.toBe(fileIcon("main.py").svg);
    expect(fileIcon("unknown").svg).not.toBe(fileIcon("main.ts").svg);
  });

  it.each(["src", "tests", ".git", "unknown-folder"])("uses distinct closed and expanded %s directory SVGs", (name) => {
    const closed = folderIcon(name);
    const expanded = folderIcon(name, true);
    expect(closed.id).not.toBe(expanded.id);
    expect(closed.svg).toContain("<svg");
    expect(expanded.svg).toContain("<svg");
    expect(closed.svg).not.toBe(expanded.svg);
  });

  it("provides every SVG referenced by the vendored theme", () => {
    const theme = JSON.parse(readFileSync(new URL("../src/renderer/repository/material-icons/theme.json", import.meta.url), "utf8"));
    for (const id of Object.keys(theme.manifest.iconDefinitions)) {
      expect(theme.icons[id], id).toContain("<svg");
    }
    expect(folderIcon("unknown-folder").id).toBe("folder");
    expect(folderIcon("unknown-folder", true).id).toBe("folder-open");
  });
});
