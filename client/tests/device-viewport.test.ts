import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUILTIN_BROWSER_START_URL,
  decodeViewportFrame,
  encodeViewportFrame,
  viewportFormatMimeType,
  type ViewportState,
} from "@ludens/protocol/viewport";
import { BUILTIN_BROWSER_DRIVER, BUILTIN_BROWSER_DRIVER_SPEC } from "@ludens/protocol/drivers";
import {
  BUILTIN_LOCAL_BROWSER_MACHINE,
  BUILTIN_LOCAL_DESKTOP_MACHINE,
} from "@ludens/protocol/machines";
import type { BasewareDriverOverviewItem, BasewareMachineRuntimeStatus } from "@ludens/protocol/workspaces";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { resolveConnectionEndpoints } from "../lib/connection-target";
import { LocaleProvider } from "../lib/locale";
import { resolveRuntimeCapabilities } from "../lib/use-runtime-capabilities";
import {
  buildViewportWsUrl,
  computePointerCoordinates,
  extractInputModifiers,
  mapMouseButton,
  normalizeBrowserNavigationUrl,
  resolveEffectiveStageKind,
  type UseDeviceViewportResult,
} from "../features/live/use-device-viewport";
import { DeviceViewport } from "../features/live/device-viewport";
import {
  emptyWorkspaceDraft,
  isBrowserTargetDraft,
  resolveFirstClassEnvironment,
  selectFirstClassEnvironment,
  workspaceCreateInput,
} from "../features/workspaces/workspace-create-model";
import { runWorkspaceWithClient } from "../cli/workspace";
import type { AppRpcClient } from "../cli/app-rpc-client";

const BASE_CAPS = {
  navigate: true,
  keyboard: true,
  mouse: true,
  pointerLock: true,
  resize: true,
  nativeEmbed: true,
};

function makeViewportState(overrides: Partial<ViewportState> = {}): ViewportState {
  return {
    stageKind: "browser",
    available: true,
    connected: true,
    machineId: "builtin-browser",
    driver: "browser",
    sessionId: "ws-demo",
    nativeHostId: "host-1",
    width: 1280,
    height: 720,
    pointerLocked: false,
    controlMode: "manual",
    navigation: {
      url: BUILTIN_BROWSER_START_URL,
      title: "Ludens Arena",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
    capabilities: BASE_CAPS,
    ...overrides,
  };
}

function makeStubViewportResult(
  state: ViewportState | null,
  overrides: Partial<UseDeviceViewportResult> = {},
): UseDeviceViewportResult {
  return {
    state,
    effectiveStageKind: resolveEffectiveStageKind(state),
    transportMode: state?.available ? "stream" : "none",
    streamStatus: state?.available ? "connected" : "idle",
    loading: false,
    error: null,
    occluded: false,
    hasFrame: Boolean(state?.available),
    pointerLockedLocal: false,
    slotRef: { current: null },
    canvasRef: { current: null },
    stageRef: { current: null },
    stageHandlers: {
      onMouseMove() {},
      onMouseDown() {},
      onMouseUp() {},
      onWheel() {},
      onContextMenu() {},
      onDoubleClick() {},
      onKeyDown() {},
      onKeyUp() {},
      onBlur() {},
    },
    async refresh() {},
    async performAction() {},
    sendInput() {},
    requestPointerLock() {},
    exitPointerLock() {},
    ...overrides,
  };
}

function collectLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...collectLeafKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

test("decodeViewportFrame round-trips binary viewport packets with metadata and payload", () => {
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const encoded = encodeViewportFrame({
    format: "jpeg",
    width: 1280,
    height: 720,
    timestampMs: 1732500000123.5,
    seq: 42,
    pointerLocked: true,
    bytes: payload,
  });

  const decoded = decodeViewportFrame(encoded);
  assert.equal(decoded.format, "jpeg");
  assert.equal(viewportFormatMimeType(decoded.format), "image/jpeg");
  assert.equal(decoded.width, 1280);
  assert.equal(decoded.height, 720);
  assert.equal(decoded.timestampMs, 1732500000123.5);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.pointerLocked, true);
  assert.deepEqual(Array.from(decoded.bytes), Array.from(payload));
});

