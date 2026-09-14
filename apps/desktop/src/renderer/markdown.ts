function appendInline(parent: HTMLElement, text: string): void {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/gu;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(text.slice(cursor, index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    }
    cursor = index + token.length;
  }

  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function appendCodeBlock(container: HTMLElement, language: string, source: string): void {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";

  if (language) {
    const label = document.createElement("span");
    label.className = "code-language";
    label.textContent = language;
    wrapper.append(label);
  }

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const isDiff = language.toLowerCase() === "diff";
  if (isDiff) {
    for (const line of source.split("\n")) {
      const row = document.createElement("span");
      row.className = line.startsWith("+")
        ? "diff-add"
        : line.startsWith("-")
          ? "diff-remove"
          : line.startsWith("@@")
            ? "diff-hunk"
            : "diff-context";
      row.textContent = `${line}\n`;
      code.append(row);
    }
  } else {
    code.textContent = source;
  }
  pre.append(code);
  wrapper.append(pre);
  container.append(wrapper);
}

export function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let listKind: "ul" | "ol" | null = null;
  let codeLanguage: string | null = null;
  let codeLines: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const element = document.createElement("p");
    appendInline(element, paragraph.join(" "));
    container.append(element);
    paragraph = [];
  };

  const closeList = (): void => {
    list = null;
    listKind = null;
  };

  for (const line of lines) {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/u);
    if (fence) {
      if (codeLanguage !== null) {
        appendCodeBlock(container, codeLanguage, codeLines.join("\n"));
        codeLanguage = null;
        codeLines = [];
      } else {
        flushParagraph();
        closeList();
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }

    if (codeLanguage !== null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 2;
      const element = document.createElement(`h${level}`) as HTMLHeadingElement;
      appendInline(element, heading[2] ?? "");
      container.append(element);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    if (unordered || ordered) {
      flushParagraph();
      const kind = unordered ? "ul" : "ol";
      if (!list || listKind !== kind) {
        list = document.createElement(kind);
        listKind = kind;
        container.append(list);
      }
      const item = document.createElement("li");
      appendInline(item, (unordered?.[1] ?? ordered?.[1]) || "");
      list.append(item);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/u);
    if (quote) {
      flushParagraph();
      closeList();
      const element = document.createElement("blockquote");
      appendInline(element, quote[1] ?? "");
      container.append(element);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (codeLanguage !== null) appendCodeBlock(container, codeLanguage, codeLines.join("\n"));
  flushParagraph();
}
