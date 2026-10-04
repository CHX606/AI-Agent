/**
 * 仓库预览用的轻量语法高亮：按扩展名选语言，整份文本一次扫描（跨行的字符串和注释也正确），
 * 输出带类别的片段，颜色参照 VS Code 的 Light+ / Dark+。不依赖第三方库。
 */

export type TokenKind =
  | "comment" | "string" | "number" | "keyword" | "control" | "constant" | "function"
  | "type" | "property" | "decorator" | "variable" | "tag" | "attribute" | "heading" | "punctuation";

export interface Token { kind: TokenKind | null; text: string }

interface CodeLanguage {
  kind: "code";
  name: string;
  lineComments?: string[];
  blockComments?: [string, string][];
  /** 字符串定界符，长的在前（例如 """ 在 " 前面）。 */
  strings?: string[];
  keywords?: string[];
  control?: string[];
  constants?: string[];
  caseInsensitive?: boolean;
  /** @name 装饰器 / 注解 / CSS 的 @media。 */
  decorators?: boolean;
  /** $name 变量（Shell、PowerShell）。 */
  variables?: boolean;
  /** 紧跟在这个模式前的名字或字符串是“键”（JSON、YAML 的 key: / TOML 的 key =）。 */
  keyBefore?: RegExp;
  /** 名字里允许连字符（CSS 属性、YAML 键）。 */
  dashedNames?: boolean;
  /** 首字母大写的名字当作类型（大多数 C 系语言）。 */
  capitalizedTypes?: boolean;
  /** Python 的 f"..."、r'...' 这类字符串前缀。 */
  stringPrefixes?: RegExp;
}

interface OtherLanguage { kind: "markup" | "markdown"; name: string }
export type Language = CodeLanguage | OtherLanguage;

const C_COMMENTS = { lineComments: ["//"], blockComments: [["/*", "*/"]] as [string, string][] };
const TYPE_INTRO = new Set(["class", "struct", "interface", "enum", "trait", "type", "impl", "extends", "implements", "new", "namespace", "record"]);

