import Fastify, { LogController, type FastifyInstance, type FastifyBaseLogger } from "fastify";
import { diagnosticId, type DiagnosticService } from "@bit-agent/diagnostics";
import type { TaskStore } from "../../application/ports/task-store.js";
import { registerHttpSecurity } from "./security.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerConfigurationRoutes } from "./configuration-routes.js";
import { registerChangeRoutes } from "./change-routes.js";
import { registerTaskRoutes } from "./task-routes.js";
import { registerTaskEvents } from "./task-events.js";

export interface BuildAppOptions {
  logger?: boolean;
  taskStore: TaskStore;
  diagnostics: DiagnosticService;
}

export function createHttpApp(options: BuildAppOptions): FastifyInstance {
  const { taskStore, diagnostics } = options;
  const app = Fastify({
    ...(options.logger === false ? { logger: false } : { loggerInstance: diagnostics.logger as FastifyBaseLogger }),
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: request => {
      const id = request.headers["x-request-id"];
      return typeof id === "string" && /^D-[a-f0-9]{16}$/u.test(id) ? id : diagnosticId();
    },
  });
  registerHttpSecurity(app, diagnostics);
  registerRuntimeRoutes(app, taskStore, diagnostics);
  registerSessionRoutes(app, taskStore);
  registerConfigurationRoutes(app, taskStore);
  registerChangeRoutes(app, taskStore);
  registerTaskRoutes(app, taskStore);
  registerTaskEvents(app, taskStore, diagnostics);
  app.addHook("onClose", async () => taskStore.close());
  return app;
}
