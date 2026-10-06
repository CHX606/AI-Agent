import DOMPurify from "dompurify";
import { Marked } from "marked";

const parser = new Marked({ gfm: true, breaks: false, async: false });
const tags = ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
  "strong", "em", "b", "i", "del", "s", "u", "ins", "mark", "sup", "sub", "small", "kbd", "var", "samp",
  "q", "abbr", "cite", "time", "hr", "a", "img", "ul", "ol", "li", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "caption", "details", "summary", "input", "div", "span", "dl", "dt", "dd",
  "figure", "figcaption"];
const attributes = ["href", "src", "alt", "title", "align", "start", "checked", "disabled", "type", "class", "open",
  "colspan", "rowspan"];

export function markdownHtml(markdown: string): string {
  return parser.parse(markdown.replaceAll("\r\n", "\n"), { async: false }) as string;
}

/** 模型与工具的原始 HTML 是不可信内容；插入文档前始终净化。 */
export function markdownFragment(markdown: string): DocumentFragment {
  return DOMPurify.sanitize(markdownHtml(markdown), {
    ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/iu,
    ADD_URI_SAFE_ATTR: attributes.filter(attribute => attribute !== "href" && attribute !== "src"),
    RETURN_DOM_FRAGMENT: true,
  });
}
