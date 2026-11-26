import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  BUILTIN_LOCAL_BROWSER_MACHINE,
  BUILTIN_LOCAL_DESKTOP_MACHINE,
  readMachinesConfig,
  registeredWorkspace,
  resolveMachineStageKind,
  validateWorkspaceMachinesBinding,
  type BasewareMachineSpec,
  type WorkspaceMachinesBinding,
} from "@ludens/protocol/ludens";
import {
  BUILTIN_BROWSER_START_URL,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  encodeViewportFrame,
  type BrowserHostEvent,
  type DeviceStageKind,
  type MouseButtonName,
  type ViewportControlAction,
  type ViewportHumanInput,
  type ViewportState,
  type ViewportWsClientMessage,
  type ViewportWsServerMessage,
} from "@ludens/protocol/viewport";
import {
  BrowserHostClient,
  connectBasewareViewport,
  probeBrowserHost,
  type BasewareViewportClient,
} from "../daemon/browser-host-client.ts";
import { probeBasewareSocket } from "../query/workspaces.ts";
import type { EventHub } from "./event-hub.ts";
import { localRequest } from "./local-request.ts";
import { verifyMediaTicket } from "./media-ticket.ts";

export const VIEWPORT_WS_BACKPRESSURE_BYTES = 512 * 1024;
const STANDBY_POLL_INTERVAL_MS = 1500;
const RECONNECT_DELAY_MS = 250;
const BROWSER_OFFLINE_REASON = "Start Ludens Desktop App to enable Built-in Browser";

export interface ResolvedWorkspaceViewportTarget {
  workspaceId: string;
  workspacePath: string;
  stageKind: DeviceStageKind;
  machineId: string | null;
  driver: string | null;
  initialUrl: string;
  requestedMachineId?: string;
}

const VALID_MOUSE_BUTTONS = new Set<MouseButtonName>(["left", "middle", "right"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function validateViewportControlAction(raw: unknown): ViewportControlAction {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw Object.assign(new Error("Invalid viewport action: expected object with kind"), { status: 400 });
  }
  switch (raw.kind) {
    case "navigate": {
      if (typeof raw.url !== "string" || !raw.url.trim()) {
        throw Object.assign(new Error("navigate action requires a non-empty url"), { status: 400 });
      }
      return { kind: "navigate", url: raw.url.trim() };
    }
    case "back":
      return { kind: "back" };
    case "forward":
      return { kind: "forward" };
    case "reload":
      return { kind: "reload" };
    case "resize": {
      const width = Number(raw.width);
      const height = Number(raw.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw Object.assign(new Error("resize action requires positive width and height"), { status: 400 });
      }
      return { kind: "resize", width: Math.round(width), height: Math.round(height) };
    }
    default:
      throw Object.assign(new Error(`Unsupported viewport action kind: ${raw.kind}`), { status: 400 });
  }
}

export function validateViewportHumanInput(raw: unknown): ViewportHumanInput {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw Object.assign(new Error("Invalid viewport input: expected object with type"), { status: 400 });
  }
  const finiteNum = (val: unknown, name: string): number => {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw Object.assign(new Error(`viewport input ${raw.type} requires finite numeric ${name}`), { status: 400 });
    }
    return val;
  };
  const optNum = (val: unknown): number | undefined =>
    typeof val === "number" && Number.isFinite(val) ? val : undefined;

  switch (raw.type) {
    case "mouseMove":
      return {
        type: "mouseMove",
        x: finiteNum(raw.x, "x"),
        y: finiteNum(raw.y, "y"),
        ...(optNum(raw.buttons) !== undefined ? { buttons: optNum(raw.buttons) } : {}),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
      };
    case "mouseMoveRelative":
      return {
        type: "mouseMoveRelative",
        dx: finiteNum(raw.dx, "dx"),
        dy: finiteNum(raw.dy, "dy"),
        ...(optNum(raw.buttons) !== undefined ? { buttons: optNum(raw.buttons) } : {}),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
      };
    case "mouseDown":
    case "mouseUp": {
      const button = raw.button as MouseButtonName;
      if (typeof button !== "string" || !VALID_MOUSE_BUTTONS.has(button)) {
        throw Object.assign(new Error(`viewport input ${raw.type} requires button: left|middle|right`), { status: 400 });
      }
      return {
        type: raw.type,
        x: finiteNum(raw.x, "x"),
        y: finiteNum(raw.y, "y"),
        button,
        ...(optNum(raw.clickCount) !== undefined ? { clickCount: optNum(raw.clickCount) } : {}),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
      };
    }
    case "mouseWheel":
      return {
        type: "mouseWheel",
        x: finiteNum(raw.x, "x"),
        y: finiteNum(raw.y, "y"),
        deltaX: finiteNum(raw.deltaX, "deltaX"),
        deltaY: finiteNum(raw.deltaY, "deltaY"),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
      };
    case "keyDown": {
      if (typeof raw.key !== "string" || !raw.key) {
        throw Object.assign(new Error("keyDown requires non-empty key"), { status: 400 });
      }
      return {
        type: "keyDown",
        key: raw.key,
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        ...(typeof raw.text === "string" ? { text: raw.text } : {}),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
        ...(typeof raw.autoRepeat === "boolean" ? { autoRepeat: raw.autoRepeat } : {}),
      };
    }
    case "keyUp": {
      if (typeof raw.key !== "string" || !raw.key) {
        throw Object.assign(new Error("keyUp requires non-empty key"), { status: 400 });
      }
      return {
        type: "keyUp",
        key: raw.key,
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        ...(optNum(raw.modifiers) !== undefined ? { modifiers: optNum(raw.modifiers) } : {}),
      };
    }
    case "releaseAll":
      return { type: "releaseAll" };
    default:
      throw Object.assign(new Error(`Unsupported viewport input type: ${raw.type}`), { status: 400 });
  }
}

