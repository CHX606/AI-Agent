import { ipcMain } from "electron";
import type { TaskRequestInput } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import { createTaskAnnouncer } from "./task-notifications.js";
import { watchTaskStream } from "./task-event-stream.js";
import { validateTaskRequest } from "./task-request.js";

type Announcer = ReturnType<typeof createTaskAnnouncer>;

async function watchTask(sender: Electron.WebContents, input: TaskRequestInput,
  services: DesktopServices, controllers: Map<string, AbortController>, announce: Announcer): Promise<void> {
  const { diagnostics, managedHeaders, runtimeConfiguration } = services;
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  const request = validateTaskRequest(input);
  const initialRuntime = runtimeConfiguration();
  const watchesManagedRuntime = initialRuntime.managed && initialRuntime.gatewayUrl === request.gatewayUrl;
  const key = `${sender.id}:${request.taskId}`;
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  try {
    await watchTaskStream(request, {
      signal: controller.signal, diagnostics, managedHeaders, requestJson,
      emit: (event) => {
        if (sender.isDestroyed()) return;
        sender.send("task:event", event);
        announce(sender, event);
      },
      isActive: () => !sender.isDestroyed(),
      managedStopped: () => {
        const runtime = runtimeConfiguration();
        return watchesManagedRuntime && !runtime.gatewayUrl;
      },
    });
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}

export function createTaskWatches(services: DesktopServices) {
  const controllers = new Map<string, AbortController>();
  const announce = createTaskAnnouncer();
  return {
    register: () => registerWatchEvents(services, controllers, announce),
    stopAll: () => { for (const controller of controllers.values()) controller.abort(); },
  };
}

function registerWatchEvents(services: DesktopServices,
  controllers: Map<string, AbortController>, announce: Announcer): void {
  ipcMain.on("tasks:watch", (event, input: TaskRequestInput) => {
    void watchTask(event.sender, input, services, controllers, announce)
      .catch(error => services.diagnostics.failure("desktop_watch_failed", error));
  });
  ipcMain.on("tasks:unwatch", (event, taskId: string) => {
    controllers.get(`${event.sender.id}:${taskId}`)?.abort();
  });
}