const python: CodeLanguage = {
  kind: "code", name: "Python", lineComments: ["#"], strings: ['"""', "'''", '"', "'"], decorators: true,
  stringPrefixes: /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/u,
  keywords: ["def", "class", "lambda", "and", "or", "not", "in", "is", "global", "nonlocal", "del", "async", "self", "cls"],
  control: ["if", "elif", "else", "for", "while", "try", "except", "finally", "with", "as", "return", "yield", "raise", "import", "from", "pass", "break", "continue", "await", "assert", "match", "case"],
  constants: ["True", "False", "None", "NotImplemented", "Ellipsis"], capitalizedTypes: true,
};
const javascript: CodeLanguage = {
  kind: "code", name: "JavaScript", ...C_COMMENTS, strings: ['"', "'", "`"], decorators: true, capitalizedTypes: true,
  keywords: ["const", "let", "var", "function", "class", "extends", "new", "delete", "typeof", "instanceof", "in", "of", "this", "super", "async", "static", "get", "set", "void"],
  control: ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "throw", "try", "catch", "finally", "import", "export", "from", "await", "yield"],
  constants: ["true", "false", "null", "undefined", "NaN", "Infinity"],
};
const typescript: CodeLanguage = {
  ...javascript, name: "TypeScript",
  keywords: [...javascript.keywords!, "interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "declare", "namespace", "abstract", "keyof", "as", "satisfies", "is", "infer", "unique", "never", "unknown", "any", "string", "number", "boolean", "bigint", "symbol", "object"],
};
const go: CodeLanguage = {
  kind: "code", name: "Go", ...C_COMMENTS, strings: ['"', "`", "'"], capitalizedTypes: true,
  keywords: ["func", "package", "var", "const", "type", "struct", "interface", "map", "chan", "string", "int", "int64", "float64", "bool", "error", "byte", "rune", "any"],
  control: ["import", "return", "if", "else", "for", "range", "switch", "case", "default", "break", "continue", "go", "defer", "select", "fallthrough", "goto"],
  constants: ["true", "false", "nil", "iota"],
};
const rust: CodeLanguage = {
  kind: "code", name: "Rust", ...C_COMMENTS, strings: ['"'], capitalizedTypes: true, decorators: false,
  keywords: ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "mod", "crate", "self", "super", "as", "where", "move", "ref", "static", "const", "unsafe", "async", "dyn", "type", "use", "extern"],
  control: ["match", "if", "else", "loop", "while", "for", "in", "return", "break", "continue", "await"],
  constants: ["true", "false", "None", "Some", "Ok", "Err", "Self"],
};
const cLike = (name: string, keywords: string[], control: string[] = [], constants: string[] = []): CodeLanguage => ({
  kind: "code", name, ...C_COMMENTS, strings: ['"', "'"], decorators: true, capitalizedTypes: true,
  keywords: [...keywords, "class", "struct", "enum", "interface", "new", "this", "static", "const", "public", "private", "protected", "void", "int", "long", "float", "double", "char", "bool", "boolean", "byte", "short", "unsigned", "signed", "final", "abstract", "virtual", "override", "namespace", "using", "extends", "implements", "typedef", "sizeof", "auto", "var", "val", "fun", "object", "package"],
  control: [...control, "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "throw", "throws", "try", "catch", "finally", "import", "goto", "when", "is", "in", "as", "await", "yield"],
  constants: [...constants, "true", "false", "null", "nullptr", "NULL"],
});
const json: CodeLanguage = {
  kind: "code", name: "JSON", ...C_COMMENTS, strings: ['"'], constants: ["true", "false", "null"], keyBefore: /^\s*:/u,
};
const yaml: CodeLanguage = {
  kind: "code", name: "YAML", lineComments: ["#"], strings: ['"', "'"], dashedNames: true, keyBefore: /^\s*:(?:\s|$)/u,
  constants: ["true", "false", "null", "yes", "no", "on", "off", "True", "False", "Null", "~"],
};
const toml: CodeLanguage = {
  kind: "code", name: "TOML", lineComments: ["#", ";"], strings: ['"""', "'''", '"', "'"], dashedNames: true,
  keyBefore: /^\s*=/u, constants: ["true", "false"],
};
const css: CodeLanguage = {
  kind: "code", name: "CSS", blockComments: [["/*", "*/"]], strings: ['"', "'"], decorators: true, dashedNames: true,
  keyBefore: /^\s*:(?!:|[a-z-]+\s*[{,(])/u, constants: ["!important", "inherit", "initial", "none", "auto"],
};
const shell: CodeLanguage = {
  kind: "code", name: "Shell", lineComments: ["#"], strings: ['"', "'", "`"], variables: true,
  keywords: ["function", "local", "export", "readonly", "declare", "alias", "source", "echo", "set", "unset", "cd", "exit"],
  control: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "return", "shift"],
  constants: ["true", "false"],
};
const powershell: CodeLanguage = {
  kind: "code", name: "PowerShell", lineComments: ["#"], blockComments: [["<#", "#>"]], strings: ['"', "'"], variables: true, caseInsensitive: true,
  keywords: ["function", "param", "begin", "process", "end", "filter", "class", "enum"],
  control: ["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "return", "try", "catch", "finally", "throw", "break", "continue", "in", "exit"],
  constants: ["$true", "$false", "$null"],
};
const sql: CodeLanguage = {
  kind: "code", name: "SQL", lineComments: ["--"], blockComments: [["/*", "*/"]], strings: ["'", '"'], caseInsensitive: true,
  keywords: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "view", "drop", "alter", "add", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "as", "distinct", "union", "all", "and", "or", "not", "in", "is", "like", "between", "exists", "primary", "key", "foreign", "references", "default", "integer", "text", "varchar", "begin", "commit", "rollback"],
  control: ["case", "when", "then", "else", "end", "return", "if"],
  constants: ["null", "true", "false"],
};
const dockerfile: CodeLanguage = {
  ...shell, name: "Dockerfile", caseInsensitive: false,
  keywords: ["FROM", "RUN", "CMD", "COPY", "ADD", "ENV", "ARG", "WORKDIR", "EXPOSE", "ENTRYPOINT", "USER", "VOLUME", "LABEL", "HEALTHCHECK", "SHELL", "AS"],
};

const BY_EXTENSION: Record<string, Language> = {
  py: python, pyi: python, pyw: python,
  js: javascript, mjs: javascript, cjs: javascript, jsx: javascript,
  ts: typescript, tsx: typescript, mts: typescript, cts: typescript,
  go, rs: rust,
  java: cLike("Java", []), kt: cLike("Kotlin", []), kts: cLike("Kotlin", []),
  c: cLike("C", []), h: cLike("C", []), cpp: cLike("C++", ["template", "typename"]), cc: cLike("C++", ["template", "typename"]),
  cxx: cLike("C++", ["template", "typename"]), hpp: cLike("C++", ["template", "typename"]),
  cs: cLike("C#", ["readonly", "async", "partial", "sealed", "internal", "string", "decimal", "object"]),
  json, jsonc: json, json5: json,
  yml: yaml, yaml,
  toml, ini: toml, cfg: toml, conf: toml, env: toml, properties: toml,
  css, scss: css, less: css,
  sh: shell, bash: shell, zsh: shell,
  ps1: powershell, psm1: powershell, psd1: powershell,
  sql,
  html: { kind: "markup", name: "HTML" }, htm: { kind: "markup", name: "HTML" }, vue: { kind: "markup", name: "Vue" },
  xml: { kind: "markup", name: "XML" }, svg: { kind: "markup", name: "SVG" }, xaml: { kind: "markup", name: "XAML" },
  md: { kind: "markdown", name: "Markdown" }, markdown: { kind: "markdown", name: "Markdown" },
};

/** 按文件名选择语言；不认识的返回 null，按纯文本显示。 */
export function languageFor(path: string): Language | null {
  const name = path.replace(/\\/gu, "/").split("/").pop() ?? "";
  if (/^dockerfile/iu.test(name)) return dockerfile;
  if (/^makefile$/iu.test(name)) return { ...shell, name: "Makefile" };
  if (/^\.(env|gitignore|gitattributes|editorconfig)/iu.test(name)) return { ...toml, name: "配置" };
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return BY_EXTENSION[extension] ?? null;
}

class Output {
  readonly tokens: Token[] = [];
  private plain = "";
  push(kind: TokenKind | null, text: string): void {
    if (!text) return;
    if (kind === null) { this.plain += text; return; }
    this.flush();
    this.tokens.push({ kind, text });
  }
  flush(): Token[] {
    if (this.plain) this.tokens.push({ kind: null, text: this.plain });
    this.plain = "";
    return this.tokens;
  }
}

function stringEnd(text: string, start: number, delimiter: string, raw: boolean): number {
  let index = start + delimiter.length;
  const multiline = delimiter.length === 3 || delimiter === "`";
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\" && !raw) { index += 2; continue; }
    if (text.startsWith(delimiter, index)) return index + delimiter.length;
    // 没闭合的单行字符串到行尾为止，不把后面整份文件都染成字符串。
    if (char === "\n" && !multiline) return index;
    index += 1;
  }
  return text.length;
}

const NUMBER = /0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z%]*|\.\d+(?:[eE][+-]?\d+)?/uy;