function makeUnavailableViewportState(
  target: ResolvedWorkspaceViewportTarget,
  reason?: string,
): ViewportState {
  const isBrowser = target.stageKind === "browser";
  return {
    stageKind: target.stageKind,
    available: false,
    connected: false,
    ...(reason ? { reason } : {}),
    machineId: target.machineId,
    driver: target.driver,
    ...(isBrowser ? { sessionId: target.workspaceId } : {}),
    width: DEFAULT_VIEWPORT_WIDTH,
    height: DEFAULT_VIEWPORT_HEIGHT,
    pointerLocked: false,
    controlMode: "offline",
    capabilities: {
      navigate: isBrowser,
      keyboard: isBrowser,
      mouse: isBrowser,
      pointerLock: isBrowser,
      resize: isBrowser,
      nativeEmbed: false,
    },
  };
}

function normalizeBrowserStandbyState(
  rawState: ViewportState,
  target: ResolvedWorkspaceViewportTarget,
  hostId: string | null,
): ViewportState {
  return {
    ...rawState,
    stageKind: "browser",
    available: true,
    connected: true,
    machineId: rawState.machineId ?? target.machineId ?? BUILTIN_LOCAL_BROWSER_MACHINE.id,
    driver: rawState.driver ?? "browser",
    sessionId: rawState.sessionId ?? target.workspaceId,
    ...(rawState.nativeHostId || hostId ? { nativeHostId: rawState.nativeHostId ?? hostId ?? undefined } : {}),
    controlMode: "manual",
  };
}

function normalizeBasewareViewportState(
  rawState: ViewportState,
  target: ResolvedWorkspaceViewportTarget,
): ViewportState {
  return {
    ...rawState,
    stageKind: rawState.stageKind ?? target.stageKind,
    machineId: rawState.machineId ?? target.machineId,
    driver: rawState.driver ?? target.driver,
    ...(target.stageKind === "browser" && !rawState.sessionId ? { sessionId: target.workspaceId } : {}),
  };
}

