import { mountSidebarResize } from "../src/renderer/sidebar-resize";
import "../src/renderer/styles/theme.css";
import "../src/renderer/styles/base.css";
import "../src/renderer/styles/navigation.css";
import "../src/renderer/styles/responsive.css";

const shell = document.querySelector<HTMLElement>(".shell")!;
mountSidebarResize(shell);
document.querySelector("#sidebar-resize")!.addEventListener("pointerdown", event => {
  (window as Window & { resizePointer?: number }).resizePointer = (event as PointerEvent).pointerId;
});
