import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PoolEvent } from "@ludens/protocol/event-pool";
import { LocaleProvider } from "../lib/locale";
import { DesktopTitlebar } from "../shell/desktop-titlebar";
import {
  ImmersiveFloatingPod,
  resolveNearestPodAnchor,
  selectMiniStreamSegments,
} from "../features/live/immersive-floating-pod";
import type { StreamSegment } from "../features/live/shiori-segments";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

test("Immersive Mode 2.0 CSS enforces full-bleed browser stage, CUA contain stage, no green auto border, and <1440px/<1100px media guards", () => {
  const viewportCss = readFileSync(
    join(import.meta.dirname, "../features/live/device-viewport.css"),
    "utf8",
  );
  const activityCss = readFileSync(
    join(import.meta.dirname, "../features/live/activity-feed.css"),
    "utf8",
  );
  const desktopChromeCss = readFileSync(
    join(import.meta.dirname, "../shell/desktop-chrome.css"),
    "utf8",
  );

  // Browser immersive stage is 100% edge-to-edge full-bleed with zero padding/radius
  assert.match(
    viewportCss,
    /\.device-viewport\[data-immersive="true"\]\s+\.device-viewport-stage\s*\{[^}]*padding:\s*0;/,
  );
  assert.match(
    viewportCss,
    /\.device-viewport\[data-immersive="true"\]\[data-stage-kind="browser"\]\s+\.device-viewport-slot\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-height:\s*none;[^}]*aspect-ratio:\s*auto\s*!important;[^}]*border-radius:\s*0;/,
  );
  assert.match(
    viewportCss,
    /\.device-viewport\[data-immersive="true"\]\[data-stage-kind="computer"\]\s+\.device-viewport-canvas\s*\{[^}]*object-fit:\s*contain;/,
  );
  assert.match(
    viewportCss,
    /\.device-viewport\[data-immersive="true"\]\[data-stage-kind="browser"\]\s+\.device-viewport-chrome\s*\{[^}]*height:\s*40px;/,
  );
  assert.doesNotMatch(viewportCss, /\.device-viewport\[data-control-mode="auto"\]/);
  assert.doesNotMatch(viewportCss, /\.device-viewport-auto-pill\b/);

  // <1440px and <1100px split-dock rules are guarded with :not([data-immersive="true"])
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1439px\)[\s\S]*?\.codex-workbench\[data-dock-open\]:not\(\[data-immersive="true"\]\)/,
  );
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1439px\)[\s\S]*?\.codex-right-dock:not\(\[data-immersive="true"\]\)/,
  );
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1099px\)[\s\S]*?\.codex-right-dock:not\(\[data-immersive="true"\]\)/,
  );

  // DesktopTitlebar center slot keeps no-drag on pill while .desktop-titlebar-main stays drag
  assert.match(
    desktopChromeCss,
    /\.desktop-titlebar-center-slot\s*\{[^}]*max-width:\s*520px;[^}]*height:\s*27px;[^}]*-webkit-app-region:\s*no-drag;/,
  );
});

test("DesktopTitlebar merges leadingExtraSlot, centerSlot, and trailingExtraSlot cleanly in 38px immersive mode", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DesktopTitlebar, {
        active: true,
        platform: "darwin",
        captionStyle: "macos",
        maximized: false,
        fullScreen: false,
        focused: true,
        isPreview: false,
        hasNativeMacTrafficLights: true,
        sidebarCollapsed: true,
        workspaceTitle: "webgl-arena",
        viewTitle: "Live",
        canGoBack: true,
        canGoForward: true,
        companionAvailable: true,
        companionVisible: true,
        leadingExtraSlot: createElement("div", { "data-test-browser-nav": "" }, "nav"),
        centerSlot: createElement("div", { "data-test-omnibox": "" }, "omnibox"),
        trailingExtraSlot: createElement("div", { "data-test-reclaim-exit": "" }, "exit"),
        onToggleSidebar: noop,
        onGoBack: noop,
        onGoForward: noop,
        onOpenQuickSwitcher: noop,
        onReload: noop,
        onToggleCompanion: noop,
        onMinimize: noop,
        onToggleMaximize: noop,
        onClose: noop,
        onTitlebarDoubleClick: noop,
      }),
    ),
  );

  assert.match(html, /data-immersive-chrome="true"/);
  assert.match(html, /data-action="toggle-sidebar"/);
  assert.match(html, /data-test-browser-nav=""/);
  assert.match(html, /class="desktop-titlebar-center-slot"[^>]*data-no-drag=""/);
  assert.match(html, /data-test-omnibox=""/);
  assert.match(html, /data-test-reclaim-exit=""/);
  assert.match(html, /data-action="toggle-companion"/);
  // App SPA breadcrumb, back/forward, search, and app reload are hidden while viewport chrome is merged
  assert.doesNotMatch(html, /data-titlebar-breadcrumb=""/);
  assert.doesNotMatch(html, /data-action="navigate-back"/);
  assert.doesNotMatch(html, /data-action="navigate-forward"/);
  assert.doesNotMatch(html, /data-action="quick-switcher"/);
  assert.doesNotMatch(html, /data-action="reload"/);
});