export async function resolveWorkspaceViewportTarget(
  home: string,
  project: string,
  options?: { workspace?: string; machineId?: string },
): Promise<ResolvedWorkspaceViewportTarget> {
  let entry: Awaited<ReturnType<typeof registeredWorkspace>>;
  try {
    entry = await registeredWorkspace(project, home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`Workspace not found: ${project}`), { status: 404, code: "NOT_FOUND" });
    }
    throw error;
  }

  const workspacePath = await realpath(entry.workspace).catch(() => resolve(entry.workspace));
  let rawConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(join(workspacePath, "ludens.json"), "utf8")) as unknown;
    if (isRecord(parsed)) rawConfig = parsed;
  } catch {
    // Missing or unreadable ludens.json falls back to observe stage.
  }

  const configDriver = typeof rawConfig.driver === "string" && rawConfig.driver.trim()
    ? rawConfig.driver.trim()
    : null;
  const configUrl = typeof rawConfig.url === "string" && rawConfig.url.trim()
    ? rawConfig.url.trim()
    : undefined;

  let binding: WorkspaceMachinesBinding | undefined;
  if (rawConfig.machines !== undefined) {
    try {
      binding = validateWorkspaceMachinesBinding(rawConfig.machines, "machines");
    } catch {
      binding = undefined;
    }
  }

  const requestedMachineId = options?.machineId?.trim() || undefined;
  const activeBindingId = binding?.active && binding.active !== "workspace-default" ? binding.active : undefined;
  const candidateMachineId = requestedMachineId ?? activeBindingId;

  let matchedMachine: BasewareMachineSpec | null = null;
  if (candidateMachineId === BUILTIN_LOCAL_BROWSER_MACHINE.id) {
    matchedMachine = BUILTIN_LOCAL_BROWSER_MACHINE;
  } else if (candidateMachineId) {
    try {
      const registry = await readMachinesConfig(home);
      matchedMachine = registry.machines.find(item => item.id === candidateMachineId) ?? null;
    } catch {
      matchedMachine = null;
    }
  } else if (configDriver === "browser") {
    matchedMachine = BUILTIN_LOCAL_BROWSER_MACHINE;
  } else if (configDriver === "cua") {
    matchedMachine = BUILTIN_LOCAL_DESKTOP_MACHINE;
  }

  const driver = matchedMachine?.driver ?? configDriver;
  const stageKind = matchedMachine
    ? resolveMachineStageKind(matchedMachine)
    : resolveMachineStageKind(driver ? { driver } : null);
  const machineId =
    matchedMachine?.id
    ?? candidateMachineId
    ?? (stageKind === "browser" ? BUILTIN_LOCAL_BROWSER_MACHINE.id : null);
  const initialUrl = matchedMachine?.initialUrl ?? configUrl ?? BUILTIN_BROWSER_START_URL;

  return {
    workspaceId: entry.id,
    workspacePath,
    stageKind,
    machineId,
    driver,
    initialUrl,
    ...(requestedMachineId ? { requestedMachineId } : {}),
  };
}

