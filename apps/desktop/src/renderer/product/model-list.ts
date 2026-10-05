import { parseModelList } from "../../shared/model-list.js";
import type { ProductDialog } from "./dialog.js";

function modelOption(model: string, chosen: Set<string>, modelList: HTMLTextAreaElement): HTMLElement {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = model;
  box.checked = chosen.has(model);
  box.addEventListener("change", () => {
    const current = parseModelList(modelList.value).filter((name) => name !== model);
    modelList.value = (box.checked ? [...current, model] : current).join("\n");
  });
  const name = document.createElement("span");
  name.textContent = model;
  name.title = model;
  label.append(box, name);
  return label;
}

export function bindModelList(form: HTMLFormElement, body: HTMLElement, dialog: ProductDialog): void {
  const modelList = form.elements.namedItem("models") as HTMLTextAreaElement;
  const fetchButton = form.querySelector<HTMLButtonElement>("[data-fetch-models]")!;
  const fetched = form.querySelector<HTMLElement>(".model-fetch-result")!;
  fetchButton.addEventListener("click", async () => {
    if (!(form.elements.namedItem("baseUrl") as HTMLInputElement).reportValidity()) return;
    fetchButton.disabled = true;
    fetchButton.textContent = "正在获取…";
    try {
      const models = await window.bitAgent.listModels(Object.fromEntries(new FormData(form).entries()));
      if (!dialog.active(body)) return;
      const chosen = new Set(parseModelList(modelList.value));
      fetched.replaceChildren(...models.map((model) => modelOption(model, chosen, modelList)));
      fetched.hidden = false;
    } catch (error) { dialog.feedback(body, error); }
    finally { fetchButton.disabled = false; fetchButton.textContent = "从服务获取"; }
  });
}
