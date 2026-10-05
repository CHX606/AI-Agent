/// <reference types="vite/client" />
/** Offline SVG assets and associations from Material Icon Theme 5.39.0 (MIT). */
import themeText from "./repository/material-icons/theme.json?raw";

interface Associations {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}
interface IconTheme {
  manifest: Associations & { light: Partial<Associations> };
  icons: Record<string, string>;
}
export interface FileIcon { id: string; svg: string }
const theme = JSON.parse(themeText) as IconTheme;

function basename(path: string): string {
  return path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

function association(name: string, light: boolean): string {
  const { manifest } = theme;
  const named = (light ? manifest.light.fileNames?.[name] : undefined) ?? manifest.fileNames[name];
  if (named) return named;
  const parts = name.split(".");
  for (let index = 1; index < parts.length; index += 1) {
    const extension = parts.slice(index).join(".");
    const found = (light ? manifest.light.fileExtensions?.[extension] : undefined) ?? manifest.fileExtensions[extension];
    if (found) return found;
  }
  if (name.startsWith(".env.")) return manifest.fileExtensions.env ?? manifest.file;
  return manifest.file;
}

function asset(id: string, fallback: string): FileIcon {
  const resolved = theme.icons[id] ? id : fallback;
  return { id: resolved, svg: theme.icons[resolved]! };
}

export function fileIcon(name: string): FileIcon {
  return asset(association(basename(name), false), theme.manifest.file);
}

function directoryIcon(name: string, expanded: boolean, light: boolean): FileIcon {
  const { manifest } = theme;
  const key = expanded ? "folderNamesExpanded" : "folderNames";
  const directory = basename(name);
  const selected = (light ? manifest.light[key]?.[directory] : undefined) ?? manifest[key][directory];
  const fallback = expanded ? manifest.folderExpanded : manifest.folder;
  return asset(selected ?? fallback, fallback);
}

export function folderIcon(name: string, expanded = false): FileIcon {
  return directoryIcon(name, expanded, false);
}

function imageFor(icon: FileIcon, className: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.src = `data:image/svg+xml,${encodeURIComponent(icon.svg)}`;
  image.alt = "";
  image.draggable = false;
  image.width = image.height = 16;
  return image;
}

function iconElement(primary: FileIcon, light: FileIcon): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.dataset.icon = primary.id;
  icon.setAttribute("aria-hidden", "true");
  icon.append(imageFor(primary, "file-icon-default"));
  if (light.id !== primary.id) {
    icon.classList.add("has-light-icon");
    icon.append(imageFor(light, "file-icon-light"));
  }
  return icon;
}

export function fileIconElement(name: string): HTMLSpanElement {
  return iconElement(fileIcon(name), asset(association(basename(name), true), theme.manifest.file));
}

export function folderIconElement(name: string, expanded = false): HTMLSpanElement {
  return iconElement(folderIcon(name, expanded), directoryIcon(name, expanded, true));
}