/** Resolve and describe the active viewport state for a workspace (Baseware live > standby BrowserHost > offline). */
export async function describeWorkspaceViewport(
  home: string,
  project: string,
  options?: { workspace?: string; machineId?: string; signal?: AbortSignal },
): Promise<ViewportState> {
  const target = await resolveWorkspaceViewportTarget(home, project, options);
  const basewareSocket = await probeBasewareSocket(target.workspacePath);

  if (basewareSocket) {
    let bwClient: BasewareViewportClient | null = null;
    try {
      bwClient = await connectBasewareViewport(basewareSocket, { timeoutMs: 1500 });
      const state = await bwClient.describe(target.requestedMachineId, {
        timeoutMs: 3000,
        signal: options?.signal,
      });
      return normalizeBasewareViewportState(state, target);
    } catch {
      if (target.stageKind === "computer") {
        return makeUnavailableViewportState(target, "Live computer viewport stream is not active");
      }
      if (target.stageKind === "observe") {
        return makeUnavailableViewportState(target);
      }
      // For browser targets, if Baseware does not expose viewport yet, fall through to BrowserHost check.
    } finally {
      bwClient?.close();
    }
  }

  if (target.stageKind === "browser") {
    const hostProbe = await probeBrowserHost(home);
    if (!hostProbe.available) {
      return makeUnavailableViewportState(target, BROWSER_OFFLINE_REASON);
    }
    let bhClient: BrowserHostClient | null = null;
    try {
      bhClient = await BrowserHostClient.connect(hostProbe.socketPath, { timeoutMs: 1500 });
      const state = await bhClient.ensureSession(
        {
          sessionId: target.workspaceId,
          initialUrl: target.initialUrl,
          width: DEFAULT_VIEWPORT_WIDTH,
          height: DEFAULT_VIEWPORT_HEIGHT,
        },
        { timeoutMs: 5000, signal: options?.signal },
      );
      return normalizeBrowserStandbyState(state, target, hostProbe.hostId);
    } catch {
      return makeUnavailableViewportState(target, BROWSER_OFFLINE_REASON);
    } finally {
      bhClient?.close();
    }
  }

  if (target.stageKind === "computer") {
    return makeUnavailableViewportState(target, "Live computer viewport stream is not active");
  }

  return makeUnavailableViewportState(target);
}

/** Dispatch a high-level viewport control action (navigate/back/forward/reload/resize). */
export async function performWorkspaceViewportAction(
  home: string,
  project: string,
  action: ViewportControlAction,
  options?: { workspace?: string; machineId?: string; signal?: AbortSignal },
): Promise<ViewportState> {
  const target = await resolveWorkspaceViewportTarget(home, project, options);
  const basewareSocket = await probeBasewareSocket(target.workspacePath);

  if (basewareSocket) {
    const bwClient = await connectBasewareViewport(basewareSocket, { timeoutMs: 1500 });
    try {
      const state = await bwClient.performAction(action, target.requestedMachineId, {
        timeoutMs: 10_000,
        signal: options?.signal,
      });
      return normalizeBasewareViewportState(state, target);
    } finally {
      bwClient.close();
    }
  }

  if (target.stageKind === "browser") {
    const hostProbe = await probeBrowserHost(home);
    if (!hostProbe.available) {
      throw Object.assign(new Error(BROWSER_OFFLINE_REASON), {
        status: 503,
        code: "BROWSER_HOST_OFFLINE",
      });
    }
    const bhClient = await BrowserHostClient.connect(hostProbe.socketPath, { timeoutMs: 1500 });
    try {
      await bhClient.ensureSession(
        {
          sessionId: target.workspaceId,
          initialUrl: target.initialUrl,
          width: DEFAULT_VIEWPORT_WIDTH,
          height: DEFAULT_VIEWPORT_HEIGHT,
        },
        { timeoutMs: 5000, signal: options?.signal },
      );
      const state = await bhClient.performAction(target.workspaceId, action, {
        timeoutMs: 10_000,
        signal: options?.signal,
      });
      return normalizeBrowserStandbyState(state, target, hostProbe.hostId);
    } finally {
      bhClient.close();
    }
  }

  throw Object.assign(
    new Error(
      target.stageKind === "computer"
        ? "Live computer viewport stream is not active"
        : "Viewport actions are not supported for this device",
    ),
    { status: 400 },
  );
}

