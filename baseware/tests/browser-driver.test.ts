import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserHostCaptureResult,
  BrowserHostEnvelope,
  BrowserHostEvent,
  BrowserHostRequest,
  BrowserHostWireMessage,
  ViewportState,
} from "@ludens/protocol/viewport";
import { BasewareClient } from "../src/client.ts";
import { BasewareCore } from "../src/core.ts";
import { createBrowserProvider } from "../src/drivers/browser/provider.ts";
import { getDriver } from "../src/drivers/registry.ts";
import type { DeviceEvent } from "../src/protocol.ts";
import { listen } from "../src/server.ts";

const clock = { id: "browser-test", now: () => performance.now() };
const FAKE_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const FAKE_JPEG_BASE64 = FAKE_JPEG_BYTES.toString("base64");

interface MockBrowserHost {
  socketPath: string;
  requests: BrowserHostEnvelope[];
  cancelledOperationIds: string[];
  sockets: Set<Socket>;
  pushEvent(event: BrowserHostEvent): void;
  disconnectAll(): void;
  close(): Promise<void>;
}

async function startMockBrowserHost(
  socketPath: string,
  options: {
    holdPlay?: boolean;
  } = {},
): Promise<MockBrowserHost> {
  const requests: BrowserHostEnvelope[] = [];
  const cancelledOperationIds: string[] = [];
  const sockets = new Set<Socket>();
  const pendingPlays = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();
  const stateBySession = new Map<string, ViewportState>();
  let captureSeq = 0;

  const ensureState = (sessionId: string, initialUrl?: string, width = 1280, height = 720): ViewportState => {
    let state = stateBySession.get(sessionId);
    if (!state) {
      state = {
        stageKind: "browser",
        available: true,
        connected: true,
        machineId: null,
        driver: "browser",
        sessionId,
        nativeHostId: "mock-host-1",
        width,
        height,
        pointerLocked: false,
        controlMode: "manual",
        navigation: {
          url: initialUrl ?? "ludens-browser://start",
          title: "Mock Start Page",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        capabilities: {
          navigate: true,
          keyboard: true,
          mouse: true,
          pointerLock: true,
          resize: true,
          nativeEmbed: true,
        },
      };
      stateBySession.set(sessionId, state);
    }
    return state;
  };

  const send = (socket: Socket, msg: BrowserHostWireMessage) => {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + "\n");
  };

  const server: Server = createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [opId, entry] of pendingPlays) {
        if (entry.socket === socket) {
          clearTimeout(entry.timer);
          pendingPlays.delete(opId);
        }
      }
    });
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const envelope = JSON.parse(line) as BrowserHostEnvelope;
        requests.push(envelope);
        const req: BrowserHostRequest = envelope.request;
        switch (req.kind) {
          case "session.ensure": {
            const state = ensureState(req.sessionId, req.initialUrl, req.width, req.height);
            send(socket, { id: envelope.id, ok: true, value: state });
            break;
          }
          case "session.describe": {
            const state = ensureState(req.sessionId);
            send(socket, { id: envelope.id, ok: true, value: state });
            break;
          }
          case "session.action": {
            const state = ensureState(req.sessionId);
            if (req.action.kind === "navigate") {
              state.navigation = {
                url: req.action.url,
                title: `Page: ${req.action.url}`,
                loading: false,
                canGoBack: true,
                canGoForward: false,
              };
            } else if (req.action.kind === "resize") {
              state.width = req.action.width;
              state.height = req.action.height;
            }
            send(socket, { id: envelope.id, ok: true, value: state });
            break;
          }
          case "session.capture": {
            const state = ensureState(req.sessionId);
            const seq = ++captureSeq;
            const format = req.format ?? "jpeg";
            const mediaType = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
            const capture: BrowserHostCaptureResult = {
              format,
              mediaType,
              dataBase64: FAKE_JPEG_BASE64,
              width: state.width,
              height: state.height,
              seq,
              timestampMs: Date.now(),
              pointerLocked: state.pointerLocked,
              url: state.navigation?.url ?? "ludens-browser://start",
              title: state.navigation?.title ?? "Mock",
            };
            send(socket, { id: envelope.id, ok: true, value: capture });
            break;
          }
          case "session.input": {
            const state = ensureState(req.sessionId);
            if (req.input.type === "mouseMoveRelative") state.pointerLocked = true;
            if (req.input.type === "releaseAll") state.pointerLocked = false;
            send(socket, { id: envelope.id, ok: true, value: { ok: true, pointerLocked: state.pointerLocked } });
            break;
          }
          case "session.type": {
            send(socket, { id: envelope.id, ok: true, value: { ok: true, length: req.text.length } });
            break;
          }
          case "session.play": {
            if (options.holdPlay) {
              const timer = setTimeout(() => {
                pendingPlays.delete(envelope.id);
                send(socket, { id: envelope.id, ok: true, value: { ok: true, steps: req.steps.length } });
              }, 30_000);
              pendingPlays.set(envelope.id, { socket, timer });
            } else {
              send(socket, { id: envelope.id, ok: true, value: { ok: true, steps: req.steps.length } });
            }
            break;
          }
          case "session.releaseAll": {
            const state = ensureState(req.sessionId);
            state.pointerLocked = false;
            send(socket, { id: envelope.id, ok: true, value: { ok: true } });
            break;
          }
          case "session.subscribe": {
            send(socket, { id: envelope.id, ok: true, value: { subscribed: true } });
            break;
          }
          case "session.unsubscribe": {
            send(socket, { id: envelope.id, ok: true, value: { unsubscribed: true } });
            break;
          }
          case "cancel": {
            cancelledOperationIds.push(req.operationId);
            const pending = pendingPlays.get(req.operationId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingPlays.delete(req.operationId);
              send(pending.socket, { id: req.operationId, ok: false, error: "Cancelled" });
            }
            send(socket, { id: envelope.id, ok: true, value: { cancelled: Boolean(pending) } });
            break;
          }
          default:
            send(socket, { id: envelope.id, ok: false, error: `Unexpected request: ${req.kind}` });
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    requests,
    cancelledOperationIds,
    sockets,
    pushEvent(event: BrowserHostEvent) {
      for (const socket of sockets) {
        send(socket, { event });
      }
    },
    disconnectAll() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const pending of pendingPlays.values()) clearTimeout(pending.timer);
      pendingPlays.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    },
  };
}

