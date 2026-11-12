import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LocaleProvider } from "../lib/locale";
import {
  ModelPickerDialog,
  buildProviderTabs,
  filterAvailableModels,
  formatContextWindow,
  isModelSelectable,
  serviceTierForModel,
  shortModelLabel,
  stepHighlightedIndex,
  type AvailableModelItem,
  type AvailableModelsCatalog,
} from "../components/model-picker-dialog";
import {
  ShioriComposer,
  ShioriWorkbench,
  canSwitchShioriModel,
  resolveShioriActiveModel,
} from "../features/live/shiori-cockpit";
import type { ActivityFeedData } from "../features/live/use-activity-feed";
import type { RunData, SpanStats } from "../lib/types";
import type { WorkspaceStudioSnapshot } from "../lib/workspaces";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const CATALOG_MODELS: AvailableModelItem[] = [
  {
    fullId: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 32_000,
    authenticated: true,
    supportedServiceTiers: [],
  },
  {
    fullId: "openai-codex/gpt-6.1-sol",
    provider: "openai-codex",
    id: "gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    authenticated: true,
    supportedServiceTiers: ["priority", "ultrafast"],
  },
  {
    fullId: "openai-codex/gpt-5.4-mini",
    provider: "openai-codex",
    id: "gpt-5.4-mini",
    name: "GPT 5.4 Mini",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    authenticated: true,
    supportedServiceTiers: ["priority"],
  },
  {
    fullId: "google/gemini-3-pro",
    provider: "google",
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    authenticated: false,
    supportedServiceTiers: [],
  },
];

const SAMPLE_CATALOG: AvailableModelsCatalog = {
  models: CATALOG_MODELS,
  providers: [
    { id: "anthropic", count: 1, authenticated: true },
    { id: "openai-codex", count: 2, authenticated: true },
    { id: "google", count: 1, authenticated: false },
  ],
  currentModel: "openai-codex/gpt-6.1-sol",
};

function emptySpanStats(): SpanStats {
  return {
    started: 0,
    outcomes: { success: 0, error: 0, cancelled: 0, pending: 0, unknown: 0 },
    durationMs: { median: null, p95: null },
  };
}

function sampleRunData(overrides: Partial<RunData> = {}): RunData {
  const stats = emptySpanStats();
  return {
    project: "demo-ws",
    run: "20261111T120000Z-demo",
    manifest: {
      shiori: { implementation: "omp", implementationVersion: "1.0.0" },
      runId: "20261111T120000Z-demo",
      workspace: "/tmp/demo-ws",
      workspaceId: "demo-ws",
      socket: "/tmp/demo-ws/.ludens/host.sock",
      drivers: [{ id: "cua", version: "1.0.0" }],
      model: "openai-codex/gpt-5.4-mini",
      seconds: 1800,
      maxRequests: 500,
      compactionThreshold: 120_000,
    },
    cycles: [{ epoch: "epoch-1", startedAt: "2026-11-11T12:00:00.000Z", maxSeconds: 1800 }],
    selectedEpoch: "epoch-1",
    calls: [],
    paging: { totalCalls: 4, beforeCall: null, hasMore: false, firstIndex: 1, lastIndex: 4 },
    observations: [],
    perception: null,
    notices: [],
    skills: [],
    telemetry: {
      sources: [],
      spans: [],
      shiori: { stats, nativeLoops: [] },
      capabilities: { stats, python: stats, localPython: stats, discovery: stats },
      devices: stats,
      perception: stats,
    },
    lastControl: null,
    activeCompaction: null,
    live: {
      runId: "20261111T120000Z-demo",
      mode: "manual",
      epoch: "epoch-1",
      connected: true,
      reason: "paused",
      agent: true,
      thinking: false,
      maxSeconds: 1800,
      remainingSeconds: 1500,
    },
    livePhase: null,
    controlAllowed: true,
    controlReason: "",
    updatedAt: "2026-11-11T12:05:00.000Z",
    summary: {
      completed: 4,
      actions: 9,
      explicitObserves: 2,
      errors: 0,
      compactions: 0,
      medianMs: 1400,
      p95Ms: 2800,
      medianHeadersMs: null,
      medianHttpHeadersMs: null,
      medianWsWaitMs: null,
      cacheHit: 0.82,
      warmCacheHit: 0.91,
      elapsedSeconds: 300,
    },
    ...overrides,
  };
}

