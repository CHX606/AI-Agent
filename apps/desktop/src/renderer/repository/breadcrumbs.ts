import { projectName } from "../dom";
import { fileIconElement, folderIconElement } from "../file-icons";

export const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';

export function renderBreadcrumbs(container: HTMLElement, workspace: string, path: string): void {
  container.replaceChildren();
  const parts = [projectName(workspace), ...path.split("/").filter(Boolean)];
  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "editor-crumb-separator";
      separator.innerHTML = CHEVRON;
      container.append(separator);
    }
    const crumb = document.createElement("span");
    crumb.className = "editor-crumb";
    crumb.append(index === parts.length - 1 ? fileIconElement(part) : folderIconElement(part, true));
    crumb.append(part);
    container.append(crumb);
  });
}
