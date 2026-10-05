import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "renderer"),
  plugins: [{
    name: "bit-agent-shell-partials",
    transformIndexHtml(html) {
      return html.replace(/<!-- bit-agent:(profile|inspector) -->/gu, (_marker, name: string) =>
        readFileSync(resolve(import.meta.dirname, "renderer", "partials", `${name}.html`), "utf8"));
    },
  }],
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
  },
});
