import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { APP_RPC_PROTOCOL_VERSION } from "@ludens/protocol/app-rpc";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { isLoopbackHost, resolveConnectionEndpoints } from "../lib/connection-target";
import type { DesktopRpcBridge } from "../lib/desktop";
import { LocaleProvider } from "../lib/locale";
import {
  formatConnectionBannerMessage,
  LudensRpcClient,
  LudensRpcProvider,
  type LudensRpcSnapshot,
  type RpcWebSocketLike,
} from "../lib/ludens-rpc";
import {
  DEV_SIMULATE_PROFILE_SESSION_KEY,
  FULL_HOST_CAPABILITIES,
  getDevSimulatedProfile,
  MANAGED_SANDBOX_CAPABILITIES,
  resolveRuntimeCapabilities,
  resolveSnapshotRuntimeCapabilities,
  setDevSimulatedProfile,
  useRuntimeCapabilities,
} from "../lib/use-runtime-capabilities";
import { ConnectionTargetDialog } from "../components/connection-target-dialog";
import { ConsoleSidebar } from "../shell/console-sidebar";
import { DesktopQuickSwitcher } from "../shell/desktop-quick-switcher";
import { WorkspaceCreateForm } from "../features/workspaces/workspace-create-form";
import { WorkspacesView } from "../features/workspaces/workspaces-view";
import { StorageProfileForm } from "../features/workspaces/storage-settings";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

class FakeWebSocket implements RpcWebSocketLike {
  readonly sent: Array<{ jsonrpc: string; id: number; method: string }> = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitResult(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }

  triggerClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function createConnectedIpcClient(): LudensRpcClient {
  const messageListeners = new Set<(frameJson: string) => void>();
  const bridge: DesktopRpcBridge = {
    send(frameJson) {
      const parsed = JSON.parse(frameJson) as { id: number; method: string };
      queueMicrotask(() => {
        if (parsed.method === "initialize") {
          for (const cb of messageListeners) {
            cb(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  serverVersion: "0.2.0",
                  pid: 99,
                  home: "/Users/demo/.ludens",
                  transport: "uds",
                  authenticated: true,
                  serverSeq: 1,
                  activeCoreCount: 0,
                  managedWorkspaces: [],
                  runtimeProfile: "desktop",
                  capabilities: FULL_HOST_CAPABILITIES,
                  media: { basePath: "/media", liveStreamCapabilities: ["none"] },
                },
              }),
            );
          }
        } else if (parsed.method === "events/subscribe") {
          for (const cb of messageListeners) {
            cb(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { subscribedSeq: 1, events: [], replayTruncated: false },
              }),
            );
          }
        }
      });
    },
    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onStatus(cb) {
      cb({ state: "connected" });
      return () => {};
    },
  };

  return new LudensRpcClient({
    target: { kind: "electron-local" },
    env: { hasDesktopRpc: true },
    desktopBridge: bridge,
  });
}

