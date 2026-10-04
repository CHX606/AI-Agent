/**
 * 输入框右下角的“模型 · 思考程度”菜单（参照 Claude Code 的 Opus 5.5 · Extra）。
 * 模型来自模型设置：主模型、辅助模型和“可切换的模型”；思考程度对应 OpenAI 的 reasoning.effort。
 * 选择记在本机，下一次发送的任务使用；没选时用主模型、由模型决定思考程度。
 */
import type { ReasoningEffort } from "../shared/contracts";
import { parseModelList } from "../shared/model-list";
import "./choice-menu.css";

const STORAGE_KEY = "bit-agent.model-choice.v1";

const EFFORTS: { value: ReasoningEffort | ""; label: string; level: number; description: string }[] = [
  { value: "", label: "默认", level: 0, description: "不指定，由模型自己决定" },
  { value: "low", label: "低", level: 1, description: "最快，适合简单修改和问答" },
  { value: "medium", label: "中", level: 2, description: "速度和质量平衡" },
  { value: "high", label: "高", level: 3, description: "复杂问题想得更深，更慢、更费 tokens" },
  { value: "xhigh", label: "超高", level: 4, description: "部分新模型支持，适合难排查的问题" },
  { value: "max", label: "最高", level: 5, description: "少数模型支持，最慢、最费 tokens" },
];

export interface ModelChoice { model?: string; reasoningEffort?: ReasoningEffort }

const CHEVRON = '<svg class="choice-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const CHECK = '<svg class="choice-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const CHIP = '<svg class="choice-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';

/** 信号格表示思考档位：格数越多想得越深。 */
function bars(level: number): string {
  const heights = [5, 9, 13, 17];
  const filled = Math.min(level, 4);
  const rects = heights.map((height, index) =>
    `<rect x="${3 + index * 5}" y="${20 - height}" width="3" height="${height}" rx="1" class="${index < filled ? "bar-on" : "bar-off"}"/>`).join("");
  return `<svg class="choice-icon effort-bars${level >= 5 ? " effort-max" : ""}" viewBox="0 0 24 24" aria-hidden="true">${rects}</svg>`;
}

function readChoice(): { model: string | null; effort: ReasoningEffort | "" } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { model?: unknown; effort?: unknown };
    return {
      model: typeof saved.model === "string" ? saved.model : null,
      effort: EFFORTS.some((item) => item.value === saved.effort) ? saved.effort as ReasoningEffort | "" : "",
    };
  } catch { return { model: null, effort: "" }; }
}

export function mountModelMenu(container: HTMLElement, openSettings: () => void) {
  const root = document.createElement("div");
  root.className = "model-menu";
  root.id = "model-menu";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "choice-trigger model-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "choice-popover model-popover";
  panel.dataset.align = "end";
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "模型和思考程度");
  panel.hidden = true;
  root.append(trigger, panel);
  container.prepend(root);

  let defaultModel = "";
  let auxModel = "";
  let models: string[] = [];
  let choice = readChoice();
  let locked = false;

  const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(false); };

  function save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)); } catch { /* 只影响下次打开时的默认选择 */ }
  }

  function currentModel(): string {
    return choice.model && models.includes(choice.model) ? choice.model : defaultModel;
  }

  function item(label: string, description: string, icon: string, checked: boolean, onChoose: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-item";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(checked));
    button.innerHTML = `${icon}<span class="choice-text"><strong></strong>${description ? "<small></small>" : ""}</span>${CHECK}`;
    button.querySelector("strong")!.textContent = label;
    const small = button.querySelector("small");
    if (small) small.textContent = description;
    button.addEventListener("click", onChoose);
    return button;
  }

  function heading(text: string): HTMLParagraphElement {
    const element = document.createElement("p");
    element.className = "choice-heading";
    element.textContent = text;
    return element;
  }

  function paint(): void {
    const model = currentModel();
    const effort = EFFORTS.find((entry) => entry.value === choice.effort) ?? EFFORTS[0]!;
    trigger.disabled = locked;
    trigger.innerHTML = `${bars(effort.level)}<span class="choice-value"></span>${effort.value ? '<span class="model-effort"></span>' : ""}${CHEVRON}`;
    trigger.querySelector(".choice-value")!.textContent = model || "未配置模型";
    const effortLabel = trigger.querySelector(".model-effort");
    if (effortLabel) effortLabel.textContent = effort.label;
    trigger.title = `模型：${model || "未配置"}；思考程度：${effort.label}（${effort.description}）`;
    trigger.setAttribute("aria-label", `模型和思考程度：${model || "未配置模型"}，${effort.label}`);

    panel.replaceChildren(heading("模型"));
    if (!models.length) {
      const empty = document.createElement("p");
      empty.className = "choice-empty";
      empty.textContent = "还没有配置模型。";
      panel.append(empty);
    }
    for (const name of models) {
      const description = name === defaultModel ? "主模型（模型设置）" : name === auxModel ? "辅助模型" : "";
      panel.append(item(name, description, CHIP, name === model, () => {
        choice = { ...choice, model: name === defaultModel ? null : name };
        save();
        close(true);
        paint();
      }));
    }
    const divider = () => { const line = document.createElement("div"); line.className = "choice-divider"; return line; };
    panel.append(divider(), heading("思考程度"));
    for (const entry of EFFORTS) {
      panel.append(item(entry.label, entry.description, bars(entry.level), entry.value === choice.effort, () => {
        choice = { ...choice, effort: entry.value };
        save();
        close(true);
        paint();
      }));
    }
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "choice-item choice-footer";
    manage.textContent = "管理模型…";
    manage.addEventListener("click", () => { close(false); openSettings(); });
    panel.append(divider(), manage);
  }

  function items(): HTMLButtonElement[] { return [...panel.querySelectorAll<HTMLButtonElement>(".choice-item")]; }

  function open(): void {
    if (locked) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    (items().find((button) => button.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
  }

  function close(restoreFocus: boolean): void {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (restoreFocus) trigger.focus();
  }

  // 点开前重新读一次设置：首次配置、别处改了设置后，列表都是最新的。
  trigger.addEventListener("click", async () => {
    if (!panel.hidden) { close(true); return; }
    await reload();
    open();
  });
  root.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      // 只关菜单，不能冒泡到全局的“Esc 暂停”。
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  });

  async function reload(): Promise<void> {
    try {
      const settings = await window.bitAgent.getModelSettings();
      defaultModel = typeof settings.model === "string" ? settings.model.trim() : "";
      auxModel = typeof settings.auxModel === "string" ? settings.auxModel.trim() : "";
      models = parseModelList([defaultModel, ...parseModelList(settings.models), auxModel]);
    } catch {
      defaultModel = "";
      models = [];
    }
    choice = readChoice();
    paint();
  }

  window.addEventListener("bit-agent:model-settings-saved", () => { void reload(); });
  window.addEventListener("focus", () => { if (panel.hidden) void reload(); });
  paint();
  void reload();

  return {
    /** 本次发送要用的模型和思考程度；选的就是主模型或默认档时不传，沿用设置。 */
    selection(): ModelChoice {
      const model = currentModel();
      return {
        ...(model && model !== defaultModel ? { model } : {}),
        ...(choice.effort ? { reasoningEffort: choice.effort } : {}),
      };
    },
    setDisabled(disabled: boolean): void {
      locked = disabled;
      trigger.disabled = disabled;
      if (disabled) close(false);
    },
    reload,
  };
}

export type ModelMenu = ReturnType<typeof mountModelMenu>;