function sampleFeedData(): ActivityFeedData {
  return {
    resetRevision: 0,
    loadedRevision: 0,
    scope: { project: "demo-ws", runId: "20261111T120000Z-demo", epoch: null },
    generation: "gen-1",
    snapshot: 1,
    blocks: [],
    selected: undefined,
    selectionReady: true,
    before: null,
    hasMore: false,
    total: 0,
    historical: false,
    loading: false,
    loadingOlder: false,
    error: "",
    filter: "all",
    query: "",
    setFilter() {},
    setQuery() {},
    async earlier() {},
    latest() {},
  };
}

function collectLeafEntries(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out.set(path, v);
    } else if (v && typeof v === "object") {
      for (const [subK, subV] of collectLeafEntries(v, path)) {
        out.set(subK, subV);
      }
    }
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]!).sort();
}

test("en.json and zh.json maintain strict 1:1 key and placeholder parity with perception toggle keys removed", () => {
  const enMap = collectLeafEntries(en);
  const zhMap = collectLeafEntries(zh);

  assert.deepEqual([...zhMap.keys()].sort(), [...enMap.keys()].sort());

  for (const [key, enVal] of enMap) {
    const zhVal = zhMap.get(key)!;
    assert.deepEqual(
      placeholders(zhVal),
      placeholders(enVal),
      `placeholder mismatch on ${key}`,
    );
  }

  for (const removedKey of [
    "shioriCockpit.perceptionInjectHint",
    "shioriCockpit.injectOn",
    "shioriCockpit.injectOff",
  ]) {
    assert.equal(enMap.has(removedKey), false, `${removedKey} must be removed from en.json`);
    assert.equal(zhMap.has(removedKey), false, `${removedKey} must be removed from zh.json`);
  }
});

test("ModelPickerDialog helpers format context windows, filter catalog models, group providers, and step keyboard selection", () => {
  assert.equal(shortModelLabel("openai-codex/gpt-6.1-sol", "Device-only"), "gpt-6.1-sol");
  assert.equal(shortModelLabel("gpt-local", "Device-only"), "gpt-local");
  assert.equal(shortModelLabel("  ", "Device-only"), "Device-only");

  assert.equal(formatContextWindow(200_000), "200K");
  assert.equal(formatContextWindow(128_000), "128K");
  assert.equal(formatContextWindow(1_000_000), "1M");
  assert.equal(formatContextWindow(1_048_576), "1M");

  // Default excludes unauthenticated models
  const authOnly = filterAvailableModels(CATALOG_MODELS, { includeUnauthenticated: false });
  assert.deepEqual(
    authOnly.map(m => m.fullId),
    [
      "anthropic/claude-opus-4-6",
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-5.4-mini",
    ],
  );

  // Including unauthenticated surfaces google/gemini-3-pro
  const withUnauth = filterAvailableModels(CATALOG_MODELS, {
    includeUnauthenticated: true,
    query: "gemini pro",
  });
  assert.deepEqual(withUnauth.map(m => m.fullId), ["google/gemini-3-pro"]);

  // Multi-token search across provider + model name + provider tab filter
  const filteredCodex = filterAvailableModels(CATALOG_MODELS, {
    includeUnauthenticated: true,
    provider: "openai-codex",
    query: "codex sol",
  });
  assert.deepEqual(filteredCodex.map(m => m.fullId), ["openai-codex/gpt-6.1-sol"]);

  // Provider tabs sort authenticated providers before unauthenticated ones
  const tabs = buildProviderTabs(CATALOG_MODELS, { includeUnauthenticated: true });
  assert.deepEqual(tabs, [
    { id: "anthropic", count: 1, authenticated: true },
    { id: "openai-codex", count: 2, authenticated: true },
    { id: "google", count: 1, authenticated: false },
  ]);

  // Selectability and keyboard stepping skip unauthenticated entries when allowUnauthenticated=false
  assert.equal(isModelSelectable(CATALOG_MODELS[3]!, { allowUnauthenticated: false }), false);
  assert.equal(isModelSelectable(CATALOG_MODELS[3]!, { allowUnauthenticated: true }), true);
  assert.equal(isModelSelectable(CATALOG_MODELS[0]!, { disabled: true }), false);

  assert.equal(
    stepHighlightedIndex(2, CATALOG_MODELS, 1, { allowUnauthenticated: false }),
    0,
    "ArrowDown wraps past unauthenticated item at index 3 back to index 0",
  );
  assert.equal(
    stepHighlightedIndex(2, CATALOG_MODELS, 1, { allowUnauthenticated: true }),
    3,
    "ArrowDown visits index 3 when unauthenticated selection is enabled",
  );
  assert.equal(
    stepHighlightedIndex(0, CATALOG_MODELS, -1, { allowUnauthenticated: false }),
    2,
    "ArrowUp wraps to last selectable index",
  );
  assert.equal(stepHighlightedIndex(0, CATALOG_MODELS, 1, { disabled: true }), -1);

  assert.equal(serviceTierForModel(CATALOG_MODELS[1], "ultrafast"), "ultrafast");
  assert.equal(serviceTierForModel(CATALOG_MODELS[2], "ultrafast"), null, "Fast-only models drop Ultrafast");
  assert.equal(serviceTierForModel(CATALOG_MODELS[2], "priority"), "priority");
  assert.equal(serviceTierForModel(CATALOG_MODELS[0], "priority"), null, "Unsupported models use Standard");
});

