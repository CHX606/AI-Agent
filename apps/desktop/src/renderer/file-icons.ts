/** 文件树和标签页用的文件类型图标：参照 VS Code Seti 主题，用彩色小字标出类型。 */

interface FileIcon { glyph: string; color: string }

const ICONS: Record<string, FileIcon> = {
  py: { glyph: "py", color: "#4b8bbe" }, pyi: { glyph: "py", color: "#4b8bbe" },
  ts: { glyph: "TS", color: "#3178c6" }, tsx: { glyph: "TS", color: "#3178c6" }, mts: { glyph: "TS", color: "#3178c6" }, cts: { glyph: "TS", color: "#3178c6" },
  js: { glyph: "JS", color: "#c9a906" }, mjs: { glyph: "JS", color: "#c9a906" }, cjs: { glyph: "JS", color: "#c9a906" }, jsx: { glyph: "JS", color: "#c9a906" },
  json: { glyph: "{}", color: "#c49a1a" }, jsonc: { glyph: "{}", color: "#c49a1a" },
  md: { glyph: "M↓", color: "#519aba" }, markdown: { glyph: "M↓", color: "#519aba" },
  html: { glyph: "<>", color: "#e37933" }, htm: { glyph: "<>", color: "#e37933" }, vue: { glyph: "V", color: "#41b883" },
  xml: { glyph: "<>", color: "#8dc149" }, svg: { glyph: "<>", color: "#a074c4" },
  css: { glyph: "#", color: "#519aba" }, scss: { glyph: "#", color: "#f55385" }, less: { glyph: "#", color: "#519aba" },
  go: { glyph: "go", color: "#00add8" }, rs: { glyph: "rs", color: "#dea584" }, java: { glyph: "J", color: "#cc3e44" },
  kt: { glyph: "K", color: "#a97bff" }, c: { glyph: "C", color: "#519aba" }, h: { glyph: "h", color: "#a074c4" },
  cpp: { glyph: "C+", color: "#519aba" }, cc: { glyph: "C+", color: "#519aba" }, hpp: { glyph: "h", color: "#a074c4" },
  cs: { glyph: "C#", color: "#7e57c2" }, sql: { glyph: "db", color: "#f55385" },
  sh: { glyph: ">_", color: "#6a9955" }, bash: { glyph: ">_", color: "#6a9955" }, ps1: { glyph: ">_", color: "#3e8ed0" },
  yml: { glyph: "≡", color: "#a074c4" }, yaml: { glyph: "≡", color: "#a074c4" },
  toml: { glyph: "⚙", color: "#7f8c8d" }, ini: { glyph: "⚙", color: "#7f8c8d" }, cfg: { glyph: "⚙", color: "#7f8c8d" },
  env: { glyph: "⚙", color: "#c9a906" }, lock: { glyph: "≡", color: "#7f8c8d" },
  txt: { glyph: "≡", color: "#8b8b8b" }, log: { glyph: "≡", color: "#8b8b8b" },
  png: { glyph: "▣", color: "#a074c4" }, jpg: { glyph: "▣", color: "#a074c4" }, jpeg: { glyph: "▣", color: "#a074c4" }, gif: { glyph: "▣", color: "#a074c4" },
};
const DEFAULT_ICON: FileIcon = { glyph: "≡", color: "#8b8b8b" };

export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return { glyph: "D", color: "#0db7ed" };
  if (lower.startsWith(".git")) return { glyph: "⎇", color: "#e44d26" };
  if (lower.startsWith(".env")) return ICONS.env!;
  if (lower.startsWith("readme")) return { glyph: "ⓘ", color: "#519aba" };
  const extension = lower.includes(".") ? lower.split(".").pop()! : "";
  return ICONS[extension] ?? DEFAULT_ICON;
}

/** 生成图标元素：彩色小字，宽度固定，文件树和标签页共用。 */
export function fileIconElement(name: string): HTMLSpanElement {
  const { glyph, color } = fileIcon(name);
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.style.color = color;
  icon.textContent = glyph;
  return icon;
}