test("browser driver reports clear offline error when BrowserHost socket is unavailable", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-offline-")));
  try {
    const missingSocket = join(dir, "missing-browser-host.sock");
    await expect(createBrowserProvider({ browserSocket: missingSocket, clock })).rejects.toThrow(
      "Built-in browser host is offline (start Ludens Desktop App)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser provider connects, calls session.ensure, preserves session on close, and fires onDisconnect on drop", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-lifecycle-")));
  const host = await startMockBrowserHost(join(dir, "browser-host.sock"));
  try {
    const registration = getDriver("browser");
    expect(registration.id).toBe("browser");
    expect(registration.transport).toBe("stdio");

    let disconnectedError: Error | undefined;
    const provider = await registration.load({
      browserSocket: host.socketPath,
      sessionId: "ws-alpha",
      initialUrl: "https://example.com/game",
      clock,
    });
    provider.onDisconnect(err => {
      disconnectedError = err;
    });

    expect(host.requests[0]?.request).toEqual({
      kind: "session.ensure",
      sessionId: "ws-alpha",
      initialUrl: "https://example.com/game",
      width: 1280,
      height: 720,
    });

    // Clean close must NOT destroy the persistent BrowserHost session and must NOT fire onDisconnect.
    await provider.close();
    await Bun.sleep(20);
    expect(host.requests.some(r => r.request.kind === "session.close")).toBe(false);
    expect(disconnectedError).toBeUndefined();

    // Unexpected server drop triggers onDisconnect.
    const provider2 = await createBrowserProvider({ browserSocket: host.socketPath, clock });
    expect(host.requests.at(-1)?.request).toEqual({
      kind: "session.ensure",
      sessionId: "default",
      width: 1280,
      height: 720,
    });
    const dropped = Promise.withResolvers<Error>();
    provider2.onDisconnect(err => dropped.resolve(err));
    host.disconnectAll();
    const dropError = await dropped.promise;
    expect(dropError.message).toContain("disconnected");
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("screen.capture integrates with ObservationStreamSpool and all visual/game controllers work", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-controllers-")));
  const host = await startMockBrowserHost(join(dir, "browser-host.sock"));
  const provider = await createBrowserProvider({
    browserSocket: host.socketPath,
    sessionId: "ws-game",
    clock,
  });
  const core = new BasewareCore({
    capabilities: provider.capabilities,
    drivers: [{ id: "browser", version: "builtin", transport: "stdio" }],
    streamDir: join(dir, "stream"),
    streamPrefetch: false,
    activeMachineId: "builtin-browser",
  });
  core.mountMachine({
    id: "builtin-browser",
    label: "Built-in Browser",
    driver: "browser",
    transport: "stdio",
    connected: true,
    reason: "connected",
    isPrimary: true,
    capabilities: provider.capabilities,
    drivers: [{ id: "browser", version: "builtin", transport: "stdio" }],
  });

  try {
    // Verify mounted machine metadata includes stageKind and hasViewport.
    const mounted = core.getMountedMachines();
    expect(mounted).toEqual([
      expect.objectContaining({
        id: "builtin-browser",
        driver: "browser",
        stageKind: "browser",
        hasViewport: true,
      }),
    ]);

    // Read-only screen.capture works in manual mode and spools cleanly via ObservationStreamSpool.
    const spooled = await core.execute(
      "screen.capture",
      {},
      undefined,
      new AbortController().signal,
      { recordingPurpose: "continuous-perception" },
      undefined,
      "perception",
      { omitInlineMedia: true },
    );
    expect(spooled.status).toBe("completed");
    expect(spooled.observations).toHaveLength(1);
    const obs = spooled.observations![0]!;
    expect(obs.controllerId).toBe("screen.capture");
    expect(obs.mediaType).toBe("image/jpeg");
    expect(obs.contentIndex).toBe(0);
    expect(obs.sourceSequence).toBe(1);
    expect(obs.path).toBeDefined();
    expect(obs.bytes).toBe(FAKE_JPEG_BYTES.byteLength);
    expect(await readFile(obs.path!)).toEqual(FAKE_JPEG_BYTES);
    expect(spooled.result.structuredContent).toEqual({
      width: 1280,
      height: 720,
      seq: 1,
      url: "ludens-browser://start",
      title: "Mock Start Page",
      pointerLocked: false,
    });
    const imageBlock = spooled.result.content[0] as { type: string; data: string; mimeType: string; path?: string };
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.mimeType).toBe("image/jpeg");
    expect(imageBlock.data).toBe("");
    expect(imageBlock.path).toBe(obs.path);

    // Inline capture (without omitInlineMedia) returns base64 image directly.
    const inline = await core.execute("screen.capture", { format: "png" }, undefined, new AbortController().signal);
    const inlineBlock = inline.result.content[0] as { type: string; data: string; mimeType: string };
    expect(inlineBlock).toEqual({ type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/png" });

    // page.state is read-only and returns navigation/viewport metadata.
    const pageState = await core.execute("page.state", {}, undefined, new AbortController().signal);
    expect(pageState.result.structuredContent).toMatchObject({
      sessionId: "ws-game",
      width: 1280,
      height: 720,
      pointerLocked: false,
      navigation: { url: "ludens-browser://start" },
    });

    // Control-requiring actions reject in manual mode.
    await expect(
      core.execute("page.open", { url: "https://threejs.org" }, undefined, new AbortController().signal),
    ).rejects.toThrow("STALE_EPOCH");

    // Acquire control and exercise navigation, keyboard, and mouse (including mouse.moveRelative).
    const owner = { id: "agent-1" };
    await core.acquire("ep-1", 60, owner);

    const opened = await core.execute("page.open", { url: "https://threejs.org/examples/" }, "ep-1", new AbortController().signal);
    expect(opened.result.structuredContent).toMatchObject({
      navigation: { url: "https://threejs.org/examples/" },
    });

    await core.execute("viewport.resize", { width: 1600, height: 900 }, "ep-1", new AbortController().signal);
    await core.execute("page.reload", {}, "ep-1", new AbortController().signal);
    await core.execute("page.back", {}, "ep-1", new AbortController().signal);
    await core.execute("page.forward", {}, "ep-1", new AbortController().signal);
    await core.execute("keyboard.down", { key: "w", code: "KeyW" }, "ep-1", new AbortController().signal);
    await core.execute("keyboard.up", { key: "w", code: "KeyW" }, "ep-1", new AbortController().signal);
    await core.execute("keyboard.press", { key: " ", durationMs: 0 }, "ep-1", new AbortController().signal);
    await core.execute("keyboard.type", { text: "hello" }, "ep-1", new AbortController().signal);
    await core.execute("mouse.move", { x: 640, y: 360 }, "ep-1", new AbortController().signal);
    const rel = await core.execute("mouse.moveRelative", { dx: 42, dy: -15 }, "ep-1", new AbortController().signal);
    expect(rel.result.structuredContent).toEqual({ ok: true, pointerLocked: true });
    await core.execute("mouse.down", { x: 100, y: 200, button: "left" }, "ep-1", new AbortController().signal);
    await core.execute("mouse.up", { x: 100, y: 200, button: "left" }, "ep-1", new AbortController().signal);
    await core.execute("mouse.click", { x: 300, y: 400, durationMs: 0 }, "ep-1", new AbortController().signal);
    await core.execute("mouse.wheel", { x: 300, y: 400, deltaY: -120 }, "ep-1", new AbortController().signal);

    // Verify mouse.moveRelative reached BrowserHost with exact payload.
    const relReq = host.requests.find(
      r => r.request.kind === "session.input" && r.request.input.type === "mouseMoveRelative",
    );
    expect(relReq?.request).toEqual({
      kind: "session.input",
      sessionId: "ws-game",
      input: { type: "mouseMoveRelative", dx: 42, dy: -15 },
    });

    await core.release("ep-1");
  } finally {
    await core.close();
    await provider.close();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("input.play forwards cancellation and release(epoch) aborts in-flight play and calls session.releaseAll once", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-play-cancel-")));
  const host = await startMockBrowserHost(join(dir, "browser-host.sock"), { holdPlay: true });
  const provider = await createBrowserProvider({
    browserSocket: host.socketPath,
    sessionId: "ws-play",
    clock,
  });
  const core = new BasewareCore({
    capabilities: provider.capabilities,
    drivers: [{ id: "browser", version: "builtin", transport: "stdio" }],
  });

  try {
    const owner = { id: "agent-play" };
    await core.acquire("ep-play", 60, owner);

    // 1. Direct caller abort on input.play sends { kind: "cancel", operationId } to BrowserHost.
    const abortCtrl = new AbortController();
    const play1 = core.execute(
      "input.play",
      { steps: [{ atMs: 0, durationMs: 500, keys: ["w"] }] },
      "ep-play",
      abortCtrl.signal,
    );
    await Bun.sleep(25);
    const playReq1 = host.requests.find(r => r.request.kind === "session.play");
    expect(playReq1).toBeDefined();
    abortCtrl.abort(new Error("caller abort"));
    await expect(play1).rejects.toThrow("caller abort");
    await Bun.sleep(25);
    expect(host.cancelledOperationIds).toContain(playReq1!.id);

    // 2. Revoking control (release) aborts in-flight input.play AND sends exactly one session.releaseAll.
    const play2 = core.execute(
      "input.play",
      { steps: [{ atMs: 0, durationMs: 500, keys: ["a", "Space"] }] },
      "ep-play",
      new AbortController().signal,
    );
    const play2Outcome = play2.then(
      () => undefined,
      error => (error instanceof Error ? error : new Error(String(error))),
    );
    await Bun.sleep(25);
    const playReqs = host.requests.filter(r => r.request.kind === "session.play");
    expect(playReqs).toHaveLength(2);

    await core.release("ep-play", "human");
    const play2Error = await play2Outcome;
    expect(play2Error).toBeDefined();
    await Bun.sleep(25);

    expect(host.cancelledOperationIds).toContain(playReqs[1]!.id);
    const releaseAllCalls = host.requests.filter(r => r.request.kind === "session.releaseAll");
    expect(releaseAllCalls).toHaveLength(1);
    expect(releaseAllCalls[0]!.request).toEqual({ kind: "session.releaseAll", sessionId: "ws-play" });

    // 3. Direct provider release(epoch) also aborts in-flight play even without external signal abort,
    //    and is idempotent if called multiple times for the same epoch.
    const inputPlayCtrl = provider.capabilities.controllers.find(c => c.tool.name === "input.play")!;
    await inputPlayCtrl.acquire!("ep-direct");
    const play3Outcome = inputPlayCtrl
      .execute({ steps: [{ atMs: 0, durationMs: 500, keys: ["d"] }] }, { epoch: "ep-direct", signal: new AbortController().signal })
      .then(
        () => undefined,
        error => (error instanceof Error ? error : new Error(String(error))),
      );
    await Bun.sleep(25);
    const playReq3 = host.requests.filter(r => r.request.kind === "session.play")[2]!;
    await Promise.all([inputPlayCtrl.release!("ep-direct"), inputPlayCtrl.release!("ep-direct")]);
    const play3Error = await play3Outcome;
    expect(play3Error?.message).toContain("Control released");
    await Bun.sleep(25);
    expect(host.cancelledOperationIds).toContain(playReq3.id);
    expect(host.requests.filter(r => r.request.kind === "session.releaseAll")).toHaveLength(2);
  } finally {
    await core.close();
    await provider.close();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("viewport RPC gating (manual vs auto), transient frame streaming, and auto-unsubscribe on disconnect", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-viewport-rpc-")));
  const host = await startMockBrowserHost(join(dir, "browser-host.sock"));
  const provider = await createBrowserProvider({
    browserSocket: host.socketPath,
    sessionId: "ws-vp",
    clock,
  });
  const persistedEvents: { type: string; data: unknown }[] = [];
  const core = new BasewareCore({
    capabilities: provider.capabilities,
    drivers: [{ id: "browser", version: "builtin", transport: "stdio" }],
    record: (type, data) => {
      persistedEvents.push({ type, data });
    },
  });
  const basewareSocket = join(dir, "baseware.sock");
  const closeServer = await listen(basewareSocket, core);

  try {
    const receivedBySubscriber: DeviceEvent[] = [];
    const receivedByOther: DeviceEvent[] = [];

    const vpClient = await BasewareClient.connect(basewareSocket, {
      onEvent: event => receivedBySubscriber.push(event),
    });
    const otherClient = await BasewareClient.connect(basewareSocket, {
      onEvent: event => receivedByOther.push(event),
    });

    try {
      // Standalone primaryViewport works without mountMachine and reports manual controlMode.
      const describedManual = await vpClient.viewportDescribe();
      expect(describedManual.controlMode).toBe("manual");
      expect(describedManual.sessionId).toBe("ws-vp");

      // Manual mode accepts viewport.input and viewport.action.
      const inputRes = await vpClient.viewportInput({ type: "mouseMove", x: 120, y: 80 });
      expect(inputRes).toEqual({ ok: true, pointerLocked: false });
      const navRes = await vpClient.viewportAction({ kind: "navigate", url: "https://ludens.dev" });
      expect(navRes.navigation?.url).toBe("https://ludens.dev");
      expect(navRes.controlMode).toBe("manual");

      // Acquire control (auto mode): viewport.describe reports auto, viewport.input & viewport.action reject.
      await otherClient.request({ kind: "acquire", epoch: "ep-vp", seconds: 60 });
      const describedAuto = await vpClient.viewportDescribe();
      expect(describedAuto.controlMode).toBe("auto");

      await expect(vpClient.viewportInput({ type: "keyDown", key: "w" })).rejects.toThrow(
        "Device is currently under agent control",
      );
      await expect(vpClient.viewportAction({ kind: "reload" })).rejects.toThrow(
        "Device is currently under agent control",
      );

      // Subscribe to viewport frames on vpClient only.
      const subResult = await vpClient.viewportSubscribe({ maxFps: 30, quality: 75 });
      expect(subResult).toEqual({ subscribed: true, machineId: null });
      const subReq = host.requests.find(r => r.request.kind === "session.subscribe");
      expect(subReq?.request).toEqual({
        kind: "session.subscribe",
        sessionId: "ws-vp",
        maxFps: 30,
        quality: 75,
      });

      // Push a frame event and a state event from mock BrowserHost.
      host.pushEvent({
        event: "frame",
        sessionId: "ws-vp",
        format: "jpeg",
        width: 1280,
        height: 720,
        timestampMs: 123456,
        seq: 7,
        pointerLocked: false,
        dataBase64: FAKE_JPEG_BASE64,
      });
      host.pushEvent({
        event: "state",
        sessionId: "ws-vp",
        state: {
          stageKind: "browser",
          available: true,
          connected: true,
          machineId: null,
          driver: "browser",
          sessionId: "ws-vp",
          width: 1280,
          height: 720,
          pointerLocked: false,
          controlMode: "manual",
          capabilities: {
            navigate: true,
            keyboard: true,
            mouse: true,
            pointerLock: true,
            resize: true,
            nativeEmbed: true,
          },
        },
      });

      await Bun.sleep(40);

      // vpClient received both transient viewport_frame and viewport_state (with controlMode overridden to "auto").
      const frameEvents = receivedBySubscriber.filter(e => e.type === "viewport_frame");
      const stateEvents = receivedBySubscriber.filter(e => e.type === "viewport_state");
      expect(frameEvents).toHaveLength(1);
      expect(frameEvents[0]!.data).toMatchObject({ event: "frame", seq: 7, dataBase64: FAKE_JPEG_BASE64 });
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]!.data).toMatchObject({
        event: "state",
        state: { controlMode: "auto" },
      });

      // Other clients did NOT receive vpClient's transient viewport frames/states.
      expect(receivedByOther.some(e => e.type === "viewport_frame" || e.type === "viewport_state")).toBe(false);

      // Persistent disk sink did NOT record high-frequency viewport_frame or viewport_state payloads.
      expect(persistedEvents.some(e => e.type === "viewport_frame" || e.type === "viewport_state")).toBe(false);

      // Disconnecting vpClient automatically triggers session.unsubscribe on BrowserHost!
      vpClient.close();
      await Bun.sleep(50);
      const unsubReq = host.requests.find(r => r.request.kind === "session.unsubscribe");
      expect(unsubReq?.request).toEqual({ kind: "session.unsubscribe", sessionId: "ws-vp" });

      // Release control and test offline controlMode when core is marked disconnected.
      await otherClient.request({ kind: "release", epoch: "ep-vp" });
      await core.disconnected(new Error("transport lost"));
      const describedOffline = await otherClient.viewportDescribe();
      expect(describedOffline.controlMode).toBe("offline");
    } finally {
      vpClient.close();
      otherClient.close();
    }
  } finally {
    await closeServer();
    await provider.close();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseware serve --driver browser forwards --session-id, --initial-url, and --browser-socket", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "browser-cli-serve-")));
  const host = await startMockBrowserHost(join(dir, "browser-host.sock"));
  const basewareSocket = join(dir, "baseware.sock");
  const entry = join(import.meta.dir, "../src/main.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      entry,
      "serve",
      "--driver",
      "browser",
      "--machine-id",
      "builtin-browser",
      "--session-id",
      "ws-cli-1",
      "--initial-url",
      "https://example.org/play",
      "--browser-socket",
      host.socketPath,
      "--socket",
      basewareSocket,
      "--data-dir",
      join(dir, "data"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderrPromise = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (ready.done) throw new Error(`serve exited early: ${await stderrPromise}`);
    const readyPayload = JSON.parse(new TextDecoder().decode(ready.value));
    expect(readyPayload.ready).toBe(true);
    expect(readyPayload.machines).toEqual([
      expect.objectContaining({
        id: "builtin-browser",
        driver: "browser",
        stageKind: "browser",
        hasViewport: true,
        connected: true,
      }),
    ]);

    expect(host.requests[0]?.request).toEqual({
      kind: "session.ensure",
      sessionId: "ws-cli-1",
      initialUrl: "https://example.org/play",
      width: 1280,
      height: 720,
    });

    const client = await BasewareClient.connect(basewareSocket);
    try {
      const state = await client.viewportDescribe();
      expect(state.sessionId).toBe("ws-cli-1");
      expect(state.navigation?.url).toBe("https://example.org/play");
      expect(state.controlMode).toBe("manual");
    } finally {
      client.close();
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
