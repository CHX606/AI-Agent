/**
 * 在网页的“隔离世界”里运行的脚本：和网页自己的脚本共享 DOM，但各自有独立的全局变量，
 * 网页看不到也改不了这里记下的元素编号。
 */
export const AGENT_WORLD = 1001;

/** 页面快照：可见文字 + 可交互元素（带编号）。编号在下一次快照前有效。 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX_TEXT = 6000, MAX_ELEMENTS = 250;
  const state = (globalThis.__bitAgent = { refs: new Map(), next: 1 });
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const clean = (value, limit = 80) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const labelOf = (element) => {
    const aria = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby")
      ?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    if (aria) return clean(aria);
    if (element.labels?.length) return clean([...element.labels].map((label) => label.textContent).join(" "));
    if (element.tagName === "IMG") return clean(element.alt);
    const text = clean(element.innerText || element.textContent);
    return text || clean(element.getAttribute("placeholder") || element.getAttribute("title") || element.getAttribute("name"));
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", range: "slider",
        search: "searchbox", password: "password" }[type] || "textbox";
    }
    return element.isContentEditable ? "textbox" : tag;
  };
  const selector = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [contenteditable=""], [contenteditable="true"],'
    + ' [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"],'
    + ' [role="switch"], [role="textbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])';
  const elements = [];
  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (!visible(element)) continue;
    const ref = state.next++;
    state.refs.set(ref, element);
    const item = { ref, role: roleOf(element), name: labelOf(element) };
    if ("value" in element && element.type !== "password" && typeof element.value === "string" && element.value) item.value = clean(element.value, 120);
    if (element.type === "password") item.value = element.value ? "（已填写，内容不显示）" : "";
    if ("checked" in element && (element.type === "checkbox" || element.type === "radio")) item.checked = element.checked;
    if (element.disabled) item.disabled = true;
    if (element.tagName === "A") item.href = element.href.slice(0, 200);
    if (element.tagName === "SELECT") item.options = [...element.options].slice(0, 20).map((option) => clean(option.text, 40));
    elements.push(item);
  }
  const text = (document.body?.innerText ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title: document.title, url: location.href, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT,
    elements, moreElements: elements.length >= MAX_ELEMENTS };
})()`;

/** 找到编号对应的元素并做一件事；元素失效时给出明确的提示。 */
const withElement = (ref: number, body: string) => String.raw`(() => {
  const element = globalThis.__bitAgent?.refs.get(${ref});
  if (!element || !element.isConnected) return { error: "元素编号 ${ref} 已失效（页面变化了），请先重新调用 snapshot。" };
  ${body}
})()`;

export function clickScript(ref: number): string {
  return withElement(ref, String.raw`
    element.scrollIntoView({ block: "center", inline: "center" });
    if (element.disabled) return { error: "这个元素当前不可用（disabled）。" };
    element.focus?.({ preventScroll: true });
    element.click();
    return { ok: true };`);
}

/**
 * 在输入框里输入文字。不把键盘焦点移到网页（用户可能正在应用里打字）：
 * 普通输入框用原生 value setter + input/change 事件（React 等框架能识别），可编辑区域用 insertText。
 */
export function typeScript(ref: number, text: string, clear: boolean): string {
  return withElement(ref, String.raw`
    const tag = element.tagName;
    const kind = (element.type || "text").toLowerCase();
    const textInput = tag === "TEXTAREA" || (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file",
      "image", "range", "color", "hidden"].includes(kind));
    if (!textInput && !element.isContentEditable) return { error: "这个元素不能输入文字。" };
    if (tag === "INPUT" && kind === "password") return { error: "出于安全考虑，不能替用户在密码框里输入。请让用户自己填写。" };
    if (element.disabled || element.readOnly) return { error: "这个输入框当前不可编辑。" };
    const text = ${JSON.stringify(text)};
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    if (element.isContentEditable) {
      if (${clear}) document.getSelection()?.selectAllChildren(element);
      document.execCommand("insertText", false, text);
    } else {
      const prototype = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(element, (${clear} ? "" : element.value) + text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true, value: element.isContentEditable ? element.innerText.slice(0, 200) : element.value.slice(0, 200) };`);
}

export function submitScript(ref: number): string {
  return withElement(ref, String.raw`
    if (element.form) { element.form.requestSubmit(); return { ok: true, submitted: true }; }
    return { ok: true, submitted: false };`);
}

/** 选择下拉框的选项（按显示文字或值）。 */
export function selectScript(ref: number, option: string): string {
  return withElement(ref, String.raw`
    if (element.tagName !== "SELECT") return { error: "这个元素不是下拉框。" };
    const wanted = ${JSON.stringify(option)}.trim();
    const match = [...element.options].find((item) => item.text.trim() === wanted || item.value === wanted);
    if (!match) return { error: "没有这个选项：" + wanted };
    element.value = match.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };`);
}

export function pageTextIncludes(text: string): string {
  return `(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`;
}
