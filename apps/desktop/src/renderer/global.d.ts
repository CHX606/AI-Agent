import type { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    bitAgent: DesktopApi;
  }
}

export {};
