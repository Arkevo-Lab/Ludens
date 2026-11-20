import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_RPC_PROTOCOL_VERSION } from "@ludens/protocol/app-rpc";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LocaleProvider } from "../lib/locale";
import {
  LudensRpcClient,
  LudensRpcProvider,
  type RpcWebSocketLike,
} from "../lib/ludens-rpc";
import { FULL_HOST_CAPABILITIES } from "../lib/use-runtime-capabilities";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const {
  BUILTIN_LOCAL_PROFILE_ID,
  GIB_BYTES,
  RECORDING_QUALITY_TIERS,
  VIDEO_QUALITY_SPECS,
  applyGlobalQualityPreset,
  applyStudioQualityPreset,
  buildGlobalDefaultsUpdateInput,
  createGlobalStorageDefaultsDraft,
  draftToWorkspaceStorageOverride,
  formatVideoQualitySpecBadge,
  isGlobalStorageDefaultsDirty,
  shouldShowStudioPresetQuota,
  workspaceStorageToDraft,
} = nodeRequire("../lib/storage") as typeof import("../lib/storage");

const { RecordingQualityPresets } = nodeRequire(
  "../features/workspaces/recording-quality-presets",
) as typeof import("../features/workspaces/recording-quality-presets");
const { StorageSettings } = nodeRequire(
  "../features/workspaces/storage-settings",
) as typeof import("../features/workspaces/storage-settings");
const { WorkspaceModelPanel } = nodeRequire(
  "../features/workspaces/workspace-studio-view",
) as typeof import("../features/workspaces/workspace-studio-view");
const { WorkspaceCreateForm } = nodeRequire(
  "../features/workspaces/workspace-create-form",
) as typeof import("../features/workspaces/workspace-create-form");
const { emptyWorkspaceDraft, workspaceCreateInput } = nodeRequire(
  "../features/workspaces/workspace-create-model",
) as typeof import("../features/workspaces/workspace-create-model");

class FakeRpcSocket implements RpcWebSocketLike {
  readonly sent: Array<{ jsonrpc: string; id: number; method: string; params?: unknown }> = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly responder: (method: string, params: unknown) => unknown,
  ) {}

  send(data: string): void {
    const parsed = JSON.parse(data) as {
      jsonrpc: string;
      id: number;
      method: string;
      params?: unknown;
    };
    this.sent.push(parsed);
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      try {
        const result = this.responder(parsed.method, parsed.params);
        this.onmessage?.({
          data: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }),
        });
      } catch (err) {
        this.onmessage?.({
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        });
      }
    });
  }

  close(): void {
    this.readyState = 3;
  }

  openNow(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function withJsdom<T>(
  fn: (
    dom: { window: Window & typeof globalThis },
    createRoot: typeof import("react-dom/client").createRoot,
  ) => Promise<T>,
): Promise<T> {
  const { JSDOM } = nodeRequire("jsdom") as {
    JSDOM: new (
      html: string,
      options?: { url?: string; pretendToBeVisual?: boolean },
    ) => {
      window: Window & typeof globalThis & { close(): void };
    };
  };
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://127.0.0.1:3015/",
    pretendToBeVisual: true,
  });
  const globalAny = globalThis as Record<string, unknown>;
  const keys = [
    "window",
    "document",
    "location",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "HTMLElement",
    "HTMLFormElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "Event",
    "InputEvent",
    "KeyboardEvent",
    "MouseEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of keys) {
    saved.set(key, { existed: key in globalAny, value: globalAny[key] });
  }
  globalAny.window = dom.window;
  globalAny.document = dom.window.document;
  globalAny.location = dom.window.location;
  globalAny.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalAny.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalAny.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalAny.HTMLElement = dom.window.HTMLElement;
  globalAny.HTMLFormElement = dom.window.HTMLFormElement;
  globalAny.HTMLInputElement = dom.window.HTMLInputElement;
  globalAny.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalAny.HTMLButtonElement = dom.window.HTMLButtonElement;
  globalAny.Element = dom.window.Element;
  globalAny.Node = dom.window.Node;
  globalAny.Event = dom.window.Event;
  globalAny.InputEvent = dom.window.InputEvent;
  globalAny.KeyboardEvent = dom.window.KeyboardEvent;
  globalAny.MouseEvent = dom.window.MouseEvent;
  globalAny.IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = nodeRequire("react-dom/client") as typeof import("react-dom/client");

  return fn(dom, createRoot).finally(() => {
    dom.window.close();
    for (const [key, entry] of saved.entries()) {
      if (entry.existed) globalAny[key] = entry.value;
      else delete globalAny[key];
    }
  });
}

