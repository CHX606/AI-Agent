import { describe, expect, it } from "vitest";
import { markdownHtml } from "../src/renderer/markdown/parser";

describe("CommonMark and GFM output parsing", () => {
  it("renders the reported root-directory table without joining its rows into prose", () => {
    const html = markdownHtml("## 根目录内容\n\n| 文件 / 文件夹 | 用途 |\n| --- | --- |\n| `index.html` | 模板总览页 |\n| `README.md` | 说明 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>文件 / 文件夹</th>");
    expect(html.match(/<tr>/gu)).toHaveLength(3);
    expect(html).toContain("<code>index.html</code>");
  });

  it("supports every heading level and setext headings", () => {
    const html = markdownHtml("# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六\n\n下划线标题\n===\n");
    for (let level = 1; level <= 6; level += 1) expect(html).toContain(`<h${level}>`);
    expect(html).toContain("<h1>下划线标题</h1>");
  });

  it("preserves nested ordered/unordered lists and disabled GFM task states", () => {
    const html = markdownHtml("3. 第一项\n   - 子项\n     - 更深子项\n4. 第二项\n\n- [x] 完成\n- [ ] 待办\n");
    expect(html).toContain('<ol start="3">');
    expect(html.match(/<ul>/gu)).toHaveLength(3);
    expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
    expect(html).toContain('checked="" disabled=""');
  });

  it("renders emphasis, deletion, inline code and escaped punctuation", () => {
    const html = markdownHtml("**粗体**、*斜体*、~~删除~~、`a < b`、\\*星号\\*。");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<del>删除</del>");
    expect(html).toContain("<code>a &lt; b</code>");
    expect(html).toContain("*星号*");
  });

  it("supports quotes containing paragraphs, lists and horizontal rules", () => {
    const html = markdownHtml("> 引用第一段\n>\n> - 引用列表\n>\n> 第二段\n\n---\n\n换行  \n下一行");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<br>");
  });

  it("supports links, reference links, autolinks and images", () => {
    const html = markdownHtml('[普通](https://example.com) [引用][docs]\n\n[docs]: https://example.com/docs "资料"\n\nhttps://example.com ![图](https://example.com/p.png)');
    expect(html).toContain('href="https://example.com/docs" title="资料"');
    expect(html.match(/<a /gu)).toHaveLength(3);
    expect(html).toContain('<img src="https://example.com/p.png" alt="图">');
  });

  it("supports both fence styles, longer fences and indented code", () => {
    const html = markdownHtml("~~~~javascript\nconst x = '<tag>';\n~~~~\n\n````python\n```\nprint(1)\n````\n\n    plain <code>\n");
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain('class="language-python"');
    expect(html.match(/<pre>/gu)).toHaveLength(3);
    expect(html).toContain("plain &lt;code&gt;");
  });

  it("keeps incomplete streamed fences readable and recognizes a completed table separator", () => {
    expect(markdownHtml("```python\nprint('未结束')")).toContain('class="language-python"');
    expect(markdownHtml("| 文件 | 用途 |\n| ---")).not.toContain("<table>");
    expect(markdownHtml("| 文件 | 用途 |\n| --- | --- |\n| a.py | 测试 |")).toContain("<table>");
  });
});
