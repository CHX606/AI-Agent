import type { TaskRequestInput } from "../shared/contracts.js";
import "./product-controls.css";
import { mountExecutionSettings } from "./execution-settings.js";
import { ProductDialog } from "./product/dialog.js";
import { mountPermissionControl } from "./product/permission.js";
import { mountReviewButton } from "./product/review.js";
import { mountSettingsEntries } from "./product/settings-entries.js";

export { permissionMode } from "./product/permission.js";

export function mountProductControls(current: () => TaskRequestInput,
  diagnosticCurrent: () => { gatewayUrl: string; taskId?: string },
  memoryCurrent: () => { gatewayUrl: string; workspaceRoot: string }): void {
  mountPermissionControl();
  const dialog = new ProductDialog();
  mountSettingsEntries(dialog, diagnosticCurrent, memoryCurrent);
  mountReviewButton(dialog, current);
  mountExecutionSettings();
}