function makeStorageConfig(
  overrides?: Partial<import("../lib/storage").RedactedGlobalStorageConfig>,
): import("../lib/storage").RedactedGlobalStorageConfig {
  return {
    version: 1,
    defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
    videoQuality: "balanced",
    protectReferenced: true,
    profiles: [
      {
        id: BUILTIN_LOCAL_PROFILE_ID,
        name: "Local Default",
        kind: "local",
        maxBytes: 20 * GIB_BYTES,
        maxAgeHours: null,
        localCacheBytes: null,
      },
      {
        id: "cloudflare-r2",
        name: "Cloudflare R2",
        kind: "s3",
        maxBytes: 200 * GIB_BYTES,
        maxAgeHours: null,
        localCacheBytes: 8 * GIB_BYTES,
        s3: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          region: "auto",
          bucket: "ludens-timeline",
          accessKeyId: "AKIAEXAMPLE",
          hasSecretAccessKey: true,
          forcePathStyle: false,
        },
      },
    ],
    ...overrides,
  };
}

test("VIDEO_QUALITY_SPECS matches @ludens/protocol/storage and formatVideoQualitySpecBadge renders exact tier specs", async () => {
  const protocolStorage = await import("@ludens/protocol/storage");
  assert.deepEqual(VIDEO_QUALITY_SPECS, protocolStorage.VIDEO_QUALITY_SPECS);
  assert.deepEqual(RECORDING_QUALITY_TIERS, ["compact", "balanced", "high"]);

  assert.equal(formatVideoQualitySpecBadge("compact"), "720p · CRF 28 · 5 GiB");
  assert.equal(formatVideoQualitySpecBadge("balanced"), "1080p · CRF 23 · 20 GiB");
  assert.equal(
    formatVideoQualitySpecBadge("high", { nativeLabel: en.recordingQualityPresets.nativeResolution }),
    "Native · CRF 18 · 50 GiB",
  );
  assert.equal(
    formatVideoQualitySpecBadge("high", { nativeLabel: zh.recordingQualityPresets.nativeResolution }),
    "原画 · CRF 18 · 50 GiB",
  );

  // When showQuota=false (remote S3 / directory profile), quota suffix is omitted
  assert.equal(formatVideoQualitySpecBadge("compact", { showQuota: false }), "720p · CRF 28");
  assert.equal(formatVideoQualitySpecBadge("balanced", { showQuota: false }), "1080p · CRF 23");
  assert.equal(
    formatVideoQualitySpecBadge("high", { showQuota: false, nativeLabel: "Native" }),
    "Native · CRF 18",
  );
});

