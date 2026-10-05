import type { ModelTestResult } from "../../shared/contracts.js";
import type { ProductDialog } from "./dialog.js";

const apiLabels: Record<string, string> = { responses: "Responses API", chat_completions: "Chat Completions" };

function paintAttempts(target: HTMLElement, result: ModelTestResult): void {
  const tried = (result.attempts ?? []).filter((item) => !result.ok || item.api !== result.api);
  if (!tried.length) return;
  const list = document.createElement("ul");
  for (const attempt of tried) {
    const item = document.createElement("li");
    item.textContent = `${apiLabels[attempt.api] ?? attempt.api}：${attempt.status_code ? `HTTP ${attempt.status_code}，` : ""}${attempt.message}`;
    list.append(item);
  }
  target.append(list);
}

function paintTest(form: HTMLFormElement, target: HTMLElement, result: ModelTestResult): void {
  target.dataset.ok = String(result.ok);
  target.replaceChildren();
  const summary = document.createElement("strong");
  if (result.ok && result.api) {
    (form.elements.namedItem("api") as HTMLSelectElement).value = result.api;
    summary.textContent = `连接成功：${apiLabels[result.api]}，用时 ${result.latency_ms ?? "-"} ms。已选中这种接口类型，保存后生效。`;
  } else { summary.textContent = `连接失败：${result.message}`; }
  target.append(summary);
  paintAttempts(target, result);
  target.hidden = false;
}

export function bindModelTest(form: HTMLFormElement, body: HTMLElement, dialog: ProductDialog): void {
  const button = form.querySelector<HTMLButtonElement>("[data-test]")!;
  const resultElement = form.querySelector<HTMLElement>(".model-test-result")!;
  // 测试之后又改了表单，旧的测试结论就不再适用。
  form.addEventListener("input", () => { delete resultElement.dataset.ok; resultElement.hidden = true; });
  button.addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    button.disabled = true;
    button.textContent = "正在测试…";
    resultElement.hidden = true;
    try {
      const values = { ...Object.fromEntries(new FormData(form).entries()), api: "auto" };
      const result = await window.bitAgent.testModelSettings(values);
      if (!dialog.active(body)) return;
      paintTest(form, resultElement, result);
    } catch (error) { dialog.feedback(body, error); }
    finally { button.disabled = false; button.textContent = "测试连接"; }
  });
}