test("isLoopbackHost and resolveRuntimeCapabilities infer desktop, web-dev, and remote fallbacks cleanly", () => {
  assert.equal(isLoopbackHost("127.0.0.1:3015"), true);
  assert.equal(isLoopbackHost("localhost:3000"), true);
  assert.equal(isLoopbackHost("[::1]:3015"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("http://127.0.0.1:3015"), true);
  assert.equal(isLoopbackHost("console.ludens.cloud"), false);
  assert.equal(isLoopbackHost("192.168.1.20:3015"), false);

  const desktopCaps = resolveRuntimeCapabilities({
    target: { kind: "electron-local" },
    resolved: resolveConnectionEndpoints({ kind: "electron-local" }, { hasDesktopRpc: true }),
  });
  assert.equal(desktopCaps.runtimeProfile, "desktop");
  assert.equal(desktopCaps.actualProfile, "desktop");
  assert.deepEqual(desktopCaps.capabilities, FULL_HOST_CAPABILITIES);

  const webDevResolved = resolveConnectionEndpoints(
    { kind: "same-origin" },
    {
      location: {
        protocol: "http:",
        host: "127.0.0.1:3015",
        pathname: "/",
        search: "",
        hash: "",
      },
    },
  );
  const webDevCaps = resolveRuntimeCapabilities({
    target: { kind: "same-origin" },
    resolved: webDevResolved,
  });
  assert.equal(webDevCaps.runtimeProfile, "web-dev");
  assert.equal(webDevCaps.actualProfile, "web-dev");
  assert.deepEqual(webDevCaps.capabilities, FULL_HOST_CAPABILITIES);

  // Dev UI simulation override toggles web-dev into SaaS remote capabilities in 1 click
  const simulatedRemote = resolveRuntimeCapabilities({
    target: { kind: "same-origin" },
    resolved: webDevResolved,
    serverInfo: {
      home: "/Users/demo/.ludens-dev",
      runtimeProfile: "web-dev",
      capabilities: FULL_HOST_CAPABILITIES,
    },
    devSimulatedProfile: "remote",
  });
  assert.equal(simulatedRemote.actualProfile, "web-dev");
  assert.equal(simulatedRemote.runtimeProfile, "remote");
  assert.equal(simulatedRemote.isSimulated, true);
  assert.equal(simulatedRemote.serverHome, "/Users/demo/.ludens-dev");
  assert.deepEqual(simulatedRemote.capabilities, MANAGED_SANDBOX_CAPABILITIES);

  // Real remote SaaS sessions never grant host capabilities even if devSimulatedProfile="desktop"
  const saasResolved = resolveConnectionEndpoints({
    kind: "remote",
    url: "https://cloud.ludens.example",
  });
  const remoteCaps = resolveRuntimeCapabilities({
    target: { kind: "remote", url: "https://cloud.ludens.example" },
    resolved: saasResolved,
    devSimulatedProfile: "desktop",
  });
  assert.equal(remoteCaps.actualProfile, "remote");
  assert.equal(remoteCaps.runtimeProfile, "remote");
  assert.equal(remoteCaps.isSimulated, false);
  assert.deepEqual(remoteCaps.capabilities, MANAGED_SANDBOX_CAPABILITIES);
});

test("LudensRpcClient persists lastKnownServerInfo across disconnects and formatConnectionBannerMessage eliminates raw 1006 errors", async () => {
  const sockets: FakeWebSocket[] = [];
  const client = new LudensRpcClient({
    target: { kind: "remote", url: "http://127.0.0.1:43120" },
    createWebSocket: url => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
  });

  try {
    sockets[0].triggerOpen();
    sockets[0].emitResult(sockets[0].sent[0].id, {
      serverVersion: "0.2.0",
      protocolVersion: APP_RPC_PROTOCOL_VERSION,
      pid: 4242,
      home: "/Users/demo/.ludens-dev",
      transport: "ws",
      authenticated: true,
      serverSeq: 1,
      activeCoreCount: 0,
      managedWorkspaces: [],
      runtimeProfile: "web-dev",
      capabilities: FULL_HOST_CAPABILITIES,
      media: { basePath: "/media", ticket: "tk", ticketExpiresAt: Date.now() + 60_000, liveStreamCapabilities: ["none"] },
    });
    await flushAsync();
    sockets[0].emitResult(sockets[0].sent[1].id, {
      subscribedSeq: 1,
      events: [],
      replayTruncated: false,
    });
    await flushAsync();

    assert.equal(client.getSnapshot().status, "connected");
    assert.equal(client.getSnapshot().lastKnownServerInfo?.home, "/Users/demo/.ludens-dev");

    // Simulate dev server stopping abruptly with WebSocket code 1006
    sockets[0].triggerClose(1006);
    const droppedSnap = client.getSnapshot();
    assert.equal(droppedSnap.error, "WebSocket closed (1006)");
    assert.equal(droppedSnap.serverInfo, undefined);
    assert.equal(droppedSnap.lastKnownServerInfo?.home, "/Users/demo/.ludens-dev");

    const postDropCaps = resolveSnapshotRuntimeCapabilities(droppedSnap);
    assert.equal(postDropCaps.actualProfile, "web-dev");
    assert.equal(postDropCaps.serverHome, "/Users/demo/.ludens-dev");

    const zhMsg = formatConnectionBannerMessage(
      droppedSnap,
      key => (zh.connectionTarget as Record<string, string>)[key] ?? key,
    );
    const enMsg = formatConnectionBannerMessage(
      droppedSnap,
      key => (en.connectionTarget as Record<string, string>)[key] ?? key,
    );
    assert.match(zhMsg, /本地开发预览服务（http:\/\/127\.0\.0\.1:43120）已停止/);
    assert.match(zhMsg, /npm run dev/);
    assert.doesNotMatch(zhMsg, /1006|WebSocket closed/);

    assert.match(enMsg, /Local dev preview server \(http:\/\/127\.0\.0\.1:43120\) has stopped/);
    assert.match(enMsg, /npm run dev/);
    assert.doesNotMatch(enMsg, /1006|WebSocket closed/);
  } finally {
    client.dispose();
  }

  // Desktop & Remote disconnect messages also translate 1006 cleanly
  const desktopDisconnectedSnap: LudensRpcSnapshot = {
    status: "disconnected",
    error: "Desktop RPC bridge disconnected",
    needsAuth: false,
    isReady: false,
    target: { kind: "electron-local" },
    resolved: resolveConnectionEndpoints({ kind: "electron-local" }, { hasDesktopRpc: true }),
    serverSeq: null,
    reconnectGeneration: 0,
  };
  const desktopZh = formatConnectionBannerMessage(
    desktopDisconnectedSnap,
    key => (zh.connectionTarget as Record<string, string>)[key] ?? key,
  );
  assert.equal(desktopZh, "本机后台守护进程连接暂时中断，可点击重试恢复连接。");

  const remoteDisconnectedSnap: LudensRpcSnapshot = {
    status: "reconnecting",
    error: "WebSocket closed (1006)",
    needsAuth: false,
    isReady: false,
    target: { kind: "remote", url: "https://saas.ludens.example" },
    resolved: resolveConnectionEndpoints({ kind: "remote", url: "https://saas.ludens.example" }),
    serverSeq: 5,
    reconnectGeneration: 1,
  };
  const remoteZh = formatConnectionBannerMessage(
    remoteDisconnectedSnap,
    key => (zh.connectionTarget as Record<string, string>)[key] ?? key,
  );
  assert.equal(
    remoteZh,
    "与远端 Ludens 服务（https://saas.ludens.example）的连接已中断，请检查网络或服务状态后重试。",
  );
  assert.doesNotMatch(remoteZh, /1006/);
});

test("ConsoleSidebar hides connection pill on healthy electron-local and renders DEV PREVIEW badge with isolated home tooltip on web-dev", async () => {
  const desktopClient = createConnectedIpcClient();
  const webDevSockets: FakeWebSocket[] = [];
  const webDevClient = new LudensRpcClient({
    target: { kind: "same-origin" },
    env: {
      location: {
        protocol: "http:",
        host: "127.0.0.1:3015",
        pathname: "/",
        search: "",
        hash: "",
      },
    },
    createWebSocket: url => {
      const ws = new FakeWebSocket(url);
      webDevSockets.push(ws);
      return ws;
    },
  });

  try {
    await flushAsync();
    assert.equal(desktopClient.getSnapshot().status, "connected");

    const healthyDesktopSidebarHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(LudensRpcProvider, {
          client: desktopClient,
          children: createElement(ConsoleSidebar, {
            view: "live",
            viewLink: v => `/?view=${v}`,
            onNavigate() {},
            desktopChrome: true,
            onOpenConnectionDialog() {},
          }),
        }),
      ),
    );
    assert.doesNotMatch(healthyDesktopSidebarHtml, /sidebar-connection-pill/);

    // Complete web-dev handshake with ~/.ludens-dev home
    webDevSockets[0].triggerOpen();
    webDevSockets[0].emitResult(webDevSockets[0].sent[0].id, {
      serverVersion: "0.2.0",
      protocolVersion: APP_RPC_PROTOCOL_VERSION,
      pid: 777,
      home: "/Users/demo/.ludens-dev",
      transport: "ws",
      authenticated: true,
      serverSeq: 1,
      activeCoreCount: 0,
      managedWorkspaces: [],
      runtimeProfile: "web-dev",
      capabilities: FULL_HOST_CAPABILITIES,
      media: { basePath: "/media", liveStreamCapabilities: ["none"] },
    });
    await flushAsync();
    webDevSockets[0].emitResult(webDevSockets[0].sent[1].id, {
      subscribedSeq: 1,
      events: [],
      replayTruncated: false,
    });
    await flushAsync();

    const webDevSidebarHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(LudensRpcProvider, {
          client: webDevClient,
          children: createElement(ConsoleSidebar, {
            view: "live",
            viewLink: v => `/?view=${v}`,
            onNavigate() {},
            onOpenConnectionDialog() {},
          }),
        }),
      ),
    );
    assert.match(webDevSidebarHtml, /sidebar-connection-pill/);
    assert.match(webDevSidebarHtml, /data-dev-preview-badge=""/);
    assert.match(webDevSidebarHtml, /DEV PREVIEW/);
    assert.match(webDevSidebarHtml, /127\.0\.0\.1:3015/);
    assert.match(webDevSidebarHtml, /\/Users\/demo\/\.ludens-dev/);
  } finally {
    desktopClient.dispose();
    webDevClient.dispose();
  }
});

