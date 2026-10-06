/** 带行号和语法高亮的差异表格；文件内容只作为文字插入，不会变成页面代码。 */
import { highlight, languageFor, type Language } from "../syntax-highlight";
import { parseUnifiedDiff, splitRows, type DiffRow } from "./model";
import "./diff.css";

export type DiffMode = "unified" | "split";
const SIGNS: Record<string, string> = { add: "+", remove: "−", context: " " };

function cell(className: string, text = ""): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

function codeCell(row: DiffRow | null, language: Language | null): HTMLTableCellElement {
  const td = cell("diff-code");
  if (!row) { td.dataset.empty = "true"; return td; }
  td.dataset.kind = row.kind;
  for (const token of highlight(row.text, language)) {
    if (!token.kind) { td.append(document.createTextNode(token.text)); continue; }
    const span = document.createElement("span");
    span.className = `tok-${token.kind}`;
    span.textContent = token.text;
    td.append(span);
  }
  return td;
}

function lineNumber(value: number | null, kind?: string): HTMLTableCellElement {
  const td = cell("diff-num", value === null ? "" : String(value));
  if (kind) td.dataset.kind = kind;
  return td;
}

function bannerRow(kind: "hunk" | "note", text: string, span: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "diff-banner";
  tr.dataset.kind = kind;
  const td = cell("diff-banner-text", text);
  td.colSpan = span;
  tr.append(td);
  return tr;
}

function unifiedRows(rows: DiffRow[], language: Language | null): HTMLTableRowElement[] {
  return rows.map(row => {
    if (row.kind === "hunk" || row.kind === "note") return bannerRow(row.kind, row.text, 4);
    const tr = document.createElement("tr");
    tr.dataset.kind = row.kind;
    tr.append(lineNumber(row.oldLine), lineNumber(row.newLine), cell("diff-sign", SIGNS[row.kind]),
      codeCell(row, language));
    return tr;
  });
}

function splitTableRows(rows: DiffRow[], language: Language | null): HTMLTableRowElement[] {
  return splitRows(rows).map(row => {
    if (row.kind !== "pair") return bannerRow(row.kind, row.text, 4);
    const tr = document.createElement("tr");
    tr.append(lineNumber(row.left?.oldLine ?? null, row.left?.kind), codeCell(row.left, language),
      lineNumber(row.right?.newLine ?? null, row.right?.kind), codeCell(row.right, language));
    return tr;
  });
}

export function renderDiffTable(path: string, diff: string, mode: DiffMode): HTMLElement {
  const rows = parseUnifiedDiff(diff);
  const language = languageFor(path);
  const scroller = document.createElement("div");
  scroller.className = "diff-view";
  scroller.dataset.mode = mode;
  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", `${path} 的文件差异`);
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  body.append(...(mode === "split" ? splitTableRows(rows, language) : unifiedRows(rows, language)));
  table.append(body);
  scroller.append(table);
  return scroller;
}