test("resolveEffectiveStageKind implements browser, live computer, and observe fallback semantics", () => {
  assert.equal(resolveEffectiveStageKind(null), "observe");
  assert.equal(resolveEffectiveStageKind(undefined), "observe");

  // Browser always stays "browser" even when Desktop BrowserHost is offline so the offline card shows
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "browser", available: true, connected: true })),
    "browser",
  );
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "browser", available: false, connected: false })),
    "browser",
  );

  // Computer promotes to "computer" only when an active live viewport stream is connected
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "computer", available: true, connected: true })),
    "computer",
  );
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "computer", available: true, connected: false })),
    "observe",
  );
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "computer", available: false, connected: false })),
    "observe",
  );

  // Classic devices remain "observe"
  assert.equal(
    resolveEffectiveStageKind(makeViewportState({ stageKind: "observe", available: false, connected: false })),
    "observe",
  );
});

test("buildViewportWsUrl builds authenticated /viewport WS URLs and skips pure IPC targets", () => {
  const ipcTarget = { kind: "electron-local" as const };
  const ipcResolved = resolveConnectionEndpoints(ipcTarget, { hasDesktopRpc: true });
  assert.equal(
    buildViewportWsUrl({
      project: "ws-browser",
      target: ipcTarget,
      resolved: ipcResolved,
      mediaTicket: "tk-123",
    }),
    null,
  );

  const remoteTarget = { kind: "remote" as const, url: "https://ludens.example/base" };
  const remoteResolved = resolveConnectionEndpoints(remoteTarget);
  assert.equal(
    buildViewportWsUrl({
      project: "ws-browser",
      machineId: "builtin-browser",
      target: remoteTarget,
      resolved: remoteResolved,
      mediaTicket: "tk-abc",
    }),
    "wss://ludens.example/base/viewport?project=ws-browser&machine=builtin-browser&ticket=tk-abc",
  );

  const sameOriginTarget = { kind: "same-origin" as const };
  const sameOriginResolved = resolveConnectionEndpoints(sameOriginTarget, {
    location: {
      protocol: "http:",
      host: "127.0.0.1:3015",
      pathname: "/",
      search: "",
      hash: "",
    },
  });
  assert.equal(
    buildViewportWsUrl({
      project: "ws-1",
      target: sameOriginTarget,
      resolved: sameOriginResolved,
    }),
    "ws://127.0.0.1:3015/viewport?project=ws-1",
  );
});

