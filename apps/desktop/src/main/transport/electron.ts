import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";

import { join } from "node:path";
import { diagnosticId, errorFields, publicError, installProcessDiagnostics } from "@bit-agent/diagnostics";

import { watchTaskStream } from "./task-event-stream.js";

import { taskRequestBody } from "../application/task-input.js";

import type {
  ColorTheme,
  CreateTaskInput,
  MultiAgentMode,
  SessionRequestInput,
  TaskRequestInput,
  TaskInteractionInput,
} from "../../shared/contracts.js";
import { normalizeGatewayUrl } from "../../shared/gateway-url.js";

import type { DesktopServices } from "../application/ports.js";

export function startDesktop(services: DesktopServices, currentDirectory: string): void {
  const { diagnostics, gatewayClient, saveDiagnosticBundle, loadTheme, saveTheme,
    readExecutionSettings, writeExecutionSettings, listRepositoryDirectory,
    readRepositoryFile, validateRepositoryWorkspace, managedHeaders, modelSettings,
    runtimeConfiguration, saveModelSettings, startManagedRuntime, stopManagedRuntime } = services;
  installProcessDiagnostics(diagnostics);
  diagnostics.record("info", "desktop_starting");
  let fatalHandled = false;
  function handleFatal(error: unknown): void {
    if (fatalHandled) return;
    fatalHandled = true;
    const id = diagnosticId(error);
    diagnostics.record("fatal", "desktop_unhandled", { ...errorFields(error), diagnostic_id: id });
    if (app.isReady()) dialog.showErrorBox("应用遇到异常", publicError(id, "请重新启动应用，已保存的记录会保留"));
    void stopManagedRuntime().finally(() => app.exit(1));
  }
  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);
  if (!app.requestSingleInstanceLock()) app.quit();

  const streamControllers = new Map<string, AbortController>();
  const repositoryRoots = new Map<number, string>();
  let activeTheme: ColorTheme = "light";

  function themeBackground(theme: ColorTheme): string {
    return theme === "dark" ? "#181817" : "#f2f2ef";
  }

  function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      show: false,
      width: 1240,
      height: 820,
      minWidth: 920,
      minHeight: 640,
      backgroundColor: themeBackground(activeTheme),
      title: "Bit Agent",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(currentDirectory, "transport/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.once("ready-to-show", () => { if (process.env.BIT_AGENT_ACCEPTANCE_HIDDEN !== "1") window.show(); });
    window.webContents.on("render-process-gone", (_event, details) => {
      const id = diagnostics.failure("renderer_gone", new Error(), { reason: details.reason, exit_code: details.exitCode });
      dialog.showErrorBox("界面已停止运行", publicError(id, "请重新启动应用，已保存的记录会保留"));
    });
    window.webContents.on("did-fail-load", (_event, errorCode) => diagnostics.failure("renderer_load_failed", new Error(), { error_code: errorCode }));
    void window.loadFile(join(currentDirectory, "../../renderer/index.html"));
    return window;
  }

  const requestJson = gatewayClient.request.bind(gatewayClient);

  function handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return await listener(event, ...args); }
      catch (error) {
        const id = diagnostics.failure("ipc_failed", error, { operation: channel });
        throw new Error(publicError(id));
      }
    });
  }

  function validateTaskRequest(input: TaskRequestInput): TaskRequestInput {
    if (!input || typeof input.taskId !== "string" || !input.taskId.trim()) {
      throw new Error("taskId 不能为空");
    }
    return {
      gatewayUrl: normalizeGatewayUrl(input.gatewayUrl),
      taskId: input.taskId.trim(),
    };
  }

  async function watchTask(sender: Electron.WebContents, input: TaskRequestInput): Promise<void> {
    const request = validateTaskRequest(input);
    const initialRuntime = runtimeConfiguration();
    const watchesManagedRuntime = initialRuntime.managed
      && initialRuntime.gatewayUrl === request.gatewayUrl;
    const key = `${sender.id}:${request.taskId}`;
    streamControllers.get(key)?.abort();
    const controller = new AbortController();
    streamControllers.set(key, controller);
    try {
      await watchTaskStream(request, {
        signal: controller.signal, diagnostics, managedHeaders, requestJson,
        emit: (event) => { if (!sender.isDestroyed()) sender.send("task:event", event); },
        isActive: () => !sender.isDestroyed(),
        managedStopped: () => {
          const runtime = runtimeConfiguration();
          return watchesManagedRuntime && !runtime.gatewayUrl;
        },
      });
    } finally {
      if (streamControllers.get(key) === controller) streamControllers.delete(key);
    }
  }
  app.whenReady().then(async () => {
    try { await startManagedRuntime(); }
    catch (error) {
      const id = diagnostics.failure("desktop_startup_failed", error);
      const choice = await dialog.showMessageBox({ type: "error", title: "本地服务启动失败",
        message: publicError(id, "本地服务未能启动"), buttons: ["导出诊断包", "关闭"], cancelId: 1 });
      if (choice.response === 0) await saveDiagnosticBundle(undefined, true).catch(err => diagnostics.failure("diagnostic_export_failed", err));
      await stopManagedRuntime(); app.quit(); return;
    }
    handle("diagnostics:renderer-error", (_event, input: { kind?: string; taskId?: string; line?: number }) => {
      const id = diagnostics.failure("renderer_unhandled", new Error(), {
        reason: input.kind === "rejection" ? "rejection" : "exception", task_id: input.taskId,
        sequence: typeof input.line === "number" ? input.line : undefined,
      });
      return publicError(id, "界面遇到异常，请重新打开应用");
    });
    handle("diagnostics:status", async (_event, input: { gatewayUrl?: string; taskId?: string }) => {
      let snapshot: Record<string, unknown> = {};
      let unavailable = false;
      try { snapshot = await requestJson(input.gatewayUrl || runtimeConfiguration().gatewayUrl,
        `/v1/diagnostics${input.taskId ? `?task_id=${encodeURIComponent(input.taskId)}` : ""}`); }
      catch { unavailable = true; }
      return { ...snapshot, directory: diagnostics.directory,
        available: diagnostics.available() && snapshot.available !== false, unavailable };
    });
    handle("diagnostics:export", async (_event, input: { gatewayUrl?: string; taskId?: string }) => {
      let snapshot: Record<string, unknown> = {};
      let unavailable = false;
      try { snapshot = await requestJson(input.gatewayUrl || runtimeConfiguration().gatewayUrl,
        `/v1/diagnostics${input.taskId ? `?task_id=${encodeURIComponent(input.taskId)}` : ""}`); }
      catch { unavailable = true; }
      return saveDiagnosticBundle(snapshot, unavailable);
    });
    ipcMain.on("desktop:config", (event) => { event.returnValue = runtimeConfiguration(); });
    handle("model:get", () => modelSettings());
    handle("model:save", (_event, input: unknown) => saveModelSettings(input));
    handle("execution:get", () => readExecutionSettings(app.getPath("userData")));
    handle("execution:save", (_event, input: unknown) => writeExecutionSettings(app.getPath("userData"), input));
    handle("changes:get", (_event, raw: TaskRequestInput) => {
      const input = validateTaskRequest(raw);
      return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/changes`);
    });
    handle("changes:review", (_event, raw: TaskRequestInput & { changeId: string; action: string }) => {
      const input = validateTaskRequest(raw);
      return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/changes`, {
        method: "POST", body: JSON.stringify({ change_id: raw.changeId, action: raw.action }),
      });
    });
    activeTheme = loadTheme();
    nativeTheme.themeSource = activeTheme;
    Menu.setApplicationMenu(null);

    ipcMain.on("theme:get", (event) => {
      event.returnValue = activeTheme;
    });
    ipcMain.on("theme:set", (event, theme: ColorTheme) => {
      if (theme !== "light" && theme !== "dark") return;
      activeTheme = theme;
      nativeTheme.themeSource = theme;
      BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(
        themeBackground(theme),
      );
      try {
        saveTheme(theme);
      } catch (error) {
        diagnostics.failure("preferences_save_failed", error);
      }
    });

    handle("workspace:select", async (event) => {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      const selectedPath = result.canceled ? null : (result.filePaths[0] ?? null);
      if (selectedPath) {
        repositoryRoots.set(event.sender.id, await validateRepositoryWorkspace(selectedPath));
      }
      return selectedPath;
    });
    handle("repository:set-workspace", async (event, workspaceRoot: unknown) => {
      if (typeof workspaceRoot !== "string") throw new Error("工作区路径无效");
      const canonicalRoot = await validateRepositoryWorkspace(workspaceRoot);
      repositoryRoots.set(event.sender.id, canonicalRoot);
      return canonicalRoot;
    });
    handle("repository:list", (event, input: unknown) => {
      if (!input || typeof input !== "object" || !("path" in input)) {
        throw new Error("目录参数无效");
      }
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string") throw new Error("目录路径无效");
      const workspaceRoot = repositoryRoots.get(event.sender.id);
      if (!workspaceRoot) throw new Error("请先选择工作区");
      return listRepositoryDirectory({ workspaceRoot, path });
    });
    handle("repository:read", (event, input: unknown) => {
      if (!input || typeof input !== "object" || !("path" in input)) {
        throw new Error("文件参数无效");
      }
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string") throw new Error("文件路径无效");
      const workspaceRoot = repositoryRoots.get(event.sender.id);
      if (!workspaceRoot) throw new Error("请先选择工作区");
      return readRepositoryFile({ workspaceRoot, path });
    });
    handle("gateway:health", (_event, gatewayUrl: string) =>
      requestJson(gatewayUrl, "/health"),
    );
    handle("tasks:create", (_event, input: CreateTaskInput) => {
      const body = taskRequestBody(input, readExecutionSettings(app.getPath("userData")));
      return requestJson(input.gatewayUrl, "/v1/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
    });
    handle("sessions:list", (_event, gatewayUrl: string, offset = 0) =>
      requestJson(gatewayUrl, `/v1/sessions?offset=${encodeURIComponent(String(offset))}`),
    );
    handle("sessions:get", (_event, input: SessionRequestInput) =>
      requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`),
    );
    handle("sessions:mode", (_event, input: SessionRequestInput & { mode: MultiAgentMode }) =>
      requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`, {
        method: "PATCH", body: JSON.stringify({ multi_agent_mode: input.mode }),
      }),
    );
    handle("tasks:get", (_event, raw: TaskRequestInput) => {
      const input = validateTaskRequest(raw);
      return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}`);
    });
    handle("tasks:result", (_event, raw: TaskRequestInput) => {
      const input = validateTaskRequest(raw);
      return requestJson(
        input.gatewayUrl,
        `/v1/tasks/${encodeURIComponent(input.taskId)}/result`,
      );
    });
    handle("tasks:cancel", (_event, raw: TaskRequestInput) => {
      const input = validateTaskRequest(raw);
      return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}`, {
        method: "DELETE",
      });
    });
    handle("tasks:interact", (_event, raw: TaskInteractionInput) => {
      const input = validateTaskRequest(raw);
      return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/interaction`, {
        method: "POST",
        body: JSON.stringify({
          action: raw.action,
          ...(raw.text !== undefined ? { text: raw.text } : {}),
          ...(raw.questionId !== undefined ? { question_id: raw.questionId } : {}),
          ...(raw.optionId !== undefined ? { option_id: raw.optionId } : {}),
        }),
      });
    });
    ipcMain.on("tasks:watch", (event, input: TaskRequestInput) => {
      void watchTask(event.sender, input).catch(error => diagnostics.failure("desktop_watch_failed", error));
    });
    ipcMain.on("tasks:unwatch", (event, taskId: string) => {
      streamControllers.get(`${event.sender.id}:${taskId}`)?.abort();
    });

    createWindow();
    app.on("second-instance", () => {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing?.isMinimized()) existing.restore();
      existing?.focus();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(error => {
    const id = diagnostics.failure("desktop_initialization_failed", error);
    dialog.showErrorBox("启动失败", publicError(id));
    app.quit();
  });

  app.on("window-all-closed", () => {
    for (const controller of streamControllers.values()) controller.abort();
    if (process.platform !== "darwin") app.quit();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    for (const controller of streamControllers.values()) controller.abort();
    void stopManagedRuntime().finally(async () => { await diagnostics.close(); app.exit(0); });
  });

  app.on("child-process-gone", (_event, details) => diagnostics.failure("electron_child_gone", new Error(), {
    reason: details.reason, exit_code: details.exitCode, process: "electron", operation: details.type,
  }));

}
