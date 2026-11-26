import { readFile } from "node:fs/promises";
import { browserHostRuntimeFilePath, resolveBrowserHostSocketPath } from "@ludens/protocol/browser-host-paths";
import { ludensHome } from "@ludens/protocol/ludens";
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  type BrowserHostCaptureResult,
  type BrowserHostEvent,
  type BrowserInputStep,
  type MouseButtonName,
  type ViewportFrameFormat,
  type ViewportState,
} from "@ludens/protocol/viewport";
import type {
  Capabilities,
  Clock,
  Controller,
  Observation,
  ToolArguments,
  ToolDefinition,
  ToolResult,
  ViewportProvider,
} from "../../contracts.ts";
import { structuredResult, toolExecution } from "../../tool-contract.ts";
import { NO_ARGUMENTS } from "../schema.ts";
import type { DriverProvider } from "../registry.ts";
import { BrowserHostClient } from "./client.ts";

export interface BrowserProviderOptions {
  sessionId?: string;
  initialUrl?: string;
  browserSocket?: string;
  width?: number;
  height?: number;
  clock: Clock;
}

const MOUSE_BUTTON_SCHEMA = {
  type: "string",
  enum: ["left", "middle", "right"],
  description: "Mouse button name.",
} as const;

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal.throwIfAborted();
    return Promise.resolve();
  }
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted")));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