test("RecordingQualityPresets renders accessible radiogroup, showQuota modes, and keyboard arrow navigation", async () => {
  const htmlWithQuota = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(RecordingQualityPresets, {
        value: "balanced",
        defaultBadgeTier: "balanced",
        showQuota: true,
        onChange() {},
      }),
    ),
  );
  assert.match(htmlWithQuota, /role="radiogroup"/);
  assert.equal((htmlWithQuota.match(/role="radio"/g) ?? []).length, 3);
  assert.match(htmlWithQuota, /aria-checked="true"[^>]*data-quality-preset="balanced"/);
  assert.ok(htmlWithQuota.includes("720p · CRF 28 · 5 GiB"));
  assert.ok(htmlWithQuota.includes("1080p · CRF 23 · 20 GiB"));
  assert.ok(htmlWithQuota.includes("Native · CRF 18 · 50 GiB"));
  assert.doesNotMatch(htmlWithQuota, /data-quality-quota-muted-note/);
  assert.doesNotMatch(htmlWithQuota, /data-slot="card"/);

  const htmlMutedQuota = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(RecordingQualityPresets, {
        value: "high",
        showQuota: false,
        onChange() {},
      }),
    ),
  );
  assert.ok(htmlMutedQuota.includes("720p · CRF 28<"));
  assert.ok(htmlMutedQuota.includes("Native · CRF 18<"));
  assert.match(htmlMutedQuota, /data-quality-quota-muted-note=""/);

  await withJsdom(async (dom, createRoot) => {
    const selections: string[] = [];
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            null,
            createElement(RecordingQualityPresets, {
              value: "balanced",
              onChange: next => selections.push(next),
            }),
          ),
        );
      });

      const balancedBtn = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-quality-preset="balanced"]',
      )!;
      assert.equal(balancedBtn.getAttribute("tabindex"), "0");

      await act(async () => {
        balancedBtn.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      assert.equal(selections.at(-1), "high");

      await act(async () => {
        balancedBtn.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        );
      });
      assert.equal(selections.at(-1), "compact");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

test("Global StorageSettings syncs local-default maxBytes when clicking a preset card while preserving S3 secrets and custom edits", async () => {
  // 1. Pure state helper verification
  const customQuotaConfig = makeStorageConfig({
    videoQuality: "balanced",
    profiles: [
      {
        id: BUILTIN_LOCAL_PROFILE_ID,
        name: "Local Default",
        kind: "local",
        maxBytes: 12 * GIB_BYTES,
        maxAgeHours: null,
        localCacheBytes: null,
      },
      makeStorageConfig().profiles[1]!,
    ],
  });

  // Toggling protectReferenced without clicking a preset card leaves custom 12 GiB local-default untouched
  const protectOnlyDraft = {
    ...createGlobalStorageDefaultsDraft(customQuotaConfig),
    protectReferenced: false,
  };
  assert.equal(isGlobalStorageDefaultsDirty(customQuotaConfig, protectOnlyDraft), true);
  assert.deepEqual(buildGlobalDefaultsUpdateInput(customQuotaConfig, protectOnlyDraft), {
    defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
    videoQuality: "balanced",
    protectReferenced: false,
  });

  // Clicking "compact" sets videoQuality="compact" AND syncs local-default maxBytes to 5 GiB while keeping S3 secret untouched
  const compactDraft = applyGlobalQualityPreset(
    createGlobalStorageDefaultsDraft(customQuotaConfig),
    "compact",
  );
  const compactPayload = buildGlobalDefaultsUpdateInput(customQuotaConfig, compactDraft);
  assert.equal(compactPayload.videoQuality, "compact");
  assert.equal(compactPayload.profiles?.[0]?.id, BUILTIN_LOCAL_PROFILE_ID);
  assert.equal(compactPayload.profiles?.[0]?.maxBytes, 5 * GIB_BYTES);
  assert.equal(compactPayload.profiles?.[1]?.id, "cloudflare-r2");
  assert.equal("secretAccessKey" in (compactPayload.profiles?.[1]?.s3 ?? {}), false);

  // 2. Interactive JSDOM test on <StorageSettings />
  await withJsdom(async (dom, createRoot) => {
    const storageUpdates: unknown[] = [];
    let currentConfig = makeStorageConfig();
    let socket: FakeRpcSocket | null = null;

    const rpcClient = new LudensRpcClient({
      target: { kind: "remote", url: "http://127.0.0.1:43120" },
      createWebSocket: url => {
        socket = new FakeRpcSocket(url, (method, params) => {
          if (method === "initialize") {
            return {
              serverVersion: "0.2.0",
              protocolVersion: APP_RPC_PROTOCOL_VERSION,
              pid: 1,
              home: "/tmp/.ludens-dev",
              transport: "ws",
              authenticated: true,
              serverSeq: 1,
              activeCoreCount: 0,
              managedWorkspaces: [],
              runtimeProfile: "web-dev",
              capabilities: FULL_HOST_CAPABILITIES,
              media: { basePath: "/media", liveStreamCapabilities: ["none"] },
            };
          }
          if (method === "events/subscribe") {
            return { subscribedSeq: 1, events: [], replayTruncated: false };
          }
          if (method === "storage/get") {
            return { config: currentConfig, usage: [] };
          }
          if (method === "storage/update") {
            storageUpdates.push(params);
            const patch = params as import("../lib/storage").GlobalStorageUpdateInput;
            currentConfig = {
              ...currentConfig,
              ...(patch.videoQuality ? { videoQuality: patch.videoQuality } : {}),
              ...(patch.profiles
                ? {
                    profiles: patch.profiles.map(p => ({
                      ...p,
                      s3: p.s3
                        ? {
                            endpoint: p.s3.endpoint,
                            region: p.s3.region,
                            bucket: p.s3.bucket,
                            accessKeyId: p.s3.accessKeyId,
                            hasSecretAccessKey: true,
                            forcePathStyle: p.s3.forcePathStyle,
                          }
                        : undefined,
                    })),
                  }
                : {}),
            };
            return { config: currentConfig, usage: [] };
          }
          throw new Error(`Unexpected RPC: ${method}`);
        });
        return socket;
      },
    });

    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      socket!.openNow();
      await flushMicrotasks();

      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            null,
            createElement(LudensRpcProvider, {
              client: rpcClient,
              children: createElement(StorageSettings, {
                initialData: { config: currentConfig, usage: [] },
              }),
            }),
          ),
        );
        await flushMicrotasks();
      });

      const highBtn = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-storage-video-quality] [data-quality-preset="high"]',
      )!;
      assert.ok(highBtn);

      await act(async () => {
        highBtn.click();
      });
      assert.ok(
        dom.window.document.querySelector("[data-storage-local-sync-hint]"),
        "Should display pending local-default sync hint before saving",
      );

      const saveBtn = Array.from(dom.window.document.querySelectorAll("button")).find(
        btn => btn.textContent?.trim() === en.storageSettings.saveDefaults,
      )!;
      assert.ok(saveBtn);
      assert.equal(saveBtn.disabled, false);

      await act(async () => {
        saveBtn.click();
        await flushMicrotasks();
      });

      assert.equal(storageUpdates.length, 1);
      const savedPayload = storageUpdates[0] as import("../lib/storage").GlobalStorageUpdateInput;
      assert.equal(savedPayload.videoQuality, "high");
      assert.equal(savedPayload.profiles?.[0]?.id, BUILTIN_LOCAL_PROFILE_ID);
      assert.equal(savedPayload.profiles?.[0]?.maxBytes, 50 * GIB_BYTES);
    } finally {
      await act(async () => {
        root.unmount();
      });
      rpcClient.dispose();
    }
  });
});

