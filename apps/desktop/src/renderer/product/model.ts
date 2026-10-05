import type { ProductDialog } from "./dialog.js";
import { createModelForm } from "./model-form.js";
import { bindModelList } from "./model-list.js";
import { bindModelTest } from "./model-test.js";

function bindSave(form: HTMLFormElement, body: HTMLElement, dialog: ProductDialog): void {
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const testResult = form.querySelector<HTMLElement>(".model-test-result")!;
    submit.disabled = true;
    submit.textContent = "正在保存…";
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await window.bitAgent.saveModelSettings(values);
      window.dispatchEvent(new Event("bit-agent:model-settings-saved"));
      (form.elements.namedItem("apiKey") as HTMLInputElement).value = "";
      form.querySelector(".model-key-state")!.textContent = "已配置";
      dialog.feedback(body, testResult.dataset.ok === "true"
        ? "设置已保存，将用于下一次任务。"
        : "设置已保存，将用于下一次任务。模型连接尚未验证，建议先测试连接。", true);
    } catch (error) { dialog.feedback(body, error); }
    finally { submit.disabled = false; submit.textContent = "保存设置"; }
  };
}

export async function showModelSettings(dialog: ProductDialog): Promise<void> {
  const body = dialog.open("model", "模型设置", "连接你使用的模型服务，保存后从下一次任务开始生效。");
  try {
    const settings = await window.bitAgent.getModelSettings();
    if (!dialog.active(body)) return;
    dialog.ready(body);
    const form = createModelForm(settings);
    bindModelList(form, body, dialog);
    bindModelTest(form, body, dialog);
    bindSave(form, body, dialog);
    form.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
    body.append(form);
  } catch (error) { dialog.feedback(body, error); }
}
