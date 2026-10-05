import { modelFormHtml } from "./model-form-html.js";

export function createModelForm(settings: Record<string, unknown>): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "model-settings-form";
  form.innerHTML = modelFormHtml;
  for (const name of ["baseUrl", "model", "auxModel", "models", "inputPrice", "outputPrice"]) {
    (form.elements.namedItem(name) as HTMLInputElement).value = String(settings[name] ?? "");
  }
  (form.elements.namedItem("currency") as HTMLSelectElement).value = settings.currency === "$" ? "$" : "¥";
  (form.elements.namedItem("api") as HTMLSelectElement).value = settings.api === "chat_completions" ? "chat_completions" : "responses";
  form.querySelector(".model-key-state")!.textContent = settings.configured ? "已配置" : "未配置";
  return form;
}