test("ModelPickerDialog renders search input, provider tabs, capability badges, current badge, and lock banner", () => {
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ModelPickerDialog, {
        open: true,
        inline: true,
        onOpenChange() {},
        value: "openai-codex/gpt-6.1-sol",
        catalogOverride: SAMPLE_CATALOG,
        onSelect() {},
      }),
    ),
  );

  assert.match(html, /data-model-picker-dialog/);
  assert.match(html, /data-model-picker-search/);
  assert.match(html, /data-provider-tab="all"/);
  assert.match(html, /data-provider-tab="anthropic"/);
  assert.match(html, /data-provider-tab="openai-codex"/);
  assert.match(html, /data-model-option="openai-codex\/gpt-6\.1-sol"/);
  assert.match(html, /data-model-current-badge/);
  assert.match(html, /data-cap="vision"/);
  assert.match(html, /data-cap="reasoning"/);
  assert.match(html, />200K</);
  assert.match(html, />1M</);

  const lockedHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ModelPickerDialog, {
        open: true,
        inline: true,
        onOpenChange() {},
        value: "openai-codex/gpt-6.1-sol",
        disabled: true,
        disabledReason: "Pause auto loop before switching models",
        catalogOverride: SAMPLE_CATALOG,
        onSelect() {},
      }),
    ),
  );
  assert.match(lockedHtml, /data-model-picker-locked/);
  assert.match(lockedHtml, /Pause auto loop before switching models/);
});

test("ShioriComposer removes perception injection toggle and enforces paused-only model switching", () => {
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: true, mode: "manual", consolidating: false, thinking: false }),
    true,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: false, mode: "manual" }),
    true,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: false, hostOnline: false, mode: "manual" }),
    false,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: true, mode: "auto" }),
    false,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: true, mode: "acquiring" }),
    false,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: true, mode: "manual", consolidating: true }),
    false,
  );
  assert.equal(
    canSwitchShioriModel({ isLiveRun: true, hostOnline: true, mode: "manual", thinking: true }),
    false,
  );

  const pausedHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriComposer, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        data: sampleRunData(),
        isLiveRun: true,
        onUpdated() {},
      }),
    ),
  );

  assert.match(pausedHtml, /data-model-picker-trigger/);
  assert.doesNotMatch(pausedHtml, /data-locked="true"/);
  assert.match(pausedHtml, /gpt-5\.4-mini/);
  assert.doesNotMatch(pausedHtml, /感知注入/);
  assert.doesNotMatch(pausedHtml, /Inject:\s*(ON|OFF)/i);

  const autoRunningData = sampleRunData({
    live: {
      runId: "20261111T120000Z-demo",
      mode: "auto",
      epoch: "epoch-1",
      connected: true,
      reason: "running",
      agent: true,
      thinking: true,
      maxSeconds: 1800,
      remainingSeconds: 1200,
    },
  });
  const runningHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriComposer, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        data: autoRunningData,
        isLiveRun: true,
        onUpdated() {},
      }),
    ),
  );

  assert.match(runningHtml, /data-model-picker-trigger/);
  assert.match(runningHtml, /data-locked="true"/);
  assert.match(runningHtml, /Pause auto loop before switching models/);
  assert.doesNotMatch(runningHtml, /感知注入/);
  assert.doesNotMatch(runningHtml, /Inject:\s*(ON|OFF)/i);

  // Synthetic offline status from set_model keeps switching unlocked
  const offlineOverrideHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriComposer, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        data: sampleRunData({ live: null, controlAllowed: false }),
        hostStatusOverride: {
          mode: "manual",
          connected: false,
          hostOffline: true,
          model: "anthropic/claude-opus-4-6",
        },
        isLiveRun: true,
        onUpdated() {},
      }),
    ),
  );
  assert.doesNotMatch(offlineOverrideHtml, /data-locked="true"/);
  assert.match(offlineOverrideHtml, /claude-opus-4-6/);
});

