export interface FileDiff { path: string; diff: string; truncated?: boolean }
const PREVIEW_LINES = 14;

function diffRow(line: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove"
    : line.startsWith("@@") ? "diff-hunk" : "diff-context";
  row.textContent = line;
  return row;
}

function moreButton(rows: HTMLElement[]): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "diff-more";
  button.textContent = `… 展开其余 ${rows.length} 行`;
  button.addEventListener("click", () => {
    for (const row of rows) row.hidden = false;
    button.remove();
  });
  return button;
}

export function renderDiff(container: HTMLElement, files: FileDiff[]): void {
  container.replaceChildren();
  let shown = 0;
  const hidden: HTMLElement[] = [];
  for (const file of files) {
    const header = document.createElement("div");
    header.className = "diff-file";
    header.textContent = file.path;
    container.append(header);
    for (const line of file.diff.split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++") || !line) continue;
      const row = diffRow(line);
      if (shown >= PREVIEW_LINES) { row.hidden = true; hidden.push(row); }
      shown += 1;
      container.append(row);
    }
  }
  if (hidden.length) container.append(moreButton(hidden));
  container.hidden = shown === 0;
}