function scanCode(text: string, language: CodeLanguage): Token[] {
  const out = new Output();
  const fold = (word: string) => language.caseInsensitive ? word.toLowerCase() : word;
  const sets = {
    keyword: new Set((language.keywords ?? []).map(fold)),
    control: new Set((language.control ?? []).map(fold)),
    constant: new Set((language.constants ?? []).map(fold)),
  };
  const word = language.dashedNames ? /[A-Za-z_$][\w$-]*/uy : /[A-Za-z_$][\w$]*/uy;
  let previous = "";
  let index = 0;
  scan: while (index < text.length) {
    const char = text[index]!;
    for (const marker of language.lineComments ?? []) {
      if (!text.startsWith(marker, index)) continue;
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      out.push("comment", text.slice(index, stop));
      index = stop;
      continue scan;
    }
    for (const [open, close] of language.blockComments ?? []) {
      if (!text.startsWith(open, index)) continue;
      const end = text.indexOf(close, index + open.length);
      const stop = end < 0 ? text.length : end + close.length;
      out.push("comment", text.slice(index, stop));
      index = stop;
      continue scan;
    }
    for (const delimiter of language.strings ?? []) {
      if (!text.startsWith(delimiter, index)) continue;
      const stop = stringEnd(text, index, delimiter, false);
      const key = language.keyBefore?.test(text.slice(stop, stop + 40));
      out.push(key ? "property" : "string", text.slice(index, stop));
      index = stop;
      continue scan;
    }
    const next = text[index + 1] ?? "";
    if (language.decorators && char === "@" && /[A-Za-z_]/u.test(next)) {
      const match = /@[\w.-]+/uy;
      match.lastIndex = index;
      const value = match.exec(text)![0];
      out.push("decorator", value);
      index += value.length;
      continue;
    }
    if (language.variables && char === "$" && /[\w{(]/u.test(next)) {
      const match = /\$(?:\{[^}\n]*\}|\([^)\n]*\)|\w+)/uy;
      match.lastIndex = index;
      const value = match.exec(text)?.[0] ?? "$";
      out.push(sets.constant.has(fold(value)) ? "constant" : "variable", value);
      index += value.length;
      continue;
    }
    if (/\d/u.test(char) || (char === "." && /\d/u.test(next))) {
      NUMBER.lastIndex = index;
      const value = NUMBER.exec(text)?.[0] ?? char;
      out.push("number", value);
      index += value.length;
      continue;
    }
    if (language.name === "CSS" && char === "#" && /[\da-fA-F]/u.test(next)) {
      const match = /#[\da-fA-F]{3,8}\b/uy;
      match.lastIndex = index;
      const value = match.exec(text)?.[0];
      if (value) { out.push("number", value); index += value.length; continue; }
    }
    word.lastIndex = index;
    const found = /[A-Za-z_$]/u.test(char) ? word.exec(text)?.[0] : undefined;
    if (found) {
      const after = text.slice(index + found.length, index + found.length + 40);
      // Python 的 f"…"、rb'…'：前缀和字符串一起算字符串。
      if (language.stringPrefixes?.test(found) && /^["']/u.test(after)) {
        const delimiter = (language.strings ?? []).find((item) => after.startsWith(item))!;
        const stop = stringEnd(text, index + found.length, delimiter, /r/iu.test(found));
        out.push("string", text.slice(index, stop));
        index = stop;
        continue;
      }
      const key = fold(found);
      const kind: TokenKind | null =
        sets.control.has(key) ? "control"
          : sets.keyword.has(key) ? "keyword"
            : sets.constant.has(key) ? "constant"
              : language.keyBefore?.test(after) ? "property"
                : /^\s*\(/u.test(after) ? "function"
                  : TYPE_INTRO.has(previous) || (language.capitalizedTypes && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/u.test(found)) ? "type"
                    : null;
      out.push(kind, found);
      previous = key;
      index += found.length;
      continue;
    }
    if (!/\s/u.test(char)) previous = "";
    out.push(null, char);
    index += 1;
  }
  return out.flush();
}

function scanMarkup(text: string): Token[] {
  const out = new Output();
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      const stop = end < 0 ? text.length : end + 3;
      out.push("comment", text.slice(index, stop));
      index = stop;
      continue;
    }
    const tag = /<\/?([A-Za-z][\w:.-]*)/uy;
    tag.lastIndex = index;
    const open = text[index] === "<" ? tag.exec(text) : null;
    if (!open) { out.push(null, text[index]!); index += 1; continue; }
    out.push("punctuation", open[0].startsWith("</") ? "</" : "<");
    out.push("tag", open[1]!);
    index += open[0].length;
    // 属性，直到 > 或 />。
    while (index < text.length && text[index] !== ">" && !text.startsWith("/>", index)) {
      const char = text[index]!;
      if (char === '"' || char === "'") {
        const stop = stringEnd(text, index, char, true);
        out.push("string", text.slice(index, stop));
        index = stop;
        continue;
      }
      const attribute = /[A-Za-z_:@#][\w:.@#-]*/uy;
      attribute.lastIndex = index;
      const name = attribute.exec(text)?.[0];
      if (name) { out.push("attribute", name); index += name.length; continue; }
      out.push(null, char);
      index += 1;
    }
    const close = text.startsWith("/>", index) ? "/>" : text[index] === ">" ? ">" : "";
    out.push("punctuation", close);
    index += close.length;
  }
  return out.flush();
}

function scanMarkdown(text: string): Token[] {
  const out = new Output();
  let fenced = false;
  for (const line of text.split(/(?<=\n)/u)) {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; out.push("string", line); continue; }
    if (fenced) { out.push("string", line); continue; }
    if (/^#{1,6}\s/u.test(line)) { out.push("heading", line); continue; }
    if (/^\s*>/u.test(line)) { out.push("comment", line); continue; }
    const marker = /^(\s*)([-*+]|\d+[.)])(\s+)/u.exec(line);
    let rest = line;
    if (marker) {
      out.push(null, marker[1]!);
      out.push("keyword", marker[2]!);
      out.push(null, marker[3]!);
      rest = line.slice(marker[0].length);
    }
    // 行内代码和链接地址。
    const inline = /(`[^`\n]+`)|(\]\([^)\n]+\))/gu;
    let last = 0;
    for (const match of rest.matchAll(inline)) {
      out.push(null, rest.slice(last, match.index));
      if (match[1]) out.push("string", match[1]);
      else { out.push(null, "]("); out.push("variable", match[2]!.slice(2, -1)); out.push(null, ")"); }
      last = match.index! + match[0].length;
    }
    out.push(null, rest.slice(last));
  }
  return out.flush();
}

/** 把文本切成带类别的片段；language 为 null 时整份当纯文本。 */
export function highlight(text: string, language: Language | null): Token[] {
  if (!language) return [{ kind: null, text }];
  if (language.kind !== "code") return language.kind === "markup" ? scanMarkup(text) : scanMarkdown(text);
  return scanCode(text, language);
}