test("normalizeBrowserNavigationUrl and input coordinate/modifier helpers behave accurately", () => {
  assert.equal(normalizeBrowserNavigationUrl(BUILTIN_BROWSER_START_URL), BUILTIN_BROWSER_START_URL);
  assert.equal(normalizeBrowserNavigationUrl("about:blank"), "about:blank");
  assert.equal(normalizeBrowserNavigationUrl("ABOUT:BLANK"), "about:blank");
  assert.equal(normalizeBrowserNavigationUrl("threejs.org/examples/"), "https://threejs.org/examples/");
  assert.equal(normalizeBrowserNavigationUrl("localhost:5173/game"), "http://localhost:5173/game");
  assert.equal(normalizeBrowserNavigationUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(normalizeBrowserNavigationUrl("https://example.com/app"), "https://example.com/app");
  assert.equal(normalizeBrowserNavigationUrl("javascript:alert(1)"), null);
  assert.equal(normalizeBrowserNavigationUrl("file:///etc/passwd"), null);
  assert.equal(normalizeBrowserNavigationUrl("ludens-app://console"), null);
  assert.equal(normalizeBrowserNavigationUrl("   "), null);

  assert.deepEqual(
    computePointerCoordinates({ left: 100, top: 50, width: 640, height: 360 }, 420, 230, 1280, 720),
    { x: 640, y: 360 },
  );
  assert.deepEqual(
    computePointerCoordinates({ left: 100, top: 50, width: 640, height: 360 }, 0, 999, 1280, 720),
    { x: 0, y: 720 },
  );
  assert.equal(extractInputModifiers({ altKey: true, shiftKey: true }), 9);
  assert.equal(extractInputModifiers({ ctrlKey: true, metaKey: true }), 6);
  assert.equal(mapMouseButton(0), "left");
  assert.equal(mapMouseButton(1), "middle");
  assert.equal(mapMouseButton(2), "right");
});

test("resolveRuntimeCapabilities preserves builtinBrowser and browserHostId when reported by server", () => {
  const target = { kind: "electron-local" as const };
  const resolved = resolveConnectionEndpoints(target, { hasDesktopRpc: true });
  const state = resolveRuntimeCapabilities({
    target,
    resolved,
    serverInfo: {
      runtimeProfile: "desktop",
      capabilities: {
        localFsPaths: true,
        localFileDrivers: true,
        hostProcessOverrides: true,
        hostStorageConfig: true,
        builtinBrowser: true,
        browserHostId: "desktop-host-42",
      },
    },
  });
  assert.equal(state.capabilities.builtinBrowser, true);
  assert.equal(state.capabilities.browserHostId, "desktop-host-42");
});

test("workspace-create-model supports Built-in Browser first-class selection and optional initial url", () => {
  const root = "/Users/demo/workspaces";
  const browserMachine: BasewareMachineRuntimeStatus = {
    ...BUILTIN_LOCAL_BROWSER_MACHINE,
    available: true,
    usedByWorkspaceIds: [],
  };
  const desktopMachine: BasewareMachineRuntimeStatus = {
    ...BUILTIN_LOCAL_DESKTOP_MACHINE,
    usedByWorkspaceIds: [],
  };
  const machines = [browserMachine, desktopMachine];

  const browserDraft = {
    ...selectFirstClassEnvironment({ ...emptyWorkspaceDraft, name: "webgl-arena" }, "browser"),
    url: " https://threejs.org/examples/webgl_geometry_cube.html ",
  };

  assert.equal(isBrowserTargetDraft(browserDraft, { machines }), true);
  assert.equal(resolveFirstClassEnvironment(browserDraft, { machines }), "browser");

  assert.deepEqual(workspaceCreateInput(root, browserDraft, null, { machines }), {
    ok: true,
    input: {
      name: "webgl-arena",
      driver: "browser",
      machineId: "builtin-browser",
      url: "https://threejs.org/examples/webgl_geometry_cube.html",
    },
  });

  // Leaving url blank omits url so server defaults to ludens-browser://start
  const defaultUrlDraft = { ...browserDraft, url: "   " };
  assert.deepEqual(workspaceCreateInput(root, defaultUrlDraft, null, { machines }), {
    ok: true,
    input: {
      name: "webgl-arena",
      driver: "browser",
      machineId: "builtin-browser",
    },
  });

  // Switching to Computer (CUA) clears url and targets local-desktop
  const computerDraft = selectFirstClassEnvironment(browserDraft, "computer");
  assert.equal(resolveFirstClassEnvironment(computerDraft, { machines }), "computer");
  assert.equal(isBrowserTargetDraft(computerDraft, { machines }), false);
  assert.deepEqual(workspaceCreateInput(root, computerDraft, null, { machines }), {
    ok: true,
    input: {
      name: "webgl-arena",
      driver: "cua",
      machineId: "local-desktop",
    },
  });

  // Driver mode with builtin:browser catalog driver passes driver: "browser" + url without driverPackage
  const browserCatalogDriver: BasewareDriverOverviewItem = {
    key: BUILTIN_BROWSER_DRIVER_SPEC,
    id: BUILTIN_BROWSER_DRIVER.id,
    spec: BUILTIN_BROWSER_DRIVER_SPEC,
    sourceKind: "builtin",
    registrationStatus: "builtin",
    available: true,
    runtimeInjected: true,
    stageKind: "browser",
    transport: "stdio",
    needsGame: false,
    usedByMachineIds: ["builtin-browser"],
    usedByWorkspaceIds: [],
    usedByCurrentWorkspace: false,
    updatedAt: BUILTIN_BROWSER_DRIVER.updatedAt,
  };
  const driverBrowserDraft = {
    ...emptyWorkspaceDraft,
    name: "browser-driver-ws",
    targetMode: "driver" as const,
    driverId: "browser",
    url: BUILTIN_BROWSER_START_URL,
  };
  assert.deepEqual(
    workspaceCreateInput(root, driverBrowserDraft, null, { catalogDriver: browserCatalogDriver }),
    {
      ok: true,
      input: {
        name: "browser-driver-ws",
        driver: "browser",
        url: BUILTIN_BROWSER_START_URL,
      },
    },
  );
});

test("DeviceViewport renders browser chrome, auto reclaim overlay, offline card, and computer chrome without omnibox", () => {
  const browserAutoHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DeviceViewport, {
        viewport: makeStubViewportResult(makeViewportState({ controlMode: "auto" })),
        stageKind: "browser",
        isAuto: true,
        immersive: true,
        onToggleImmersive() {},
        onReclaimControl() {},
      }),
    ),
  );
  assert.match(browserAutoHtml, /device-viewport-omnibox/);
  assert.match(browserAutoHtml, /data-immersive="true"/);
  assert.match(browserAutoHtml, /data-viewport-immersive-toggle=""/);
  assert.match(browserAutoHtml, /1280×720/);
  assert.match(browserAutoHtml, /data-viewport-reclaim=""/);
  assert.match(browserAutoHtml, /data-viewport-auto-overlay=""/);

  const browserOfflineHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DeviceViewport, {
        viewport: makeStubViewportResult(
          makeViewportState({ available: false, connected: false, controlMode: "offline" }),
        ),
        stageKind: "browser",
        isAuto: false,
      }),
    ),
  );
  assert.match(browserOfflineHtml, /data-viewport-offline=""/);
  assert.match(browserOfflineHtml, /Built-in Browser Offline/);

  const computerHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DeviceViewport, {
        viewport: makeStubViewportResult(
          makeViewportState({
            stageKind: "computer",
            machineId: "cua-vm-01",
            driver: "cua",
            navigation: undefined,
            capabilities: { ...BASE_CAPS, navigate: false, nativeEmbed: false },
          }),
        ),
        stageKind: "computer",
        isAuto: false,
      }),
    ),
  );
  assert.doesNotMatch(computerHtml, /device-viewport-omnibox/);
  assert.match(computerHtml, /cua-vm-01/);
  assert.match(computerHtml, /Manual/);
});

