import { createDiagnostics, installProcessDiagnostics } from "@bit-agent/diagnostics";

export const gatewayDiagnostics = createDiagnostics({ process: "gateway" });
installProcessDiagnostics(gatewayDiagnostics);