async function resolveDefaultBrowserHostSocket(): Promise<string> {
  const home = ludensHome();
  try {
    const raw = JSON.parse(await readFile(browserHostRuntimeFilePath(home), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const candidate = (raw as { socketPath?: unknown }).socketPath;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  } catch {
    // Fall back to deterministic socket path when runtime file is absent.
  }
  return resolveBrowserHostSocketPath(home);
}

export async function createBrowserProvider(options: BrowserProviderOptions): Promise<DriverProvider> {
  const sessionId = options.sessionId?.trim() || "default";
  const socketPath = options.browserSocket?.trim() || await resolveDefaultBrowserHostSocket();
  const width = options.width ?? DEFAULT_VIEWPORT_WIDTH;
  const height = options.height ?? DEFAULT_VIEWPORT_HEIGHT;
  const { clock } = options;

  const client = await BrowserHostClient.connect(socketPath);
  try {
    await client.request<ViewportState>({
      kind: "session.ensure",
      sessionId,
      ...(options.initialUrl ? { initialUrl: options.initialUrl } : {}),
      width,
      height,
    });
  } catch (error) {
    client.close();
    throw error;
  }

  // Track active viewport stream subscribers on this provider so multiple consumers
  // share a single BrowserHost session subscription cleanly.
  const subscribers = new Map<
    symbol,
    { maxFps?: number; quality?: number; onEvent: (event: BrowserHostEvent) => void }
  >();

  client.addEventListener(event => {
    if (event.sessionId !== sessionId) return;
    for (const sub of subscribers.values()) {
      try {
        sub.onEvent(event);
      } catch {
        /* subscriber owns its transport */
      }
    }
  });

  const effectiveSubscriptionParams = (): { maxFps?: number; quality?: number } => {
    let maxFps: number | undefined;
    let quality: number | undefined;
    for (const sub of subscribers.values()) {
      if (sub.maxFps !== undefined) maxFps = maxFps === undefined ? sub.maxFps : Math.max(maxFps, sub.maxFps);
      if (sub.quality !== undefined) quality = quality === undefined ? sub.quality : Math.max(quality, sub.quality);
    }
    return {
      ...(maxFps !== undefined ? { maxFps } : {}),
      ...(quality !== undefined ? { quality } : {}),
    };
  };

  const viewport: ViewportProvider = {
    describe: signal => client.request<ViewportState>({ kind: "session.describe", sessionId }, signal),
    performAction: (action, signal) =>
      client.request<ViewportState>({ kind: "session.action", sessionId, action }, signal),
    sendHumanInput: (input, signal) =>
      client.request<{ ok: true; pointerLocked: boolean }>({ kind: "session.input", sessionId, input }, signal),
    subscribe: async (subOptions, onEvent) => {
      const token = Symbol("viewport-sub");
      subscribers.set(token, {
        maxFps: subOptions.maxFps,
        quality: subOptions.quality,
        onEvent,
      });
      const params = effectiveSubscriptionParams();
      try {
        await client.request({
          kind: "session.subscribe",
          sessionId,
          ...params,
        });
      } catch (error) {
        subscribers.delete(token);
        throw error;
      }
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        if (!subscribers.delete(token)) return;
        if (client.isClosed || client.isDisconnected) return;
        if (subscribers.size === 0) {
          void client.request({ kind: "session.unsubscribe", sessionId }).catch(() => {});
        } else {
          const next = effectiveSubscriptionParams();
          void client.request({ kind: "session.subscribe", sessionId, ...next }).catch(() => {});
        }
      };
    },
  };

  // Shared idempotent acquire / release across all requiresControl controllers.
  const inFlightPlays = new Set<AbortController>();
  let ownerEpoch: string | undefined;
  let releasingEpoch: string | undefined;
  let releasePromise: Promise<void> | undefined;

  const acquire = async (epoch: string): Promise<void> => {
    ownerEpoch = epoch;
  };

  const release = async (epoch: string): Promise<void> => {
    if (releasingEpoch === epoch && releasePromise) {
      return releasePromise;
    }
    if (ownerEpoch !== epoch) return;
    ownerEpoch = undefined;
    releasingEpoch = epoch;

    for (const controller of inFlightPlays) {
      controller.abort(new Error("Control released"));
    }
    inFlightPlays.clear();

    const pending = (async () => {
      if (!client.isClosed && !client.isDisconnected) {
        await client.request({ kind: "session.releaseAll", sessionId });
      }
    })().finally(() => {
      if (releasingEpoch === epoch) {
        releasingEpoch = undefined;
        releasePromise = undefined;
      }
    });
    releasePromise = pending;
    return pending;
  };

  const makeController = (
    tool: ToolDefinition,
    requiresControl: boolean,
    run: (args: ToolArguments, signal: AbortSignal) => Promise<Record<string, unknown>>,
    extra?: { mediaTypes?: readonly string[] },
  ): Controller => ({
    tool,
    requiresControl,
    ...(extra?.mediaTypes ? { mediaTypes: extra.mediaTypes } : {}),
    ...(requiresControl ? { acquire, release } : {}),
    async execute(args, { signal }) {
      signal.throwIfAborted();
      const requestedAtMs = clock.now();
      const output = await run(args, signal);
      return toolExecution(clock, requestedAtMs, structuredResult(output));
    },
  });

  const screenCaptureController: Controller = {
    tool: {
      name: "screen.capture",
      description: "Capture the current visual frame of the built-in browser viewport.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["jpeg", "png", "webp"], description: "Image encoding format." },
          quality: { type: "integer", minimum: 1, maximum: 100, description: "Encoder quality (1-100) for lossy formats." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    requiresControl: false,
    mediaTypes: ["image/jpeg", "image/png"],
    async execute(args, { signal }) {
      signal.throwIfAborted();
      const requestedAtMs = clock.now();
      const format = args.format as ViewportFrameFormat | undefined;
      const quality = args.quality as number | undefined;
      const capture = await client.request<BrowserHostCaptureResult>(
        {
          kind: "session.capture",
          sessionId,
          ...(format !== undefined ? { format } : {}),
          ...(quality !== undefined ? { quality } : {}),
        },
        signal,
      );
      const structuredContent = {
        width: capture.width,
        height: capture.height,
        seq: capture.seq,
        url: capture.url,
        title: capture.title,
        pointerLocked: capture.pointerLocked,
      };
      const result: ToolResult = {
        content: [{ type: "image", data: capture.dataBase64, mimeType: capture.mediaType }],
        structuredContent,
      };
      const execution = toolExecution(clock, requestedAtMs, result);
      const observation: Observation = {
        id: crypto.randomUUID(),
        controllerId: "screen.capture",
        mediaType: capture.mediaType,
        timing: execution.timing,
        sourceSequence: capture.seq,
        contentIndex: 0,
      };
      return { ...execution, observations: [observation] };
    },
  };

  const controllers: Controller[] = [
    screenCaptureController,
    makeController(
      {
        name: "page.state",
        description: "Read current browser navigation and viewport metadata without accessing page DOM or JS memory.",
        inputSchema: NO_ARGUMENTS,
        annotations: { readOnlyHint: true },
      },
      false,
      async (_args, signal) => {
        const state = await client.request<ViewportState>({ kind: "session.describe", sessionId }, signal);
        return {
          sessionId: state.sessionId ?? sessionId,
          width: state.width,
          height: state.height,
          pointerLocked: state.pointerLocked,
          connected: state.connected,
          available: state.available,
          stageKind: state.stageKind,
          navigation: state.navigation ?? null,
          capabilities: state.capabilities,
        };
      },
    ),
    makeController(
      {
        name: "page.open",
        description: "Navigate the built-in browser viewport to a URL.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", minLength: 1, description: "Target URL to load." },
          },
          required: ["url"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const state = await client.request<ViewportState>(
          { kind: "session.action", sessionId, action: { kind: "navigate", url: args.url as string } },
          signal,
        );
        return asRecord(state);
      },
    ),
    makeController(
      {
        name: "page.reload",
        description: "Reload the current page in the built-in browser viewport.",
        inputSchema: NO_ARGUMENTS,
        annotations: { readOnlyHint: false },
      },
      true,
      async (_args, signal) => {
        const state = await client.request<ViewportState>(
          { kind: "session.action", sessionId, action: { kind: "reload" } },
          signal,
        );
        return asRecord(state);
      },
    ),
    makeController(
      {
        name: "page.back",
        description: "Navigate back in the browser session history.",
        inputSchema: NO_ARGUMENTS,
        annotations: { readOnlyHint: false },
      },
      true,
      async (_args, signal) => {
        const state = await client.request<ViewportState>(
          { kind: "session.action", sessionId, action: { kind: "back" } },
          signal,
        );
        return asRecord(state);
      },
    ),
    makeController(
      {
        name: "page.forward",
        description: "Navigate forward in the browser session history.",
        inputSchema: NO_ARGUMENTS,
        annotations: { readOnlyHint: false },
      },
      true,
      async (_args, signal) => {
        const state = await client.request<ViewportState>(
          { kind: "session.action", sessionId, action: { kind: "forward" } },
          signal,
        );
        return asRecord(state);
      },
    ),
    makeController(
      {
        name: "viewport.resize",
        description: "Resize the logical pixel dimensions of the browser viewport.",
        inputSchema: {
          type: "object",
          properties: {
            width: { type: "integer", minimum: 1, maximum: 7680 },
            height: { type: "integer", minimum: 1, maximum: 4320 },
          },
          required: ["width", "height"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const state = await client.request<ViewportState>(
          {
            kind: "session.action",
            sessionId,
            action: { kind: "resize", width: args.width as number, height: args.height as number },
          },
          signal,
        );
        return asRecord(state);
      },
    ),
    makeController(
      {
        name: "keyboard.down",
        description: "Press and hold a keyboard key.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            code: { type: "string" },
            text: { type: "string" },
            modifiers: { type: "integer", minimum: 0 },
          },
          required: ["key"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "keyDown",
              key: args.key as string,
              ...(args.code !== undefined ? { code: args.code as string } : {}),
              ...(args.text !== undefined ? { text: args.text as string } : {}),
              ...(args.modifiers !== undefined ? { modifiers: args.modifiers as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "keyboard.up",
        description: "Release a held keyboard key.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            code: { type: "string" },
            modifiers: { type: "integer", minimum: 0 },
          },
          required: ["key"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "keyUp",
              key: args.key as string,
              ...(args.code !== undefined ? { code: args.code as string } : {}),
              ...(args.modifiers !== undefined ? { modifiers: args.modifiers as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "keyboard.press",
        description: "Press and release a keyboard key after an optional hold duration.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            code: { type: "string" },
            text: { type: "string" },
            durationMs: { type: "integer", minimum: 0, maximum: 60000 },
          },
          required: ["key"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const key = args.key as string;
        const code = args.code as string | undefined;
        const text = args.text as string | undefined;
        const durationMs = (args.durationMs as number | undefined) ?? 40;
        await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "keyDown",
              key,
              ...(code !== undefined ? { code } : {}),
              ...(text !== undefined ? { text } : {}),
            },
          },
          signal,
        );
        try {
          await sleepAbortable(durationMs, signal);
        } catch (error) {
          if (!client.isClosed && !client.isDisconnected) {
            void client
              .request({
                kind: "session.input",
                sessionId,
                input: { type: "keyUp", key, ...(code !== undefined ? { code } : {}) },
              })
              .catch(() => {});
          }
          throw error;
        }
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: { type: "keyUp", key, ...(code !== undefined ? { code } : {}) },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "keyboard.type",
        description: "Type a string of text into the focused element in the browser viewport.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          { kind: "session.type", sessionId, text: args.text as string },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.move",
        description: "Move the mouse pointer to absolute viewport coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            buttons: { type: "integer", minimum: 0 },
            modifiers: { type: "integer", minimum: 0 },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "mouseMove",
              x: args.x as number,
              y: args.y as number,
              ...(args.buttons !== undefined ? { buttons: args.buttons as number } : {}),
              ...(args.modifiers !== undefined ? { modifiers: args.modifiers as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.moveRelative",
        description: "Send relative pointer movement deltas (dx, dy) for Pointer Lock 3D camera controls.",
        inputSchema: {
          type: "object",
          properties: {
            dx: { type: "number" },
            dy: { type: "number" },
            buttons: { type: "integer", minimum: 0 },
            modifiers: { type: "integer", minimum: 0 },
          },
          required: ["dx", "dy"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "mouseMoveRelative",
              dx: args.dx as number,
              dy: args.dy as number,
              ...(args.buttons !== undefined ? { buttons: args.buttons as number } : {}),
              ...(args.modifiers !== undefined ? { modifiers: args.modifiers as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.down",
        description: "Press and hold a mouse button at viewport coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            button: MOUSE_BUTTON_SCHEMA,
            clickCount: { type: "integer", minimum: 1 },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "mouseDown",
              x: args.x as number,
              y: args.y as number,
              button: (args.button as MouseButtonName | undefined) ?? "left",
              ...(args.clickCount !== undefined ? { clickCount: args.clickCount as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.up",
        description: "Release a mouse button at viewport coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            button: MOUSE_BUTTON_SCHEMA,
            clickCount: { type: "integer", minimum: 1 },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "mouseUp",
              x: args.x as number,
              y: args.y as number,
              button: (args.button as MouseButtonName | undefined) ?? "left",
              ...(args.clickCount !== undefined ? { clickCount: args.clickCount as number } : {}),
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.click",
        description: "Click a mouse button at viewport coordinates with an optional hold duration.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            button: MOUSE_BUTTON_SCHEMA,
            clickCount: { type: "integer", minimum: 1 },
            durationMs: { type: "integer", minimum: 0, maximum: 60000 },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const x = args.x as number;
        const y = args.y as number;
        const button = (args.button as MouseButtonName | undefined) ?? "left";
        const clickCount = (args.clickCount as number | undefined) ?? 1;
        const durationMs = (args.durationMs as number | undefined) ?? 30;
        await client.request(
          {
            kind: "session.input",
            sessionId,
            input: { type: "mouseDown", x, y, button, clickCount },
          },
          signal,
        );
        try {
          await sleepAbortable(durationMs, signal);
        } catch (error) {
          if (!client.isClosed && !client.isDisconnected) {
            void client
              .request({
                kind: "session.input",
                sessionId,
                input: { type: "mouseUp", x, y, button, clickCount },
              })
              .catch(() => {});
          }
          throw error;
        }
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: { type: "mouseUp", x, y, button, clickCount },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "mouse.wheel",
        description: "Scroll the mouse wheel at viewport coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            deltaX: { type: "number" },
            deltaY: { type: "number" },
          },
          required: ["x", "y", "deltaY"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const res = await client.request(
          {
            kind: "session.input",
            sessionId,
            input: {
              type: "mouseWheel",
              x: args.x as number,
              y: args.y as number,
              deltaX: (args.deltaX as number | undefined) ?? 0,
              deltaY: args.deltaY as number,
            },
          },
          signal,
        );
        return asRecord(res);
      },
    ),
    makeController(
      {
        name: "input.play",
        description: "Execute a millisecond-timed batch of keyboard and mouse input steps; supports cancellation on abort or control release.",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  atMs: { type: "number", minimum: 0 },
                  durationMs: { type: "number", minimum: 0 },
                  keys: { type: "array", items: { type: "string", minLength: 1 } },
                  mouseButton: MOUSE_BUTTON_SCHEMA,
                  x: { type: "number" },
                  y: { type: "number" },
                  dx: { type: "number" },
                  dy: { type: "number" },
                  wheelX: { type: "number" },
                  wheelY: { type: "number" },
                },
                required: ["atMs"],
                additionalProperties: false,
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      true,
      async (args, signal) => {
        const playAbort = new AbortController();
        inFlightPlays.add(playAbort);
        const combinedSignal = AbortSignal.any([signal, playAbort.signal]);
        try {
          const res = await client.request(
            {
              kind: "session.play",
              sessionId,
              steps: args.steps as BrowserInputStep[],
            },
            combinedSignal,
          );
          return asRecord(res);
        } finally {
          inFlightPlays.delete(playAbort);
        }
      },
    ),
  ];

  const capabilities: Capabilities = { controllers, viewport };

  return {
    capabilities,
    version: "builtin",
    onDisconnect(handler: (error: Error) => void) {
      client.onDisconnect(handler);
    },
    close() {
      for (const controller of inFlightPlays) {
        controller.abort(new Error("Browser provider closed"));
      }
      inFlightPlays.clear();
      subscribers.clear();
      // Detach/close client socket only; preserve persistent session in BrowserHost.
      client.close();
    },
  };
}