/** Forward manual human pointer/keyboard input to the active viewport. */
export async function sendWorkspaceViewportInput(
  home: string,
  project: string,
  input: ViewportHumanInput,
  options?: { workspace?: string; machineId?: string; signal?: AbortSignal },
): Promise<{ ok: true; pointerLocked: boolean }> {
  const target = await resolveWorkspaceViewportTarget(home, project, options);
  const basewareSocket = await probeBasewareSocket(target.workspacePath);

  if (basewareSocket) {
    const bwClient = await connectBasewareViewport(basewareSocket, { timeoutMs: 1500 });
    try {
      return await bwClient.sendHumanInput(input, target.requestedMachineId, {
        timeoutMs: 5000,
        signal: options?.signal,
      });
    } finally {
      bwClient.close();
    }
  }

  if (target.stageKind === "browser") {
    const hostProbe = await probeBrowserHost(home);
    if (!hostProbe.available) {
      throw Object.assign(new Error(BROWSER_OFFLINE_REASON), {
        status: 503,
        code: "BROWSER_HOST_OFFLINE",
      });
    }
    const bhClient = await BrowserHostClient.connect(hostProbe.socketPath, { timeoutMs: 1500 });
    try {
      await bhClient.ensureSession(
        {
          sessionId: target.workspaceId,
          initialUrl: target.initialUrl,
          width: DEFAULT_VIEWPORT_WIDTH,
          height: DEFAULT_VIEWPORT_HEIGHT,
        },
        { timeoutMs: 5000, signal: options?.signal },
      );
      return await bhClient.sendHumanInput(target.workspaceId, input, {
        timeoutMs: 5000,
        signal: options?.signal,
      });
    } finally {
      bhClient.close();
    }
  }

  throw Object.assign(
    new Error(
      target.stageKind === "computer"
        ? "Live computer viewport stream is not active"
        : "Viewport input is not supported for this device",
    ),
    { status: 400 },
  );
}

export interface ViewportUpgradeAuthContext {
  authMode: "none" | "token";
  mediaSecret: Buffer;
  trustedOrigins: ReadonlySet<string>;
}