test("ShioriWorkbench prefers live model in both Composer pill and Right Dock provenance and includes layout polish classes", () => {
  assert.equal(
    resolveShioriActiveModel({
      liveModel: "anthropic/claude-opus-4-6",
      manifestModel: "openai-codex/gpt-5.4-mini",
    }),
    "anthropic/claude-opus-4-6",
  );
  assert.equal(
    resolveShioriActiveModel({
      localModelOverride: "openai-codex/gpt-6.1-sol",
      liveModel: "anthropic/claude-opus-4-6",
      manifestModel: "openai-codex/gpt-5.4-mini",
    }),
    "openai-codex/gpt-6.1-sol",
  );

  const liveSwitchedData = sampleRunData({
    live: {
      runId: "20261111T120000Z-demo",
      mode: "manual",
      epoch: "epoch-1",
      connected: true,
      reason: "paused",
      agent: true,
      thinking: false,
      model: "anthropic/claude-opus-4-6",
    } as RunData["live"] & { model: string },
  });

  const workbenchHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ShioriWorkbench, {
        project: "demo-ws",
        workspace: "/tmp/demo-ws",
        workspaceTitle: "Demo Workspace",
        data: liveSwitchedData,
        feed: sampleFeedData(),
        isLiveRun: true,
        phaseLabel: "Executing command",
        phaseElapsedMs: 3000,
        onUpdated() {},
        onOpenPerf() {},
        onOpenCaps() {},
        onReturnLatest() {},
        observationSlot: createElement("div", null, "viewport"),
      }),
    ),
  );

  assert.match(workbenchHtml, /data-provenance-model[^>]*>anthropic\/claude-opus-4-6</);
  assert.match(workbenchHtml, /omp · claude-opus-4-6/);
  assert.match(workbenchHtml, /codex-cockpit-header/);
  assert.match(workbenchHtml, /codex-live-phase/);
  assert.match(workbenchHtml, /codex-expand-all-btn/);
  assert.match(workbenchHtml, /shiori-budget-header/);
  assert.match(workbenchHtml, /shiori-stat-card/);
  assert.match(workbenchHtml, /shiori-stat-label/);

  const css = readFileSync(
    join(import.meta.dirname, "../features/live/activity-feed.css"),
    "utf8",
  );
  assert.match(css, /\.shiori-stat-label\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.codex-expand-all-btn/);
});

test("Workspace Studio and Global Settings both reuse ModelPickerDialog via Browse Models triggers", async () => {
  const { ModelAndBudgetPanel } = await import("../features/workspaces/workspace-studio-view");
  const { GlobalDefaultsCard } = await import("../features/workspaces/settings-view");

  const studioSnapshot: WorkspaceStudioSnapshot = {
    id: "demo-ws",
    name: "Demo Workspace",
    workspace: "/tmp/demo-ws",
    config: {
      driver: "cua",
      model: "openai-codex/gpt-6.1-sol",
      seconds: 1800,
      requests: 1000,
      diagnostics: "normal",
      pet: false,
      dashboard: true,
    },
    defaults: {},
    services: {
      hostSocket: "/tmp/demo-ws/.ludens/host.sock",
      hostSocketExists: false,
      jobs: [],
    },
    shiori: {
      currentSessionFile: null,
      sessions: [],
      memory: {
        exists: false,
        path: "/tmp/demo-ws/MEMORY.md",
        content: "",
        updatedAt: null,
      },
    },
  };

  const studioHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ModelAndBudgetPanel, {
        studio: studioSnapshot,
        isZh: false,
        onSaved() {},
        onOpenSimulator() {},
        onOpenConnection() {},
      }),
    ),
  );
  assert.match(studioHtml, /data-browse-models="workspace-studio"/);
  assert.match(studioHtml, /Browse Models…/);

  const settingsHtml = renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(GlobalDefaultsCard)),
  );
  assert.match(settingsHtml, /data-browse-models="global-defaults"/);
  assert.match(settingsHtml, /Browse Models…/);
});