test("ImmersiveFloatingPod renders compact, pill, and stream tiers, SOS actions, and snaps across all 5 anchors", () => {
  // 5-anchor snap math
  assert.equal(
    resolveNearestPodAnchor({
      centerX: 1180,
      centerY: 740,
      containerWidth: 1400,
      containerHeight: 820,
      podWidth: 380,
      podHeight: 104,
    }),
    "bottom-right",
  );
  assert.equal(
    resolveNearestPodAnchor({
      centerX: 700,
      centerY: 750,
      containerWidth: 1400,
      containerHeight: 820,
      podWidth: 380,
      podHeight: 104,
    }),
    "bottom-center",
  );
  assert.equal(
    resolveNearestPodAnchor({
      centerX: 210,
      centerY: 750,
      containerWidth: 1400,
      containerHeight: 820,
      podWidth: 380,
      podHeight: 104,
    }),
    "bottom-left",
  );
  assert.equal(
    resolveNearestPodAnchor({
      centerX: 1190,
      centerY: 80,
      containerWidth: 1400,
      containerHeight: 820,
      podWidth: 380,
      podHeight: 104,
    }),
    "top-right",
  );
  assert.equal(
    resolveNearestPodAnchor({
      centerX: 200,
      centerY: 70,
      containerWidth: 1400,
      containerHeight: 820,
      podWidth: 380,
      podHeight: 104,
    }),
    "top-left",
  );

  const sosEvent: PoolEvent = {
    id: "sos-1",
    seq: 7,
    direction: "outbound",
    kind: "help_request",
    status: "pending",
    title: "CAPTCHA gate",
    text: "Please complete login verification",
    pauseRequested: true,
    createdAt: "2026-11-25T12:00:00.000Z",
  };

  const sampleSegments: StreamSegment[] = [
    {
      kind: "user",
      id: "seg-user-1",
      mode: "start",
      text: "Clear wave 3 in the WebGL arena",
      block: {
        id: "b-user-1",
        kind: "text",
        title: "User",
        text: "Clear wave 3 in the WebGL arena",
        at: "2026-11-25T11:59:00.000Z",
        status: "complete",
        createdRevision: 1,
        revision: 1,
      },
    },
    {
      kind: "turn",
      id: "seg-turn-1",
      steps: [
        {
          id: "step-1",
          kind: "tool",
          title: "input.play",
          text: "",
          tool: { intent: "Strafe right and fire" },
          at: "2026-11-25T11:59:10.000Z",
          status: "complete",
          createdRevision: 1,
          revision: 1,
        },
      ],
      responseBlock: null,
      responseText: "Cleared two drones and advancing toward the portal.",
    },
    {
      kind: "outbound_event",
      id: "seg-sos-1",
      event: sosEvent,
      block: {
        id: "b-sos-1",
        kind: "text",
        title: "Help",
        text: sosEvent.text,
        at: sosEvent.createdAt,
        status: "complete",
        createdRevision: 1,
        revision: 1,
      },
    },
  ];

  assert.equal(selectMiniStreamSegments(sampleSegments, 12).length, 3);

  const baseProps = {
    previewText: "Cleared two drones and advancing toward the portal.",
    statusTone: "auto" as const,
    segments: sampleSegments,
    pendingPoolCount: 1,
    pendingOutboundCount: 1,
    isLiveRun: true,
    hostOnline: true,
    thinking: false,
    consolidating: false,
    canResumeAuto: true,
    onOpenPoolOverview() {},
    onReplyPoolEvent() {},
    onDismissPoolEvent() {},
  };

  // Tier 2 (Default): "compact"
  const compactHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(
        ImmersiveFloatingPod,
        baseProps,
        createElement("div", { "data-test-composer": "" }, "composer"),
      ),
    ),
  );
  assert.match(compactHtml, /data-viewport-floating-overlay=""/);
  assert.match(compactHtml, /data-immersive-pod=""/);
  assert.match(compactHtml, /data-pod-tier="compact"/);
  assert.match(compactHtml, /data-pod-anchor="bottom-right"/);
  assert.match(compactHtml, /data-immersive-pod-drag-handle=""/);
  assert.match(compactHtml, /data-immersive-pod-stream-toggle=""/);
  assert.match(compactHtml, /data-immersive-composer-collapse=""/);
  assert.match(compactHtml, /data-test-composer=""/);
  assert.doesNotMatch(compactHtml, /data-immersive-pod-stream=""/);

  // Tier 1: "pill"
  const pillHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(
        ImmersiveFloatingPod,
        { ...baseProps, initialTier: "pill", initialAnchor: "top-left" },
        createElement("div", { "data-test-composer": "" }, "composer"),
      ),
    ),
  );
  assert.match(pillHtml, /data-pod-tier="pill"/);
  assert.match(pillHtml, /data-pod-anchor="top-left"/);
  assert.match(pillHtml, /data-immersive-composer-expand=""/);
  assert.match(pillHtml, /🆘 1/);
  assert.match(pillHtml, /class="immersive-pod-composer" hidden=""/);

  // Tier 3: "stream"
  const streamHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(
        ImmersiveFloatingPod,
        { ...baseProps, initialTier: "stream", initialAnchor: "bottom-center" },
        createElement("div", { "data-test-composer": "" }, "composer"),
      ),
    ),
  );
  assert.match(streamHtml, /data-pod-tier="stream"/);
  assert.match(streamHtml, /data-pod-anchor="bottom-center"/);
  assert.match(streamHtml, /data-immersive-pod-stream=""/);
  assert.match(streamHtml, /Clear wave 3 in the WebGL arena/);
  assert.match(streamHtml, /Strafe right and fire/);
  assert.match(streamHtml, /Cleared two drones and advancing toward the portal\./);
  assert.match(streamHtml, /CAPTCHA gate/);
  assert.match(streamHtml, /Reply &amp; Resume/);
});