/** Verify `/viewport` WebSocket upgrade using the same ticket/origin policy as `/media`. */
export function authorizeViewportUpgrade(
  request: Request,
  url: URL,
  ctx: ViewportUpgradeAuthContext,
): Response | null {
  const ticket = url.searchParams.get("ticket") ?? url.searchParams.get("mt");

  if (ctx.authMode === "token") {
    if (!verifyMediaTicket(ctx.mediaSecret, ticket)) {
      return Response.json(
        { error: "Unauthorized", code: "UNAUTHORIZED" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return null;
  }

  if (ticket && verifyMediaTicket(ctx.mediaSecret, ticket)) {
    return null;
  }

  try {
    localRequest(request, {
      mutation: request.headers.has("origin"),
      trustedOrigins: ctx.trustedOrigins,
    });
    return null;
  } catch (error) {
    const status = (error as { status?: number } | null)?.status ?? 403;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export interface ViewportWsBridgeOptions {
  home: string;
  project: string;
  machineId?: string;
  eventHub: EventHub;
  onClose?: () => void;
}

type UpstreamConnection =
  | { kind: "baseware"; socketPath: string; client: BasewareViewportClient; target: ResolvedWorkspaceViewportTarget }
  | { kind: "browser-host"; socketPath: string; hostId: string | null; client: BrowserHostClient; target: ResolvedWorkspaceViewportTarget };

/**
 * Bridges one `/viewport` WebSocket client to either the workspace's live Baseware daemon
 * or standby Desktop `BrowserHost`, switching seamlessly as Baseware starts/stops and
 * applying single-slot drop-oldest backpressure on binary frame delivery.
 */
export class ViewportWsBridge<TData = unknown> {
  private readonly subscriberId = `viewport-ws:${randomUUID()}`;
  private upstream: UpstreamConnection | null = null;
  private upstreamGen = 0;
  private maxFps = 30;
  private quality = 75;
  private pendingFrame: Uint8Array | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling = false;
  private reconcileQueued = false;
  private closed = false;

  constructor(
    private readonly ws: ServerWebSocket<TData>,
    private readonly options: ViewportWsBridgeOptions,
  ) {}

  start(): void {
    if (this.closed) return;
    this.options.eventHub.subscribe(
      this.subscriberId,
      { topics: ["baseware", "core", "viewport"] },
      event => {
        if (this.closed) return;
        if (event.workspaceId && event.workspaceId !== this.options.project) return;
        this.scheduleReconcile(20);
      },
    );
    this.pollTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.upstream || this.upstream.kind === "browser-host") {
        void this.reconcile();
      }
    }, STANDBY_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();

    void this.reconcile();
  }

  onDrain(): void {
    if (this.closed || !this.pendingFrame) return;
    if (this.ws.getBufferedAmount() > VIEWPORT_WS_BACKPRESSURE_BYTES) {
      this.scheduleDrain();
      return;
    }
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.sendBinary(frame);
  }

  async handleRawMessage(raw: string | Buffer | Uint8Array): Promise<void> {
    if (this.closed) return;
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendJson({ type: "error", code: "INVALID_MESSAGE", message: "Malformed JSON message" });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.sendJson({ type: "error", code: "INVALID_MESSAGE", message: "Expected viewport WS control message" });
      return;
    }

    const msg = parsed as unknown as ViewportWsClientMessage;
    try {
      switch (msg.type) {
        case "subscribe": {
          if (typeof msg.maxFps === "number" && Number.isFinite(msg.maxFps) && msg.maxFps > 0) {
            this.maxFps = Math.max(1, Math.min(60, Math.round(msg.maxFps)));
          }
          if (typeof msg.quality === "number" && Number.isFinite(msg.quality) && msg.quality > 0) {
            this.quality = Math.max(10, Math.min(100, Math.round(msg.quality)));
          }
          if (this.upstream?.kind === "baseware") {
            const state = await this.upstream.client.subscribe({
              machine: this.upstream.target.requestedMachineId,
              maxFps: this.maxFps,
              quality: this.quality,
            });
            if (state) {
              this.sendJson({
                type: "state",
                state: normalizeBasewareViewportState(state, this.upstream.target),
              });
            }
          } else if (this.upstream?.kind === "browser-host") {
            const state = await this.upstream.client.subscribeFrames(this.upstream.target.workspaceId, {
              maxFps: this.maxFps,
              quality: this.quality,
            });
            if (state) {
              this.sendJson({
                type: "state",
                state: normalizeBrowserStandbyState(state, this.upstream.target, this.upstream.hostId),
              });
            }
          } else {
            await this.reconcile();
          }
          break;
        }
        case "input": {
          const input = validateViewportHumanInput(msg.input);
          if (this.upstream?.kind === "baseware") {
            await this.upstream.client.sendHumanInput(input, this.upstream.target.requestedMachineId);
          } else if (this.upstream?.kind === "browser-host") {
            await this.upstream.client.sendHumanInput(this.upstream.target.workspaceId, input);
          } else {
            await sendWorkspaceViewportInput(this.options.home, this.options.project, input, {
              machineId: this.options.machineId,
            });
          }
          break;
        }
        case "action": {
          const action = validateViewportControlAction(msg.action);
          let state: ViewportState;
          if (this.upstream?.kind === "baseware") {
            const rawState = await this.upstream.client.performAction(action, this.upstream.target.requestedMachineId);
            state = normalizeBasewareViewportState(rawState, this.upstream.target);
          } else if (this.upstream?.kind === "browser-host") {
            const rawState = await this.upstream.client.performAction(this.upstream.target.workspaceId, action);
            state = normalizeBrowserStandbyState(rawState, this.upstream.target, this.upstream.hostId);
          } else {
            state = await performWorkspaceViewportAction(this.options.home, this.options.project, action, {
              machineId: this.options.machineId,
            });
          }
          this.sendJson({ type: "state", state });
          break;
        }
        default:
          this.sendJson({ type: "error", code: "INVALID_MESSAGE", message: `Unknown message type` });
      }
    } catch (error) {
      this.sendJson({
        type: "error",
        code: (error as { code?: string } | null)?.code ?? "VIEWPORT_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.upstreamGen++;
    this.options.eventHub.removeSubscriber(this.subscriberId);
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingFrame = null;
    this.closeUpstream();
    this.options.onClose?.();
  }

  private scheduleReconcile(delayMs = RECONNECT_DELAY_MS): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private closeUpstream(): void {
    const prev = this.upstream;
    this.upstream = null;
    prev?.client.close();
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    if (this.reconciling) {
      this.reconcileQueued = true;
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcileOnce();
    } finally {
      this.reconciling = false;
      if (this.reconcileQueued && !this.closed) {
        this.reconcileQueued = false;
        void this.reconcile();
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (this.closed) return;

    let target: ResolvedWorkspaceViewportTarget;
    try {
      target = await resolveWorkspaceViewportTarget(this.options.home, this.options.project, {
        machineId: this.options.machineId,
      });
    } catch (error) {
      this.closeUpstream();
      this.sendJson({
        type: "error",
        code: (error as { code?: string } | null)?.code ?? "NOT_FOUND",
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        this.ws.close(1008, "Workspace not found");
      } catch {}
      return;
    }

    const basewareSocket = await probeBasewareSocket(target.workspacePath);
    if (this.closed) return;

    // 1. Prefer live Baseware daemon whenever running (honors BasewareCore epoch control arbitration).
    if (basewareSocket) {
      if (this.upstream?.kind === "baseware" && this.upstream.socketPath === basewareSocket) {
        // Refresh state in case controlMode (manual <-> auto) changed.
        try {
          const state = await this.upstream.client.describe(target.requestedMachineId, { timeoutMs: 2000 });
          if (!this.closed) {
            this.sendJson({ type: "state", state: normalizeBasewareViewportState(state, target) });
          }
          return;
        } catch {
          // Fall through to reconnect cleanly.
        }
      }

      const gen = ++this.upstreamGen;
      let bwClient: BasewareViewportClient | null = null;
      try {
        bwClient = await connectBasewareViewport(basewareSocket, {
          timeoutMs: 2000,
          onEvent: event => {
            if (this.closed || this.upstreamGen !== gen) return;
            this.handleUpstreamEvent(event, target, "baseware", null);
          },
          onDeviceEvent: deviceEvent => {
            if (this.closed || this.upstreamGen !== gen) return;
            if (
              deviceEvent.type === "baseware_control"
              || deviceEvent.type === "baseware_disconnected"
              || deviceEvent.type === "baseware_reconnected"
            ) {
              this.scheduleReconcile(20);
            }
          },
          onDisconnect: () => {
            if (this.closed || this.upstreamGen !== gen) return;
            if (this.upstream?.client === bwClient) {
              this.upstream = null;
            }
            this.scheduleReconcile(RECONNECT_DELAY_MS);
          },
        });
        const initialState = await bwClient.describe(target.requestedMachineId, { timeoutMs: 3000 });
        await bwClient.subscribe(
          { machine: target.requestedMachineId, maxFps: this.maxFps, quality: this.quality },
          { timeoutMs: 3000 },
        );
        if (this.closed || this.upstreamGen !== gen) {
          bwClient.close();
          return;
        }
        this.closeUpstream();
        this.upstream = { kind: "baseware", socketPath: basewareSocket, client: bwClient, target };
        this.sendJson({ type: "state", state: normalizeBasewareViewportState(initialState, target) });
        return;
      } catch {
        bwClient?.close();
        if (target.stageKind === "computer") {
          this.closeUpstream();
          this.sendJson({
            type: "state",
            state: makeUnavailableViewportState(target, "Live computer viewport stream is not active"),
          });
          return;
        }
        if (target.stageKind === "observe") {
          this.closeUpstream();
          this.sendJson({ type: "state", state: makeUnavailableViewportState(target) });
          return;
        }
        // For browser stage, fall through to standby BrowserHost if Baseware failed to provide viewport.
      }
    }

    // 2. Standby BrowserHost direct streaming for `browser` workspaces when Baseware is not running.
    if (target.stageKind === "browser") {
      const hostProbe = await probeBrowserHost(this.options.home);
      if (this.closed) return;

      if (!hostProbe.available) {
        this.closeUpstream();
        this.sendJson({
          type: "state",
          state: makeUnavailableViewportState(target, BROWSER_OFFLINE_REASON),
        });
        return;
      }

      if (this.upstream?.kind === "browser-host" && this.upstream.socketPath === hostProbe.socketPath) {
        return;
      }

      const gen = ++this.upstreamGen;
      let bhClient: BrowserHostClient | null = null;
      try {
        bhClient = await BrowserHostClient.connect(hostProbe.socketPath, {
          timeoutMs: 2000,
          onEvent: event => {
            if (this.closed || this.upstreamGen !== gen) return;
            this.handleUpstreamEvent(event, target, "browser-host", hostProbe.hostId);
          },
          onDisconnect: () => {
            if (this.closed || this.upstreamGen !== gen) return;
            if (this.upstream?.client === bhClient) {
              this.upstream = null;
            }
            this.scheduleReconcile(RECONNECT_DELAY_MS);
          },
        });
        const ensuredState = await bhClient.ensureSession(
          {
            sessionId: target.workspaceId,
            initialUrl: target.initialUrl,
            width: DEFAULT_VIEWPORT_WIDTH,
            height: DEFAULT_VIEWPORT_HEIGHT,
          },
          { timeoutMs: 5000 },
        );
        await bhClient.subscribeFrames(
          target.workspaceId,
          { maxFps: this.maxFps, quality: this.quality },
          { timeoutMs: 3000 },
        );
        if (this.closed || this.upstreamGen !== gen) {
          bhClient.close();
          return;
        }
        this.closeUpstream();
        this.upstream = {
          kind: "browser-host",
          socketPath: hostProbe.socketPath,
          hostId: hostProbe.hostId,
          client: bhClient,
          target,
        };
        this.sendJson({
          type: "state",
          state: normalizeBrowserStandbyState(ensuredState, target, hostProbe.hostId),
        });
        return;
      } catch {
        bhClient?.close();
        this.closeUpstream();
        this.sendJson({
          type: "state",
          state: makeUnavailableViewportState(target, BROWSER_OFFLINE_REASON),
        });
        return;
      }
    }

    // 3. Computer or observe target with no live Baseware viewport stream.
    this.closeUpstream();
    this.sendJson({
      type: "state",
      state: makeUnavailableViewportState(
        target,
        target.stageKind === "computer" ? "Live computer viewport stream is not active" : undefined,
      ),
    });
  }

  private handleUpstreamEvent(
    event: BrowserHostEvent,
    target: ResolvedWorkspaceViewportTarget,
    sourceKind: "baseware" | "browser-host",
    hostId: string | null,
  ): void {
    if (this.closed) return;
    if (event.event === "state") {
      const state = sourceKind === "browser-host"
        ? normalizeBrowserStandbyState(event.state, target, hostId)
        : normalizeBasewareViewportState(event.state, target);
      this.sendJson({ type: "state", state });
      return;
    }
    if (event.event === "frame") {
      const payload = Buffer.from(event.dataBase64, "base64");
      const encoded = encodeViewportFrame({
        format: event.format,
        width: event.width,
        height: event.height,
        timestampMs: event.timestampMs,
        seq: event.seq,
        pointerLocked: event.pointerLocked,
        bytes: payload,
      });
      this.enqueueFrame(encoded);
    }
  }

  private enqueueFrame(encoded: Uint8Array): void {
    if (this.closed) return;
    if (this.ws.getBufferedAmount() > VIEWPORT_WS_BACKPRESSURE_BYTES) {
      // Single-slot drop-oldest backpressure: overwrite any un-flushed older frame.
      this.pendingFrame = encoded;
      this.scheduleDrain();
      return;
    }
    this.pendingFrame = null;
    this.sendBinary(encoded);
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.closed) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.onDrain();
    }, 16);
    this.drainTimer.unref?.();
  }

  private sendBinary(packet: Uint8Array): void {
    if (this.closed) return;
    try {
      this.ws.sendBinary(packet);
    } catch {
      // Socket teardown runs via WebSocket close callback.
    }
  }

  private sendJson(message: ViewportWsServerMessage): void {
    if (this.closed) return;
    try {
      this.ws.sendText(JSON.stringify(message));
    } catch {
      // Socket teardown runs via WebSocket close callback.
    }
  }
}
