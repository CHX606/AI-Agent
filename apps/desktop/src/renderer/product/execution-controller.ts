import {
  DEFAULT_ACCEPTANCE_MODE, DEFAULT_MAX_TOOL_ROUNDS, parseExecutionSettings, type AcceptanceMode,
} from "../../shared/execution-settings.js";
import { errorText } from "../dom.js";
import { acceptanceChoices } from "./execution-dialog.js";

const acceptanceLabel = (mode: AcceptanceMode) => acceptanceChoices.find(([value]) => value === mode)?.[1] ?? mode;

export class ExecutionSettingsController {
  private readonly form: HTMLFormElement;
  private readonly input: HTMLElementTagNameMap["wa-input"];
  private readonly modes: HTMLFieldSetElement | null;
  private readonly save: HTMLElementTagNameMap["wa-button"];
  private readonly reset: HTMLElementTagNameMap["wa-button"];
  private readonly feedback: HTMLParagraphElement;
  private generation = 0;
  private saving = false;

  constructor(private readonly dialog: HTMLElementTagNameMap["wa-dialog"]) {
    this.form = dialog.querySelector("form")!;
    this.input = dialog.querySelector("wa-input")!;
    this.modes = dialog.querySelector<HTMLFieldSetElement>("#acceptance-mode") ?? null;
    this.save = dialog.querySelector("#execution-settings-save")!;
    this.reset = dialog.querySelector("#execution-settings-reset")!;
    this.feedback = dialog.querySelector("#execution-settings-feedback")!;
  }

  private get acceptanceMode(): AcceptanceMode {
    const checked = this.modes?.querySelector<HTMLInputElement>("input:checked");
    return (checked?.value as AcceptanceMode | undefined) ?? DEFAULT_ACCEPTANCE_MODE;
  }

  private set acceptanceMode(mode: AcceptanceMode) {
    for (const option of this.modes?.querySelectorAll<HTMLInputElement>("input") ?? []) {
      option.checked = option.value === mode;
    }
  }

  private message(text: string, success = false): void {
    this.feedback.hidden = false;
    this.feedback.textContent = text;
    this.feedback.dataset.kind = success ? "success" : "error";
    this.feedback.setAttribute("role", success ? "status" : "alert");
  }

  private busy(value: boolean): void {
    this.input.disabled = value;
    if (this.modes) this.modes.disabled = value;
    this.save.disabled = value;
    this.reset.disabled = value;
    this.form.setAttribute("aria-busy", String(value));
  }

  async open(): Promise<void> {
    const current = ++this.generation;
    this.feedback.hidden = true;
    this.input.value = String(DEFAULT_MAX_TOOL_ROUNDS);
    this.acceptanceMode = DEFAULT_ACCEPTANCE_MODE;
    this.dialog.open = true;
    this.busy(true);
    try {
      const settings = await window.bitAgent.getExecutionSettings();
      if (current === this.generation && this.dialog.open) {
        this.input.value = String(settings.maxToolRounds);
        this.acceptanceMode = settings.acceptanceMode ?? DEFAULT_ACCEPTANCE_MODE;
      }
    } catch (error) {
      if (current === this.generation && this.dialog.open) this.message(errorText(error, "执行设置读取失败，请重新保存"));
    } finally {
      if (current === this.generation) this.busy(false);
    }
  }

  private async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving || this.save.disabled) return;
    try {
      const settings = parseExecutionSettings({ maxToolRounds: Number(this.input.value), acceptanceMode: this.acceptanceMode });
      this.saving = true;
      this.busy(true);
      this.save.loading = true;
      const saved = await window.bitAgent.saveExecutionSettings(settings);
      this.input.value = String(saved.maxToolRounds);
      this.acceptanceMode = saved.acceptanceMode;
      this.message(`已保存：每次主任务最多 ${saved.maxToolRounds} 轮，独立验收“${acceptanceLabel(saved.acceptanceMode)}”。下一次发送任务时生效。`, true);
    } catch (error) {
      this.message(errorText(error, "保存失败，请重试"));
    } finally {
      this.saving = false;
      this.save.loading = false;
      this.busy(false);
    }
  }

  bind(trigger: HTMLButtonElement): void {
    trigger.addEventListener("click", () => { void this.open(); });
    const close = () => { if (!this.saving) this.dialog.open = false; };
    this.dialog.querySelector("#execution-settings-cancel")!.addEventListener("click", close);
    this.dialog.querySelector("#execution-settings-close")!.addEventListener("click", close);
    this.reset.addEventListener("click", () => {
      this.input.value = String(DEFAULT_MAX_TOOL_ROUNDS);
      this.acceptanceMode = DEFAULT_ACCEPTANCE_MODE;
      this.feedback.hidden = true;
    });
    this.input.addEventListener("input", () => { this.feedback.hidden = true; });
    this.modes?.addEventListener("change", () => { this.feedback.hidden = true; });
    this.dialog.addEventListener("wa-hide", (event) => {
      if (this.saving) event.preventDefault();
      else this.generation++;
    });
    this.form.addEventListener("submit", (event) => { void this.submit(event); });
  }
}