test("useRuntimeCapabilities + ConnectionTargetDialog toggle Dev UI Simulation via sessionStorage and gate remote workspace forms", async () => {
  const { JSDOM } = nodeRequire("jsdom") as {
    JSDOM: new (html: string, options?: { url?: string }) => {
      window: Window & typeof globalThis & { close(): void };
    };
  };
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://127.0.0.1:3015/",
  });
  const globalAny = globalThis as Record<string, unknown>;
  const patchedGlobals = [
    "window",
    "document",
    "location",
    "getComputedStyle",
    "HTMLElement",
    "HTMLFormElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const savedGlobals = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of patchedGlobals) {
    savedGlobals.set(key, { existed: key in globalAny, value: globalAny[key] });
  }

  globalAny.window = dom.window;
  globalAny.document = dom.window.document;
  globalAny.location = dom.window.location;
  globalAny.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalAny.HTMLElement = dom.window.HTMLElement;
  globalAny.HTMLFormElement = dom.window.HTMLFormElement;
  globalAny.HTMLInputElement = dom.window.HTMLInputElement;
  globalAny.HTMLButtonElement = dom.window.HTMLButtonElement;
  globalAny.Element = dom.window.Element;
  globalAny.Node = dom.window.Node;
  globalAny.IS_REACT_ACT_ENVIRONMENT = true;

  const client = new LudensRpcClient({
    target: { kind: "same-origin" },
    env: {
      location: dom.window.location,
      sessionStorage: dom.window.sessionStorage,
      localStorage: dom.window.localStorage,
    },
    autoConnect: false,
  });

  let latestCaps: ReturnType<typeof useRuntimeCapabilities> | null = null;
  function Probe() {
    latestCaps = useRuntimeCapabilities();
    return createElement(ConnectionTargetDialog, { open: true, onOpenChange() {} });
  }

  function renderFormsMarkup(): string {
    return renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(LudensRpcProvider, {
          client,
          children: createElement(
            "div",
            null,
            createElement(WorkspaceCreateForm, {
              defaultRoot: "/Users/demo/.ludens-dev/workspaces",
              initialIntent: { driverPackage: "github:ludens/driver#main" },
              pending: false,
              error: "",
              onSubmit() {},
              onCancel() {},
            }),
            createElement(StorageProfileForm, {
              editingProfile: null,
              existingIds: ["local-default"],
              onCancel() {},
              async onSave() {},
              async onTest() {
                return { ok: true, latencyMs: 1 };
              },
            }),
          ),
        }),
      ),
    );
  }

  const root = createRoot(dom.window.document.getElementById("root")!);

  try {
    setDevSimulatedProfile("auto", dom.window.sessionStorage);
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          null,
          createElement(LudensRpcProvider, { client, children: createElement(Probe) }),
        ),
      );
    });

    assert.equal(latestCaps!.actualProfile, "web-dev");
    assert.equal(latestCaps!.runtimeProfile, "web-dev");
    assert.deepEqual(latestCaps!.capabilities, FULL_HOST_CAPABILITIES);
    assert.ok(
      dom.window.document.querySelector("[data-dev-ui-simulation]"),
      "ConnectionTargetDialog should render Dev UI Simulation banner in web-dev mode",
    );

    const autoFormsHtml = renderFormsMarkup();
    assert.match(autoFormsHtml, /file:\/abs\/path|file: addresses/);
    assert.match(autoFormsHtml, /value="directory"/);

    // Click the SaaS Remote simulation button inside ConnectionTargetDialog
    const simulateRemoteBtn = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-simulate-profile="remote"]',
    );
    assert.ok(simulateRemoteBtn);
    await act(async () => {
      simulateRemoteBtn.click();
    });

    assert.equal(
      dom.window.sessionStorage.getItem(DEV_SIMULATE_PROFILE_SESSION_KEY),
      "remote",
    );
    assert.equal(getDevSimulatedProfile(dom.window.sessionStorage), "remote");
    assert.equal(latestCaps!.actualProfile, "web-dev");
    assert.equal(latestCaps!.runtimeProfile, "remote");
    assert.deepEqual(latestCaps!.capabilities, MANAGED_SANDBOX_CAPABILITIES);

    // Verify WorkspaceCreateForm & StorageProfileForm reflect simulated remote capabilities:
    const remoteFormsHtml = renderFormsMarkup();
    // 1. Custom path toggle hidden & managed workspace slug rendered instead of /Users/...
    assert.doesNotMatch(remoteFormsHtml, /\/Users\/demo\/\.ludens-dev\/workspaces/);
    assert.match(remoteFormsHtml, /data-managed-workspace-slug=""/);
    // 2. file: local path hint omitted in package mode (shows GitHub / npm package instead)
    assert.doesNotMatch(remoteFormsHtml, /file:\/abs\/path|file: addresses/);
    assert.match(remoteFormsHtml, /Import GitHub \/ npm package/);
    // 3. cuaCommand override hidden
    assert.doesNotMatch(remoteFormsHtml, /name="cuaCommand"/);
    // 4. directory storage backend option hidden in StorageProfileForm
    assert.doesNotMatch(remoteFormsHtml, /value="directory"/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    setDevSimulatedProfile("auto", dom.window.sessionStorage);
    client.dispose();
    dom.window.close();
    for (const [key, entry] of savedGlobals.entries()) {
      if (entry.existed) {
        globalAny[key] = entry.value;
      } else {
        delete globalAny[key];
      }
    }
  }
});

