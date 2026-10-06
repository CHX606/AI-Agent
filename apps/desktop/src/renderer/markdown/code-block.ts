import { copyButton } from "../copy-button";
import { highlight, languageFor } from "../syntax-highlight";

const aliases: Record<string, string> = {
  python: "py", javascript: "js", typescript: "ts", shell: "sh", powershell: "ps1", pwsh: "ps1",
  csharp: "cs", "c#": "cs", "c++": "cpp", kotlin: "kt", rust: "rs", markdown: "md",
};

function appendTokens(code: HTMLElement, source: string, name: string): void {
  const language = languageFor(name === "dockerfile" || name === "makefile" ? name : `snippet.${aliases[name] ?? name}`);
  for (const token of highlight(source, language)) {
    if (!token.kind) { code.append(document.createTextNode(token.text)); continue; }
    const span = document.createElement("span");
    span.className = `tok-${token.kind}`;
    span.textContent = token.text;
    code.append(span);
  }
}

function appendDiff(code: HTMLElement, source: string): void {
  for (const line of source.split(/(?<=\n)/u)) {
    const row = document.createElement("span");
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : "context";
    row.className = `diff-${kind}`;
    row.textContent = line;
    code.append(row);
  }
}

export function decorateCodeBlock(pre: HTMLPreElement): void {
  const code = pre.querySelector("code");
  if (!code) return;
  const name = /\blanguage-([^\s]+)/u.exec(code.className)?.[1] ?? "";
  const source = code.textContent ?? "";
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";
  // 标题栏：左边语言名，右边复制按钮；按钮不浮在代码上，不会和边框或代码重叠。
  const header = document.createElement("div");
  header.className = "code-header";
  const label = document.createElement("span");
  label.className = "code-language";
  label.textContent = name;
  header.append(label, copyButton(() => source, "复制代码", "code-copy"));
  wrapper.append(header);
  code.replaceChildren();
  if (name.toLowerCase() === "diff" || name.toLowerCase() === "patch") appendDiff(code, source);
  else appendTokens(code, source, name.toLowerCase());
  pre.replaceWith(wrapper);
  wrapper.append(pre);
}