test("CLI ludens workspace init forwards --url for browser workspaces", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fakeClient = {
    async call(method: string, params?: unknown) {
      calls.push({ method, params });
      return { id: "ws-browser", name: "arena", workspace: "/tmp/arena", updatedAt: "2026-11-25T00:00:00.000Z" };
    },
  } as unknown as AppRpcClient;

  const lines: string[] = [];
  const code = await runWorkspaceWithClient(
    fakeClient,
    ["init", "--name", "arena", "--driver", "browser", "--url", "https://threejs.org/examples/"],
    "",
    false,
    "uds",
    { out: line => lines.push(line) },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "workspaces/mutate");
  assert.deepEqual(calls[0]!.params, {
    action: "create",
    input: {
      name: "arena",
      driver: "browser",
      url: "https://threejs.org/examples/",
    },
  });
});

test("en.json and zh.json maintain exact key parity across all namespaces including deviceViewport", () => {
  const enKeys = collectLeafKeys(en as unknown as Record<string, unknown>);
  const zhKeys = collectLeafKeys(zh as unknown as Record<string, unknown>);
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(enKeys.some(key => key.startsWith("deviceViewport.")));
  assert.ok(enKeys.includes("workspaceSetup.initialUrlLabel"));
  assert.ok(enKeys.includes("shioriCockpit.resizeDockAria"));
});
