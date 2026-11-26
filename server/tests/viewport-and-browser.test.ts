import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSocket } from "@ludens/baseware/address";
import type { Envelope as BasewareEnvelope, Request as BasewareRequest } from "@ludens/baseware/protocol";
import {
  browserHostRuntimeFilePath,
  resolveBrowserHostSocketPath,
} from "@ludens/protocol/browser-host-paths";
import {
  BUILTIN_BROWSER_DRIVER_SPEC,
  BUILTIN_CUA_DRIVER_SPEC,
  BUILTIN_LOCAL_BROWSER_MACHINE,
  ensureWorkspaceIdentity,
  ludensHome,
  registerWorkspace,
} from "@ludens/protocol/ludens";
import {
  BUILTIN_BROWSER_START_URL,
  decodeViewportFrame,
  type BrowserHostEnvelope,
  type BrowserHostEvent,
  type ViewportControlAction,
  type ViewportHumanInput,
  type ViewportState,
  type ViewportWsServerMessage,
} from "@ludens/protocol/viewport";
import { NodeUdsRpcClient, WsAppRpcClient } from "../src/daemon/app-rpc-client.ts";
import {
  DEFAULT_BROWSER_HOST_NEGATIVE_CACHE_TTL_MS,
  invalidateBrowserHostCache,
  probeBrowserHost,
} from "../src/daemon/browser-host-client.ts";
import { resolveWorkspaceDeviceIdentity } from "../src/daemon/device-arbitration.ts";
import { launchPlan, parseConfig, type LaunchIO, type LaunchPlan } from "../src/daemon/launcher.ts";
import { WorkspaceSupervisor } from "../src/daemon/supervisor.ts";
import { discoverDriver } from "../src/query/drivers.ts";
import { initializeWorkspace } from "../src/query/workspace-init.ts";
import {
  basewareOverview,
  probeBasewareMachine,
  updateWorkspaceStudioConfig,
  workspaceStudio,
} from "../src/query/workspaces.ts";
import { startAppServer } from "../src/server/app-server.ts";

interface MockBrowserHostHandle {
  hostId: string;
  socketPath: string;
  sessions: Map<string, ViewportState>;
  receivedActions: Array<{ sessionId: string; action: ViewportControlAction }>;
  receivedInputs: Array<{ sessionId: string; input: ViewportHumanInput }>;
  pushEvent(event: BrowserHostEvent): void;
  close(): Promise<void>;
}