test("Create Workspace omits storage override when matching global default and sends local preset override when customized", async () => {
  const rootDir = "/Users/demo/workspaces";
  const baseDraft = { ...emptyWorkspaceDraft, name: "acnh-run" };

  // Global default is "compact": leaving untouched or selecting "compact" omits storage override
  assert.deepEqual(
    workspaceCreateInput(rootDir, baseDraft, null, { globalVideoQuality: "compact" }),
    {
      ok: true,
      input: { name: "acnh-run", driver: "cua" },
    },
  );
  assert.deepEqual(
    workspaceCreateInput(
      rootDir,
      { ...baseDraft, videoQuality: "compact" },
      null,
      { globalVideoQuality: "compact" },
    ),
    {
      ok: true,
      input: { name: "acnh-run", driver: "cua" },
    },
  );

  // Choosing a non-default tier ("balanced" when global is "compact", or "compact" when global is "balanced") writes local override
  assert.deepEqual(
    workspaceCreateInput(
      rootDir,
      { ...baseDraft, videoQuality: "balanced" },
      null,
      { globalVideoQuality: "compact" },
    ),
    {
      ok: true,
      input: {
        name: "acnh-run",
        driver: "cua",
        storage: {
          mode: "local",
          videoQuality: "balanced",
          maxBytes: 20 * GIB_BYTES,
        },
      },
    },
  );
  assert.deepEqual(
    workspaceCreateInput(
      rootDir,
      { ...baseDraft, videoQuality: "compact" },
      null,
      { globalVideoQuality: "balanced" },
    ),
    {
      ok: true,
      input: {
        name: "acnh-run",
        driver: "cua",
        storage: {
          mode: "local",
          videoQuality: "compact",
          maxBytes: 5 * GIB_BYTES,
        },
      },
    },
  );

  // Interactive JSDOM check on WorkspaceCreateForm
  await withJsdom(async (dom, createRoot) => {
    const submitted: Array<{ input: unknown; launch: boolean }> = [];
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            null,
            createElement(WorkspaceCreateForm, {
              defaultRoot: rootDir,
              globalVideoQuality: "compact",
              pending: false,
              error: "",
              onSubmit(input, launch) {
                submitted.push({ input, launch });
              },
              onCancel() {},
            }),
          ),
        );
      });

      // Initially reflects global default "compact"
      const compactRadio = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-create-video-quality] [data-quality-preset="compact"]',
      )!;
      assert.equal(compactRadio.getAttribute("aria-checked"), "true");
      assert.ok(dom.window.document.querySelector("[data-create-quality-inherited]"));

      // Type workspace name and submit untouched -> no storage override
      const nameInput = dom.window.document.querySelector<HTMLInputElement>('input[name="name"]')!;
      await act(async () => {
        const tracker = (
          nameInput as unknown as { _valueTracker?: { setValue(val: string): void } }
        )._valueTracker;
        tracker?.setValue(nameInput.value);
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(nameInput, "mini-bot");
        nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });

      const createOnlyBtn = Array.from(dom.window.document.querySelectorAll("button")).find(
        b => b.textContent?.trim() === en.workspaceSetup.createOnly,
      )!;
      await act(async () => {
        createOnlyBtn.click();
      });
      assert.equal(submitted.length, 1);
      assert.equal("storage" in (submitted[0]!.input as Record<string, unknown>), false);

      // Now click "high" preset card and submit -> sends 50 GiB local override
      const highRadio = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-create-video-quality] [data-quality-preset="high"]',
      )!;
      await act(async () => {
        highRadio.click();
      });
      assert.ok(dom.window.document.querySelector("[data-create-quality-override]"));

      await act(async () => {
        createOnlyBtn.click();
      });
      assert.equal(submitted.length, 2);
      assert.deepEqual((submitted[1]!.input as { storage?: unknown }).storage, {
        mode: "local",
        videoQuality: "high",
        maxBytes: 50 * GIB_BYTES,
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

test("WorkspaceStudio preset cards update quality + quota in inherit/local mode, and update ONLY quality in remote profile mode", async () => {
  // 1. Pure state transition checks
  const inheritDraft = workspaceStorageToDraft(undefined, BUILTIN_LOCAL_PROFILE_ID);
  assert.equal(shouldShowStudioPresetQuota(inheritDraft), true);
  const clickedLocal = applyStudioQualityPreset(inheritDraft, "compact");
  assert.equal(clickedLocal.mode, "local");
  assert.equal(clickedLocal.videoQuality, "compact");
  assert.equal(clickedLocal.maxGib, "5");
  assert.deepEqual(draftToWorkspaceStorageOverride(clickedLocal).override, {
    mode: "local",
    videoQuality: "compact",
    maxBytes: 5 * GIB_BYTES,
  });

  const remoteProfileDraft = workspaceStorageToDraft(
    {
      mode: "profile",
      profileId: "cloudflare-r2",
      maxBytes: 120 * GIB_BYTES,
      videoQuality: "balanced",
    },
    BUILTIN_LOCAL_PROFILE_ID,
  );
  assert.equal(shouldShowStudioPresetQuota(remoteProfileDraft), false);
  const clickedRemote = applyStudioQualityPreset(remoteProfileDraft, "high");
  assert.equal(clickedRemote.mode, "profile");
  assert.equal(clickedRemote.profileId, "cloudflare-r2");
  assert.equal(clickedRemote.maxGib, "120");
  assert.equal(clickedRemote.videoQuality, "high");
  assert.deepEqual(draftToWorkspaceStorageOverride(clickedRemote).override, {
    mode: "profile",
    profileId: "cloudflare-r2",
    maxBytes: 120 * GIB_BYTES,
    videoQuality: "high",
  });

  // 2. Interactive JSDOM check on WorkspaceModelPanel for both inherit->local and remote profile modes
  await withJsdom(async (dom, createRoot) => {
    const studioPatches: Array<Record<string, unknown>> = [];
    let socket: FakeRpcSocket | null = null;
    const rpcClient = new LudensRpcClient({
      target: { kind: "remote", url: "http://127.0.0.1:43120" },
      createWebSocket: url => {
        socket = new FakeRpcSocket(url, (method, params) => {
          if (method === "initialize") {
            return {
              serverVersion: "0.2.0",
              protocolVersion: APP_RPC_PROTOCOL_VERSION,
              pid: 1,
              home: "/tmp/.ludens-dev",
              transport: "ws",
              authenticated: true,
              serverSeq: 1,
              activeCoreCount: 0,
              managedWorkspaces: [],
              runtimeProfile: "web-dev",
              capabilities: FULL_HOST_CAPABILITIES,
              media: { basePath: "/media", liveStreamCapabilities: ["none"] },
            };
          }
          if (method === "events/subscribe") {
            return { subscribedSeq: 1, events: [], replayTruncated: false };
          }
          if (method === "workspaces/mutate") {
            const p = params as { action: string; patch: Record<string, unknown> };
            studioPatches.push(p.patch);
            return makeStudio(p.patch.storage as import("../lib/storage").WorkspaceStorageOverride | undefined);
          }
          return { models: [], providers: [] };
        });
        return socket;
      },
    });

    function makeStudio(
      storage?: import("../lib/storage").WorkspaceStorageOverride,
    ): import("@ludens/protocol/workspaces").WorkspaceStudioSnapshot {
      return {
        id: "ws-studio",
        name: "Studio Workspace",
        workspace: "/tmp/ws-studio",
        config: {
          driver: "cua",
          model: "openai-codex/gpt-6.2-sol",
          pet: false,
          diagnostics: "normal",
          ...(storage ? { storage } : {}),
        },
        defaults: { model: "openai-codex/gpt-6.2-sol", pet: false },
        services: { hostSocket: "/tmp/ws-studio/.ludens/host.sock", hostSocketExists: false, jobs: [] },
        shiori: {
          model: "openai-codex/gpt-6.2-sol",
          currentSessionFile: null,
          sessions: [],
          memory: { exists: false, path: "/tmp/ws-studio/MEMORY.md", content: "", updatedAt: null },
        },
      };
    }

    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      socket!.openNow();
      await flushMicrotasks();

      // Part A: Inherited workspace -> click Space Saver ("compact") -> switches to local 5 GiB, then reset to inherit
      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            null,
            createElement(LudensRpcProvider, {
              client: rpcClient,
              children: createElement(WorkspaceModelPanel, {
                studio: makeStudio(undefined),
                isZh: false,
                storageConfig: makeStorageConfig(),
                onSaved() {},
                onOpenSimulator() {},
                onOpenConnection() {},
              }),
            }),
          ),
        );
      });

      assert.ok(dom.window.document.querySelector("[data-storage-quality-inherited]"));
      const compactCard = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-workspace-storage-quality] [data-quality-preset="compact"]',
      )!;
      await act(async () => {
        compactCard.click();
      });

      const modeSelect = dom.window.document.querySelector<HTMLSelectElement>(
        "[data-workspace-storage-mode]",
      )!;
      const maxGibInput = dom.window.document.querySelector<HTMLInputElement>(
        "[data-workspace-storage-max-gib]",
      )!;
      assert.equal(modeSelect.value, "local");
      assert.equal(maxGibInput.value, "5");

      const saveBtn = Array.from(dom.window.document.querySelectorAll("button")).find(
        b => b.textContent?.trim() === en.workspaceStudio.saveConfig,
      )!;
      await act(async () => {
        saveBtn.click();
        await flushMicrotasks();
      });
      assert.deepEqual(studioPatches.at(-1)?.storage, {
        mode: "local",
        videoQuality: "compact",
        maxBytes: 5 * GIB_BYTES,
      });

      // Reset to global default -> clears override back to null
      const resetBtn = dom.window.document.querySelector<HTMLButtonElement>(
        "[data-workspace-storage-reset-inherit]",
      )!;
      await act(async () => {
        resetBtn.click();
      });
      assert.equal(modeSelect.value, "inherit");
      assert.equal(maxGibInput.value, "");

      // Part B: Remote S3 profile mode -> clicking "compact" updates ONLY videoQuality, leaving profileId & 80 GiB untouched
      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            null,
            createElement(LudensRpcProvider, {
              client: rpcClient,
              children: createElement(WorkspaceModelPanel, {
                studio: makeStudio({
                  mode: "profile",
                  profileId: "cloudflare-r2",
                  maxBytes: 80 * GIB_BYTES,
                  videoQuality: "balanced",
                }),
                isZh: false,
                storageConfig: makeStorageConfig(),
                onSaved() {},
                onOpenSimulator() {},
                onOpenConnection() {},
              }),
            }),
          ),
        );
      });

      assert.ok(
        dom.window.document.querySelector("[data-quality-quota-muted-note]"),
        "Remote profile mode should mute local quota badge and display untouched-quota note",
      );

      const compactRemoteCard = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-workspace-storage-quality] [data-quality-preset="compact"]',
      )!;
      await act(async () => {
        compactRemoteCard.click();
      });

      const remoteSaveBtn = Array.from(dom.window.document.querySelectorAll("button")).find(
        b => b.textContent?.trim() === en.workspaceStudio.saveConfig,
      )!;
      await act(async () => {
        remoteSaveBtn.click();
        await flushMicrotasks();
      });

      assert.deepEqual(studioPatches.at(-1)?.storage, {
        mode: "profile",
        profileId: "cloudflare-r2",
        maxBytes: 80 * GIB_BYTES,
        videoQuality: "compact",
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      rpcClient.dispose();
    }
  });
});
