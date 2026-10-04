import { describe, expect, it } from "vitest";
import { highlight, languageFor, type TokenKind } from "../src/renderer/syntax-highlight";

function kinds(path: string, text: string): Record<string, TokenKind | null> {
  const tokens = highlight(text, languageFor(path));
  expect(tokens.map((token) => token.text).join("")).toBe(text);
  return Object.fromEntries(tokens.filter((token) => token.text.trim()).map((token) => [token.text.trim(), token.kind]));
}

describe("syntax highlight", () => {
  it("colours Python like VS Code and keeps the text intact", () => {
    const found = kinds("tests/test_todo.py", '@pytest.fixture\ndef load(path: Path) -> int:  # 读取\n    return int(f"{path}", 10) if True else None\n');
    expect(found["@pytest.fixture"]).toBe("decorator");
    expect(found.def).toBe("keyword");
    expect(found.load).toBe("function");
    expect(found.Path).toBe("type");
    expect(found["# 读取"]).toBe("comment");
    expect(found.return).toBe("control");
    expect(found['f"{path}"']).toBe("string");
    expect(found["10"]).toBe("number");
    expect(found.True).toBe("constant");
  });

  it("keeps multi-line strings and comments in one piece", () => {
    const text = '"""first\nsecond"""\nx = 1\n';
    expect(highlight(text, languageFor("a.py"))[0]).toEqual({ kind: "string", text: '"""first\nsecond"""' });
    const block = "/* a\n b */ const x = 1;";
    expect(highlight(block, languageFor("a.ts"))[0]).toEqual({ kind: "comment", text: "/* a\n b */" });
  });

  it("ends an unterminated single-line string at the end of the line", () => {
    const tokens = highlight("x = 'open\ny = 2\n", languageFor("a.py"));
    expect(tokens.find((token) => token.kind === "string")?.text).toBe("'open");
    expect(tokens.some((token) => token.kind === "number" && token.text === "2")).toBe(true);
  });

  it("marks keys in JSON and YAML", () => {
    expect(kinds("package.json", '{"name": "x", "ok": true}')['"name"']).toBe("property");
    expect(kinds("ci.yml", "build-job:\n  runs-on: ubuntu # c\n")["runs-on"]).toBe("property");
  });

  it("handles markup and markdown", () => {
    const html = kinds("index.html", '<div class="a"><!-- c --></div>');
    expect(html.div).toBe("tag");
    expect(html.class).toBe("attribute");
    expect(html['"a"']).toBe("string");
    expect(html["<!-- c -->"]).toBe("comment");
    const markdown = kinds("README.md", "# 标题\n- 用 `pytest` 测试\n");
    expect(markdown["# 标题"]).toBe("heading");
    expect(markdown["`pytest`"]).toBe("string");
  });

  it("falls back to plain text for unknown files", () => {
    expect(languageFor("notes.txt")).toBeNull();
    expect(highlight("hello", null)).toEqual([{ kind: null, text: "hello" }]);
    expect(languageFor("Dockerfile")?.name).toBe("Dockerfile");
  });
});