async function startMockBrowserHost(home: string, hostId = "mock-host-1"): Promise<MockBrowserHostHandle> {
  const socketPath = resolveBrowserHostSocketPath(home);
  await mkdir(dirname(socketPath), { recursive: true });
  await unlink(socketPath).catch(() => {});

  const sessions = new Map<string, ViewportState>();
  const subscribers = new Map<Socket, Set<string>>();
  const receivedActions: Array<{ sessionId: string; action: ViewportControlAction }> = [];
  const receivedInputs: Array<{ sessionId: string; input: ViewportHumanInput }> = [];

  const ensureSessionState = (
    sessionId: string,
    initialUrl?: string,
    width = 1280,
    height = 720,
  ): ViewportState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const state: ViewportState = {
      stageKind: "browser",
      available: true,
      connected: true,
      machineId: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      driver: "browser",
      sessionId,
      nativeHostId: hostId,
      width,
      height,
      pointerLocked: false,
      controlMode: "manual",
      navigation: {
        url: initialUrl || BUILTIN_BROWSER_START_URL,
        title: "Ludens Mock Browser",
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
    sessions.set(sessionId, state);
    return state;
  };

  const server: NetServer = createServer(socket => {
    subscribers.set(socket, new Set());
    let buffer = "";
    socket.setEncoding("utf8");
    const reply = (id: string, ok: true, value: unknown) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify({ id, ok, value })}\n`);
      }
    };
    const replyErr = (id: string, error: string) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify({ id, ok: false, error })}\n`);
      }
    };
    socket.on("data", chunk => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const env = JSON.parse(line) as BrowserHostEnvelope;
          const req = env.request;
          switch (req.kind) {
            case "ping":
              reply(env.id, true, {
                hostId,
                pid: process.pid,
                version: "0.1.0-test",
                sessions: [...sessions.keys()],
              });
              break;
            case "session.ensure":
              reply(
                env.id,
                true,
                ensureSessionState(req.sessionId, req.initialUrl, req.width, req.height),
              );
              break;
            case "session.describe": {
              const state = sessions.get(req.sessionId);
              if (!state) replyErr(env.id, `Unknown session: ${req.sessionId}`);
              else reply(env.id, true, state);
              break;
            }
            case "session.action": {
              const state = ensureSessionState(req.sessionId);
              receivedActions.push({ sessionId: req.sessionId, action: req.action });
              if (req.action.kind === "navigate" && state.navigation) {
                state.navigation = {
                  ...state.navigation,
                  url: req.action.url,
                  title: `Page: ${req.action.url}`,
                  canGoBack: true,
                };
              } else if (req.action.kind === "resize") {
                state.width = req.action.width;
                state.height = req.action.height;
              }
              reply(env.id, true, state);
              break;
            }
            case "session.input": {
              const state = ensureSessionState(req.sessionId);
              receivedInputs.push({ sessionId: req.sessionId, input: req.input });
              if (req.input.type === "mouseMoveRelative") {
                state.pointerLocked = true;
              }
              reply(env.id, true, { ok: true, pointerLocked: state.pointerLocked });
              break;
            }
            case "session.subscribe": {
              const state = ensureSessionState(req.sessionId);
              subscribers.get(socket)?.add(req.sessionId);
              reply(env.id, true, state);
              break;
            }
            case "session.unsubscribe":
              subscribers.get(socket)?.delete(req.sessionId);
              reply(env.id, true, { ok: true });
              break;
            default:
              replyErr(env.id, `Unsupported mock request: ${req.kind}`);
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    const cleanup = () => {
      subscribers.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const runtimePath = browserHostRuntimeFilePath(home);
  await mkdir(dirname(runtimePath), { recursive: true });
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        hostId,
        pid: process.pid,
        socketPath,
        startedAt: new Date().toISOString(),
        home,
        version: "0.1.0-test",
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    hostId,
    socketPath,
    sessions,
    receivedActions,
    receivedInputs,
    pushEvent(event: BrowserHostEvent) {
      const payload = `${JSON.stringify({ event })}\n`;
      for (const [sock, sessionSet] of subscribers.entries()) {
        if (sessionSet.has(event.sessionId) && !sock.destroyed && sock.writable) {
          sock.write(payload);
        }
      }
    },
    async close() {
      for (const sock of subscribers.keys()) {
        sock.destroy();
      }
      subscribers.clear();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      await unlink(socketPath).catch(() => {});
      await unlink(runtimePath).catch(() => {});
    },
  };
}

interface MockBasewareViewportHandle {
  socketPath: string;
  mode: "manual" | "auto";
  state: ViewportState;
  receivedRequests: BasewareRequest[];
  pushViewportEvent(event: BrowserHostEvent): void;
  close(): Promise<void>;
}

async function startMockBasewareViewport(
  workspacePath: string,
  workspaceId: string,
  initialMode: "manual" | "auto" = "auto",
): Promise<MockBasewareViewportHandle> {
  const socketPath = await defaultSocket(workspacePath);
  await mkdir(dirname(socketPath), { recursive: true });
  await unlink(socketPath).catch(() => {});

  const subscribers = new Set<Socket>();
  const receivedRequests: BasewareRequest[] = [];
  const handle: MockBasewareViewportHandle = {
    socketPath,
    mode: initialMode,
    state: {
      stageKind: "browser",
      available: true,
      connected: true,
      machineId: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      driver: "browser",
      sessionId: workspaceId,
      nativeHostId: "baseware-host",
      width: 1280,
      height: 720,
      pointerLocked: false,
      controlMode: initialMode,
      navigation: {
        url: "https://baseware.local/game",
        title: "Live Baseware Game",
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
    },
    receivedRequests,
    pushViewportEvent(event: BrowserHostEvent) {
      const deviceEvent = {
        type: event.event === "frame" ? "viewport_frame" : "viewport_state",
        data: event,
        trace: {},
        source: { component: "baseware", implementation: "mock" },
        origin: {
          eventId: `mock:${Date.now()}`,
          clockId: "mock",
          seq: 1,
          at: new Date().toISOString(),
          atMs: performance.now(),
        },
      };
      const payload = `${JSON.stringify({ event: deviceEvent })}\n`;
      for (const sock of subscribers) {
        if (!sock.destroyed && sock.writable) {
          sock.write(payload);
        }
      }
    },
    async close() {
      for (const sock of subscribers) sock.destroy();
      subscribers.clear();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      await unlink(socketPath).catch(() => {});
    },
  };

  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    const reply = (id: string, ok: true, value: unknown) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify({ id, ok, value })}\n`);
      }
    };
    const replyErr = (id: string, error: string) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify({ id, ok: false, error })}\n`);
      }
    };
    socket.on("data", chunk => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const env = JSON.parse(line) as BasewareEnvelope;
          const req = env.request;
          receivedRequests.push(req);
          if (req.kind === "viewport.describe") {
            reply(env.id, true, { ...handle.state, controlMode: handle.mode });
          } else if (req.kind === "viewport.action") {
            if (handle.mode !== "manual") {
              replyErr(env.id, "Device is currently under agent control");
            } else {
              if (req.viewportAction?.kind === "navigate" && handle.state.navigation) {
                handle.state.navigation = {
                  ...handle.state.navigation,
                  url: req.viewportAction.url,
                };
              }
              reply(env.id, true, { ...handle.state, controlMode: handle.mode });
            }
          } else if (req.kind === "viewport.input") {
            if (handle.mode !== "manual") {
              replyErr(env.id, "Device is currently under agent control");
            } else {
              reply(env.id, true, { ok: true, pointerLocked: handle.state.pointerLocked });
            }
          } else if (req.kind === "viewport.subscribe") {
            subscribers.add(socket);
            reply(env.id, true, { ...handle.state, controlMode: handle.mode });
          } else {
            replyErr(env.id, `Unknown request kind: ${req.kind}`);
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    const cleanup = () => {
      subscribers.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  return handle;
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val) return val;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test("workspace-init supports driver=browser + url, generates 30Hz screen.capture perception.py, and launcher emits --session-id/--browser-socket/--initial-url", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-browser-init-")));
  const home = join(root, "home");

  try {
    // 1. Discover built-in browser and cua drivers without spawning subprocesses.
    const discoveredBrowser = await discoverDriver(BUILTIN_BROWSER_DRIVER_SPEC);
    expect(discoveredBrowser.id).toBe("browser");
    expect(discoveredBrowser.spec).toBe(BUILTIN_BROWSER_DRIVER_SPEC);
    expect(discoveredBrowser.transport).toBe("stdio");

    const discoveredById = await discoverDriver("browser");
    expect(discoveredById.id).toBe("browser");
    expect(discoveredById.spec).toBe(BUILTIN_BROWSER_DRIVER_SPEC);

    const discoveredCua = await discoverDriver(BUILTIN_CUA_DRIVER_SPEC);
    expect(discoveredCua.id).toBe("cua");

    // 2. Initialize a browser workspace with an initial URL.
    const initialized = await initializeWorkspace(
      {
        name: "webgl-arena",
        driver: "browser",
        url: "https://example.com/threejs-arena",
      },
      { home },
    );

    expect(initialized.config.driver).toBe("browser");
    expect(initialized.config.url).toBe("https://example.com/threejs-arena");
    expect(initialized.config.machines).toEqual({
      active: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      allowed: [BUILTIN_LOCAL_BROWSER_MACHINE.id],
    });

    const perceptionPy = await readFile(join(initialized.workspace, "perception.py"), "utf8");
    expect(perceptionPy).toContain('controller/screen.capture');
    expect(perceptionPy).toContain("class Perception");

    // 3. Initialize by machineId="builtin-browser" directly without machines.json persistence.
    const byMachine = await initializeWorkspace(
      {
        name: "webgl-machine-only",
        driver: "",
        machineId: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      },
      { home },
    );
    expect(byMachine.config.driver).toBe("browser");
    expect(byMachine.config.machines).toEqual({
      active: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      allowed: [BUILTIN_LOCAL_BROWSER_MACHINE.id],
    });

    // 4. updateWorkspaceStudioConfig supports updating and clearing url.
    const studioBefore = await workspaceStudio(initialized.entry.id, home);
    expect(studioBefore.config?.url).toBe("https://example.com/threejs-arena");

    const studioUpdated = await updateWorkspaceStudioConfig(
      initialized.entry.id,
      { url: "https://example.com/updated-game" },
      home,
    );
    expect(studioUpdated.config?.url).toBe("https://example.com/updated-game");

    const studioCleared = await updateWorkspaceStudioConfig(initialized.entry.id, { url: null }, home);
    expect(studioCleared.config?.url).toBeUndefined();

    // 5. launchPlan passes --session-id <workspaceId>, --browser-socket, and --initial-url.
    const cfg = parseConfig(
      {
        driver: "browser",
        url: "https://example.com/threejs",
        machines: { active: BUILTIN_LOCAL_BROWSER_MACHINE.id, allowed: [BUILTIN_LOCAL_BROWSER_MACHINE.id] },
      },
      { id: "browser", transport: "stdio", needsGame: false },
    );
    const planWithIdentity = await launchPlan(
      cfg,
      initialized.workspace,
      undefined,
      "/tmp/bw-browser.sock",
      { id: "browser", transport: "stdio", needsGame: false },
      BUILTIN_LOCAL_BROWSER_MACHINE,
    );
    const bwCmd = planWithIdentity.commands.baseware!;
    expect(bwCmd).toContain("--driver");
    expect(bwCmd[bwCmd.indexOf("--driver") + 1]).toBe("browser");
    expect(bwCmd[bwCmd.indexOf("--machine-id") + 1]).toBe(BUILTIN_LOCAL_BROWSER_MACHINE.id);
    expect(bwCmd[bwCmd.indexOf("--session-id") + 1]).toBe(initialized.entry.id);
    expect(bwCmd[bwCmd.indexOf("--browser-socket") + 1]).toBe(resolveBrowserHostSocketPath(ludensHome()));
    expect(bwCmd[bwCmd.indexOf("--initial-url") + 1]).toBe("https://example.com/threejs");

    // 6. launchPlan without .ludens/workspace.json falls back --session-id to workspaceHash.
    const unidentDir = join(root, "unidentified-browser-ws");
    await mkdir(unidentDir, { recursive: true });
    const expectedHash = createHash("sha256").update(unidentDir).digest("hex").slice(0, 16);
    const planFallback = await launchPlan(
      cfg,
      unidentDir,
      undefined,
      "/tmp/bw-fallback.sock",
      { id: "browser", transport: "stdio", needsGame: false },
      { ...BUILTIN_LOCAL_BROWSER_MACHINE, initialUrl: "https://machine-override.example" },
    );
    const fallbackCmd = planFallback.commands.baseware!;
    expect(fallbackCmd[fallbackCmd.indexOf("--session-id") + 1]).toBe(expectedHash);
    expect(fallbackCmd[fallbackCmd.indexOf("--initial-url") + 1]).toBe("https://machine-override.example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime injection dynamically exposes builtin-browser only when BrowserHost is online (or explicitly bound by queried workspace)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-browser-inject-")));
  const home = join(root, "home");

  try {
    invalidateBrowserHostCache(home);

    const cuaWs = await initializeWorkspace({ name: "cua-ws", driver: "cua" }, { home });
    const browserWs = await initializeWorkspace(
      { name: "browser-ws", driver: "browser", url: "https://example.com/game" },
      { home },
    );

    // 1. Offline: global discovery & CUA workspace do NOT inject builtin-browser.
    const offlineGlobal = await basewareOverview(undefined, home);
    expect(offlineGlobal.browserHost?.available).toBe(false);
    expect(offlineGlobal.machines.some(m => m.id === BUILTIN_LOCAL_BROWSER_MACHINE.id)).toBe(false);
    expect(offlineGlobal.drivers.some(d => d.spec === BUILTIN_BROWSER_DRIVER_SPEC)).toBe(false);

    const offlineCua = await basewareOverview(cuaWs.entry.id, home);
    expect(offlineCua.machines.some(m => m.id === BUILTIN_LOCAL_BROWSER_MACHINE.id)).toBe(false);

    // 2. Offline: explicitly browser-bound workspace still shows builtin-browser with available: false.
    const offlineBrowserWs = await basewareOverview(browserWs.entry.id, home);
    expect(offlineBrowserWs.browserHost?.available).toBe(false);
    expect(offlineBrowserWs.activeMachine?.id).toBe(BUILTIN_LOCAL_BROWSER_MACHINE.id);
    expect(offlineBrowserWs.activeMachine?.available).toBe(false);
    expect(offlineBrowserWs.implicitMachine).toBeNull();
    const offlineMachine = offlineBrowserWs.machines.find(m => m.id === BUILTIN_LOCAL_BROWSER_MACHINE.id);
    expect(offlineMachine).toMatchObject({
      id: BUILTIN_LOCAL_BROWSER_MACHINE.id,
      available: false,
      runtimeInjected: true,
      stageKind: "browser",
    });
    const offlineDriver = offlineBrowserWs.drivers.find(d => d.spec === BUILTIN_BROWSER_DRIVER_SPEC);
    expect(offlineDriver).toMatchObject({
      id: "browser",
      spec: BUILTIN_BROWSER_DRIVER_SPEC,
      available: false,
      runtimeInjected: true,
      stageKind: "browser",
    });

    const probeOffline = await probeBasewareMachine({ id: BUILTIN_LOCAL_BROWSER_MACHINE.id }, home);
    expect(probeOffline.ok).toBe(false);

    // 3. Start mock BrowserHost UDS server -> runtime injection activates globally!
    const mockHost = await startMockBrowserHost(home, "desktop-host-42");
    try {
      invalidateBrowserHostCache(home);
      const probed = await probeBrowserHost(home, { force: true });
      expect(probed.available).toBe(true);
      expect(probed.hostId).toBe("desktop-host-42");

      const onlineGlobal = await basewareOverview(undefined, home);
      expect(onlineGlobal.browserHost).toEqual({
        available: true,
        hostId: "desktop-host-42",
        socketPath: mockHost.socketPath,
      });
      const onlineMachine = onlineGlobal.machines.find(m => m.id === BUILTIN_LOCAL_BROWSER_MACHINE.id);
      expect(onlineMachine).toMatchObject({
        id: BUILTIN_LOCAL_BROWSER_MACHINE.id,
        available: true,
        runtimeInjected: true,
        stageKind: "browser",
        usedByWorkspaceIds: [browserWs.entry.id],
      });
      const onlineDriver = onlineGlobal.drivers.find(d => d.spec === BUILTIN_BROWSER_DRIVER_SPEC);
      expect(onlineDriver).toMatchObject({
        id: "browser",
        spec: BUILTIN_BROWSER_DRIVER_SPEC,
        available: true,
        runtimeInjected: true,
        stageKind: "browser",
      });

      const probeOnline = await probeBasewareMachine({ id: BUILTIN_LOCAL_BROWSER_MACHINE.id }, home);
      expect(probeOnline.ok).toBe(true);
      expect(probeOnline.detail).toContain("desktop-host-42");
    } finally {
      await mockHost.close();
      invalidateBrowserHostCache(home);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewport/* RPCs, browserHost/notify, and /viewport binary WebSocket streaming handle standby BrowserHost, live Baseware handoff, and token auth", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-viewport-e2e-")));
  const home = join(root, "home");
  const token = "viewport-secret-token";

  const browserWs = await initializeWorkspace(
    { name: "arena-browser", driver: "browser", url: "https://example.com/start-arena" },
    { home },
  );
  const cuaWs = await initializeWorkspace({ name: "desktop-cua", driver: "cua" }, { home });

  // Also create an "observe" workspace with a custom non-browser/non-cua driver.
  const observeDir = join(root, "observe-ws");
  await mkdir(observeDir, { recursive: true });
  await writeFile(
    join(observeDir, "ludens.json"),
    JSON.stringify({ driver: "nes-custom", port: 47999, model: "openai-codex/gpt-6.2-sol" }),
    "utf8",
  );
  await ensureWorkspaceIdentity(observeDir);
  const observeWs = await registerWorkspace(observeDir, home);

  const server = await startAppServer({
    home,
    wsListen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "token", token },
  });

  const udsClient = new NodeUdsRpcClient({ socketPath: server.socketPath! });
  const rpcClient = new WsAppRpcClient({ url: server.wsUrl!, token });
  let mockHost: MockBrowserHostHandle | null = null;
  let mockBaseware: MockBasewareViewportHandle | null = null;

  try {
    await udsClient.connect();
    await rpcClient.connect();

    // 1. Initialize while BrowserHost is offline.
    const initOffline = await rpcClient.initialize({
      token,
      clientInfo: { name: "viewport-test", version: "1.0.0" },
    });
    expect(initOffline.capabilities.builtinBrowser).toBe(false);
    expect(initOffline.capabilities.browserHostId).toBeNull();
    expect(initOffline.media.viewportBasePath).toBe("/viewport");
    const ticket = initOffline.media.ticket!;
    expect(ticket).toBeTruthy();

    // Subscribe to baseware & viewport events on EventHub.
    const receivedTopics: string[] = [];
    rpcClient.onEvent(ev => {
      receivedTopics.push(ev.topic);
    });
    await rpcClient.call("events/subscribe", { topics: ["baseware", "viewport"] });

    // 2. viewport/describe when BrowserHost is offline + computer + observe stages.
    const offlineState = await rpcClient.call("viewport/describe", { project: browserWs.entry.id });
    expect(offlineState).toMatchObject({
      stageKind: "browser",
      available: false,
      connected: false,
      controlMode: "offline",
      reason: "Start Ludens Desktop App to enable Built-in Browser",
    });

    const cuaState = await rpcClient.call("viewport/describe", { project: cuaWs.entry.id });
    expect(cuaState).toMatchObject({
      stageKind: "computer",
      available: false,
      connected: false,
      controlMode: "offline",
    });

    const observeState = await rpcClient.call("viewport/describe", { project: observeWs.id });
    expect(observeState).toMatchObject({
      stageKind: "observe",
      available: false,
      connected: false,
      controlMode: "offline",
    });

    // 3. Start mock BrowserHost & call browserHost/notify(online) -> cache updates immediately & events fire!
    mockHost = await startMockBrowserHost(home, "mock-desktop-99");
    const notifyRes = await udsClient.call("browserHost/notify", {
      status: "online",
      hostId: "mock-desktop-99",
      socketPath: mockHost.socketPath,
      pid: process.pid,
    });
    expect(notifyRes).toEqual({ ok: true, available: true });
    await waitFor(() => receivedTopics.includes("baseware") && receivedTopics.includes("viewport"));

    const initOnline = await udsClient.initialize({
      clientInfo: { name: "desktop-uds", version: "1.0.0" },
    });
    expect(initOnline.capabilities.builtinBrowser).toBe(true);
    expect(initOnline.capabilities.browserHostId).toBe("mock-desktop-99");

    // 4. Standby viewport/describe, viewport/action, viewport/input directly against BrowserHost!
    const standbyState = await rpcClient.call("viewport/describe", { project: browserWs.entry.id });
    expect(standbyState).toMatchObject({
      stageKind: "browser",
      available: true,
      connected: true,
      controlMode: "manual",
      sessionId: browserWs.entry.id,
      nativeHostId: "mock-desktop-99",
      navigation: { url: "https://example.com/start-arena" },
    });

    const navigated = await rpcClient.call("viewport/action", {
      project: browserWs.entry.id,
      action: { kind: "navigate", url: "https://example.com/level-2" },
    });
    expect(navigated.navigation?.url).toBe("https://example.com/level-2");

    const inputRes = await rpcClient.call("viewport/input", {
      project: browserWs.entry.id,
      input: { type: "mouseMoveRelative", dx: 15, dy: -8 },
    });
    expect(inputRes).toEqual({ ok: true, pointerLocked: true });
    expect(mockHost.receivedInputs.at(-1)).toEqual({
      sessionId: browserWs.entry.id,
      input: { type: "mouseMoveRelative", dx: 15, dy: -8 },
    });

    // 5. /viewport WebSocket auth guard rejects missing ticket in token mode.
    const unauthRes = await fetch(
      `${server.url}/viewport?project=${encodeURIComponent(browserWs.entry.id)}`,
    );
    expect(unauthRes.status).toBe(401);

    // 6. Connect /viewport WS with valid ticket -> receive state JSON, binary frames, control actions, and Baseware handoff!
    const wsUrl = `ws://127.0.0.1:${server.port}/viewport?project=${encodeURIComponent(browserWs.entry.id)}&ticket=${encodeURIComponent(ticket)}`;
    const states: ViewportState[] = [];
    const frames: ReturnType<typeof decodeViewportFrame>[] = [];
    const errors: Array<{ code: string; message: string }> = [];

    const vpWs = new WebSocket(wsUrl);
    vpWs.binaryType = "arraybuffer";
    const openDeferred = Promise.withResolvers<void>();
    vpWs.addEventListener("open", () => openDeferred.resolve());
    vpWs.addEventListener("error", () => openDeferred.reject(new Error("Viewport WS failed to open")));
    vpWs.addEventListener("message", ev => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as ViewportWsServerMessage;
        if (msg.type === "state") states.push(msg.state);
        else if (msg.type === "error") errors.push({ code: msg.code, message: msg.message });
      } else {
        frames.push(decodeViewportFrame(ev.data as ArrayBuffer));
      }
    });

    try {
      await openDeferred.promise;

      // Initial standby state arrives over JSON.
      const firstState = await waitFor(() => states[0]);
      expect(firstState.stageKind).toBe("browser");
      expect(firstState.controlMode).toBe("manual");
      expect(firstState.sessionId).toBe(browserWs.entry.id);

      // Push a JPEG frame from mock BrowserHost -> verify binary packet decodes identically!
      const jpegPayload = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
      mockHost.pushEvent({
        event: "frame",
        sessionId: browserWs.entry.id,
        format: "jpeg",
        width: 1280,
        height: 720,
        timestampMs: 123456.5,
        seq: 7,
        pointerLocked: true,
        dataBase64: Buffer.from(jpegPayload).toString("base64"),
      });

      const firstFrame = await waitFor(() => frames.find(f => f.seq === 7));
      expect(firstFrame.format).toBe("jpeg");
      expect(firstFrame.width).toBe(1280);
      expect(firstFrame.height).toBe(720);
      expect(firstFrame.timestampMs).toBe(123456.5);
      expect(firstFrame.pointerLocked).toBe(true);
      expect(Array.from(firstFrame.bytes)).toEqual(Array.from(jpegPayload));

      // Send client WS action + input messages.
      vpWs.send(
        JSON.stringify({
          type: "action",
          action: { kind: "resize", width: 800, height: 600 },
        }),
      );
      const resizedState = await waitFor(() => states.find(s => s.width === 800 && s.height === 600));
      expect(resizedState.height).toBe(600);

      vpWs.send(
        JSON.stringify({
          type: "input",
          input: { type: "keyDown", key: "w", code: "KeyW" },
        }),
      );
      await waitFor(() =>
        mockHost!.receivedInputs.some(
          item => item.input.type === "keyDown" && item.input.key === "w",
        ),
      );

      // 7. Start a live mock Baseware daemon (in `auto` mode) -> RPCs & /viewport WS switch to Baseware!
      mockBaseware = await startMockBasewareViewport(browserWs.workspace, browserWs.entry.id, "auto");

      // RPC viewport/describe now reflects Baseware's `auto` mode and rejects human input!
      const bwState = await rpcClient.call("viewport/describe", { project: browserWs.entry.id });
      expect(bwState.controlMode).toBe("auto");
      expect(bwState.navigation?.url).toBe("https://baseware.local/game");

      await expect(
        rpcClient.call("viewport/input", {
          project: browserWs.entry.id,
          input: { type: "keyDown", key: "a" },
        }),
      ).rejects.toThrow(/agent control/i);

      // Trigger EventHub baseware event so /viewport WS immediately transitions to Baseware.
      server.eventHub.publish({ topic: "baseware", workspaceId: browserWs.entry.id, payload: { action: "up" } });
      const switchedAuto = await waitFor(() => states.find(s => s.controlMode === "auto"));
      expect(switchedAuto.navigation?.url).toBe("https://baseware.local/game");

      // Baseware transient frame streams as binary over the same /viewport WS!
      const webpPayload = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x09, 0x08]);
      mockBaseware.pushViewportEvent({
        event: "frame",
        sessionId: browserWs.entry.id,
        format: "webp",
        width: 1280,
        height: 720,
        timestampMs: 222222,
        seq: 42,
        pointerLocked: false,
        dataBase64: Buffer.from(webpPayload).toString("base64"),
      });
      const bwFrame = await waitFor(() => frames.find(f => f.seq === 42));
      expect(bwFrame.format).toBe("webp");
      expect(Array.from(bwFrame.bytes)).toEqual(Array.from(webpPayload));

      // Stop mock Baseware -> /viewport WS automatically falls back to standby BrowserHost (`manual`)!
      await mockBaseware.close();
      mockBaseware = null;
      const fallbackManual = await waitFor(() => {
        const last = states.at(-1);
        return last?.controlMode === "manual" && last.nativeHostId === "mock-desktop-99" ? last : null;
      });
      expect(fallbackManual.controlMode).toBe("manual");
      expect(errors).toEqual([]);
    } finally {
      vpWs.close();
    }

    // 8. browserHost/notify(offline) immediately marks offline.
    await mockHost.close();
    mockHost = null;
    const offlineNotify = await udsClient.call("browserHost/notify", { status: "offline" });
    expect(offlineNotify).toEqual({ ok: true, available: false });

    const overviewAfterOffline = await rpcClient.call("baseware/overview", {});
    expect(overviewAfterOffline.browserHost?.available).toBe(false);
    expect(overviewAfterOffline.machines.some(m => m.id === BUILTIN_LOCAL_BROWSER_MACHINE.id)).toBe(false);
  } finally {
    if (mockBaseware) await mockBaseware.close().catch(() => {});
    if (mockHost) await mockHost.close().catch(() => {});
    await rpcClient.close().catch(() => {});
    await udsClient.close().catch(() => {});
    await server.close({ emergency: true }).catch(() => {});
    invalidateBrowserHostCache(home);
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);

test("two builtin-browser workspaces bind, launch concurrently without DEVICE_BUSY, honor home/browser-host.json socket, and isolate viewport sessions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-multi-browser-ws-")));
  const home = join(root, "custom-home");

  // Initialize two workspaces with two distinct web games (including schemeless URLs).
  const wsGame1 = await initializeWorkspace(
    { name: "web-game-1", driver: "browser", url: "game1.example/play" },
    { home },
  );
  const wsGame2 = await initializeWorkspace(
    { name: "web-game-2", driver: "browser", url: "localhost:5173/arena" },
    { home },
  );

  expect(wsGame1.config.url).toBe("https://game1.example/play");
  expect(wsGame2.config.url).toBe("http://localhost:5173/arena");

  // Both workspaces resolve to non-exclusive deviceKey=null so they never contend.
  expect((await resolveWorkspaceDeviceIdentity(wsGame1.workspace, home)).deviceKey).toBeNull();
  expect((await resolveWorkspaceDeviceIdentity(wsGame2.workspace, home)).deviceKey).toBeNull();

  const mockHost = await startMockBrowserHost(home, "multi-ws-host");
  const server = await startAppServer({ home, wsListen: null });
  const udsClient = new NodeUdsRpcClient({ socketPath: server.socketPath! });

  const launchedCommands = new Map<string, string[]>();
  const runningJobs = new Map<string, { pid: number; stateFile: string }>();
  let nextPid = 40_000;

  const supervisor = new WorkspaceSupervisor({
    home,
    ioFactory: (plan: LaunchPlan, note): LaunchIO => {
      const stateKey = (file: string) => file;
      return {
        async run(argv) {
          if (argv.includes("status")) {
            const bwStateFile = join(plan.background, "baseware.job.json");
            if (runningJobs.has(stateKey(bwStateFile))) {
              return {
                code: 0,
                stdout: JSON.stringify({
                  serviceId: `svc-${plan.workspace}`,
                  mode: "auto",
                  connected: true,
                  epoch: "ep-live",
                }),
                stderr: "",
              };
            }
          }
          return { code: 1, stdout: "", stderr: "" };
        },
        async hostStatus() {
          const hostStateFile = join(plan.background, "host.job.json");
          if (!runningJobs.has(stateKey(hostStateFile))) return null;
          return {
            runId: `run-${plan.workspace}`,
            epoch: "ep-live",
            mode: "auto",
            connected: true,
            thinking: false,
            consolidating: false,
            timerSeconds: null,
          };
        },
        async hostAutoOff() {},
        async petReady() {
          return false;
        },
        async sleep() {},
        now: Date.now,
        note,
        async jobStatus(stateFile) {
          const entry = runningJobs.get(stateKey(stateFile));
          return entry
            ? { registered: true, pid: entry.pid, state: "running", lastExitCode: null }
            : { registered: false, pid: null, state: null, lastExitCode: null };
        },
        async stopJob(stateFile) {
          runningJobs.delete(stateKey(stateFile));
        },
        async startJob(opts) {
          const stateFile = join(opts.logDir ?? plan.background, `${opts.name}.job.json`);
          if (opts.name === "baseware") {
            launchedCommands.set(plan.workspace, [...opts.command]);
          }
          runningJobs.set(stateKey(stateFile), { pid: ++nextPid, stateFile });
        },
      };
    },
  });

  try {
    await udsClient.connect();
    await udsClient.call("browserHost/notify", {
      status: "online",
      hostId: mockHost.hostId,
      socketPath: mockHost.socketPath,
      pid: process.pid,
    });

    // Launch BOTH browser workspaces concurrently — neither contends nor preempts the other.
    const [up1, up2] = await Promise.all([
      supervisor.up({ workspace: wsGame1.workspace, workspaceId: wsGame1.entry.id, launchedBy: "app" }),
      supervisor.up({ workspace: wsGame2.workspace, workspaceId: wsGame2.entry.id, launchedBy: "app" }),
    ]);

    expect(up1.notes.some(n => n.includes("holder"))).toBe(false);
    expect(up2.notes.some(n => n.includes("holder"))).toBe(false);

    const cmd1 = launchedCommands.get(wsGame1.workspace)!;
    const cmd2 = launchedCommands.get(wsGame2.workspace)!;
    expect(cmd1[cmd1.indexOf("--session-id") + 1]).toBe(wsGame1.entry.id);
    expect(cmd2[cmd2.indexOf("--session-id") + 1]).toBe(wsGame2.entry.id);
    expect(cmd1[cmd1.indexOf("--browser-socket") + 1]).toBe(mockHost.socketPath);
    expect(cmd2[cmd2.indexOf("--browser-socket") + 1]).toBe(mockHost.socketPath);
    expect(cmd1[cmd1.indexOf("--initial-url") + 1]).toBe("https://game1.example/play");
    expect(cmd2[cmd2.indexOf("--initial-url") + 1]).toBe("http://localhost:5173/arena");

    // Describe both viewports concurrently via App-Server RPC -> both online with isolated sessions & URLs!
    const [vp1, vp2] = await Promise.all([
      udsClient.call("viewport/describe", { project: wsGame1.entry.id }),
      udsClient.call("viewport/describe", { project: wsGame2.entry.id }),
    ]);
    expect(vp1).toMatchObject({
      stageKind: "browser",
      available: true,
      connected: true,
      sessionId: wsGame1.entry.id,
      navigation: { url: "https://game1.example/play" },
    });
    expect(vp2).toMatchObject({
      stageKind: "browser",
      available: true,
      connected: true,
      sessionId: wsGame2.entry.id,
      navigation: { url: "http://localhost:5173/arena" },
    });

    // Navigate game 1 independently without affecting game 2.
    await udsClient.call("viewport/action", {
      project: wsGame1.entry.id,
      action: { kind: "navigate", url: "https://game1.example/level-2" },
    });
    const [vp1After, vp2After] = await Promise.all([
      udsClient.call("viewport/describe", { project: wsGame1.entry.id }),
      udsClient.call("viewport/describe", { project: wsGame2.entry.id }),
    ]);
    expect(vp1After.navigation?.url).toBe("https://game1.example/level-2");
    expect(vp2After.navigation?.url).toBe("http://localhost:5173/arena");
  } finally {
    await supervisor.shutdownAll({ emergency: true }).catch(() => {});
    await udsClient.close().catch(() => {});
    await server.close({ emergency: true }).catch(() => {});
    await mockHost.close().catch(() => {});
    invalidateBrowserHostCache(home);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("probeBrowserHost expires transient negative misses rapidly without poisoning recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-bh-neg-ttl-")));
  const home = join(root, "home");
  invalidateBrowserHostCache(home);

  let mockHost: MockBrowserHostHandle | null = null;
  try {
    // 1. Offline probe records a transient negative cache entry.
    const miss = await probeBrowserHost(home);
    expect(miss.available).toBe(false);

    // 2. Start BrowserHost and wait just past the short negative TTL -> recovers automatically without force!
    mockHost = await startMockBrowserHost(home, "recovered-host");
    await Bun.sleep(DEFAULT_BROWSER_HOST_NEGATIVE_CACHE_TTL_MS + 40);
    const recovered = await probeBrowserHost(home);
    expect(recovered.available).toBe(true);
    expect(recovered.hostId).toBe("recovered-host");
  } finally {
    if (mockHost) await mockHost.close().catch(() => {});
    invalidateBrowserHostCache(home);
    await rm(root, { recursive: true, force: true });
  }
});
