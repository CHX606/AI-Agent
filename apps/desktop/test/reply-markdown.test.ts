import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/copy-button.css", () => ({}));
const { registerMarkdown, replyMarkdown } = await import("../src/renderer/copy-button");

function item(className: string): Element {
  return { className } as unknown as Element;
}

describe("copying a whole reply", () => {
  it("joins the shown text rows in order and skips tools and empty rows", () => {
    const first = item("stream-item stream-text");
    const tool = item("stream-item stream-tool");
    const empty = item("stream-item stream-text");
    const last = item("stream-item stream-text");
    let streamed = "第二段";
    registerMarkdown(first, () => "  第一段 **加粗**\n");
    registerMarkdown(empty, () => "   ");
    registerMarkdown(last, () => streamed);
    const stream = { querySelectorAll: (selector: string) => {
      expect(selector).toBe(":scope > .stream-text");
      return [first, empty, last];
    } } as unknown as Element;
    void tool;
    expect(replyMarkdown(stream)).toBe("第一段 **加粗**\n\n第二段");
    streamed = "第二段，后来补全";
    expect(replyMarkdown(stream)).toBe("第一段 **加粗**\n\n第二段，后来补全");
  });
});