test("WorkspacesView in remote mode hides Add Existing & Default Location card, and DesktopQuickSwitcher triggers ConnectionTargetDialog", () => {
  const remoteClient = new LudensRpcClient({
    target: { kind: "remote", url: "https://saas.ludens.example" },
    autoConnect: false,
  });

  try {
    const workspacesHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(LudensRpcProvider, {
          client: remoteClient,
          children: createElement(WorkspacesView, {
            onChanged() {},
            onOpen() {},
          }),
        }),
      ),
    );

    assert.doesNotMatch(workspacesHtml, /Add existing/);
    assert.doesNotMatch(workspacesHtml, /Default location/);
    assert.doesNotMatch(workspacesHtml, /ludens --workspace/);

    let openedDialog = 0;
    const switcherHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(DesktopQuickSwitcher, {
          open: true,
          onOpenChange() {},
          platform: "darwin",
          projects: [],
          currentProject: "",
          currentView: "live",
          viewLink: v => `/?view=${v}`,
          onNavigate() {},
          onSelectWorkspace() {},
          sidebarCollapsed: false,
          onToggleSidebar() {},
          canGoBack: false,
          canGoForward: false,
          onGoBack() {},
          onGoForward() {},
          onReload() {},
          onOpenConnectionDialog() {
            openedDialog += 1;
          },
        }),
      ),
    );
    assert.match(switcherHtml, /data-qs-item="action:connection-target"/);
    assert.equal(openedDialog, 0);
  } finally {
    remoteClient.dispose();
  }
});
