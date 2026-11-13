import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../lib/locale";
import { ConsoleSidebar } from "../shell/console-sidebar";
import {
  DesktopQuickSwitcher,
  QUICK_SWITCHER_VIEW_IDS,
  filterQuickSwitcherItems,
  type QuickSwitcherItem,
} from "../shell/desktop-quick-switcher";
import { DesktopTitlebar } from "../shell/desktop-titlebar";
import {
  computeTitlebarLayout,
  createSpaHistory,
  detectBrowserPlatform,
  formatDesktopShortcut,
  parseDesktopPreviewDirective,
  parseDesktopPreviewParam,
  pushSpaHistory,
  reconcileSpaHistoryPop,
  replaceSpaHistory,
  resolveDesktopChromeState,
  stepSpaHistoryBack,
  stepSpaHistoryForward,
} from "../shell/use-desktop-window";

test("parseDesktopPreviewParam and parseDesktopPreviewDirective handle platform aliases and explicit exit", () => {
  assert.equal(parseDesktopPreviewParam("?desktopPreview=darwin"), "darwin");
  assert.equal(parseDesktopPreviewParam("?desktopPreview=macOS"), "darwin");
  assert.equal(parseDesktopPreviewParam("?desktopPreview=win32"), "win32");
  assert.equal(parseDesktopPreviewParam("?desktopPreview=Windows"), "win32");
  assert.equal(parseDesktopPreviewParam("?desktopPreview=linux"), "linux");
  assert.equal(parseDesktopPreviewParam("?desktopPreview=off"), null);
  assert.equal(parseDesktopPreviewDirective("?desktopPreview=off"), "off");
  assert.equal(parseDesktopPreviewDirective("?desktopPreview=0"), "off");
  assert.equal(parseDesktopPreviewDirective("?view=live"), null);
  assert.equal(parseDesktopPreviewDirective(""), null);
});

test("detectBrowserPlatform identifies darwin, win32, and linux hints", () => {
  assert.equal(detectBrowserPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32"), "win32");
  assert.equal(detectBrowserPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", "MacIntel"), "darwin");
  assert.equal(detectBrowserPlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64"), "linux");
});

test("resolveDesktopChromeState handles plain Web, Electron macOS/Win32 bridges, and cross-OS browser previews", () => {
  // 1. Plain Web browser
  const web = resolveDesktopChromeState({ fallbackWebPlatform: "darwin" });
  assert.equal(web.active, false);
  assert.equal(web.isPreview, false);
  assert.equal(web.titlebarHeight, 0);

  // 2. Native Electron macOS hiddenInset
  const macNative = resolveDesktopChromeState({
    bridgeInitialState: {
      platform: "darwin",
      captionStyle: "macos",
      titlebarHeight: 38,
    },
    bridgeState: {
      platform: "darwin",
      captionStyle: "macos",
      titlebarHeight: 38,
      maximized: false,
      fullScreen: true,
      focused: false,
      canGoBack: true,
      canGoForward: false,
    },
  });
  assert.equal(macNative.active, true);
  assert.equal(macNative.isPreview, false);
  assert.equal(macNative.hasNativeMacTrafficLights, true);
  assert.equal(macNative.captionStyle, "macos");
  assert.equal(macNative.fullScreen, true);
  assert.equal(macNative.focused, false);

  // 3. Native Electron Windows 11 WCO
  const winNative = resolveDesktopChromeState({
    bridgeInitialState: {
      platform: "win32",
      captionStyle: "win32-overlay",
      titlebarHeight: 38,
    },
  });
  assert.equal(winNative.active, true);
  assert.equal(winNative.isPreview, false);
  assert.equal(winNative.platform, "win32");
  assert.equal(winNative.captionStyle, "win32-overlay");

  // 4. Browser `?desktopPreview=win32` uses custom Fluent caption controls so Win11 UIUX is inspectable anywhere
  const winPreviewInBrowser = resolveDesktopChromeState({
    previewPlatform: "win32",
    previewMaximized: true,
  });
  assert.equal(winPreviewInBrowser.active, true);
  assert.equal(winPreviewInBrowser.isPreview, true);
  assert.equal(winPreviewInBrowser.platform, "win32");
  assert.equal(winPreviewInBrowser.captionStyle, "custom");
  assert.equal(winPreviewInBrowser.maximized, true);

  // 5. Real Windows Electron WCO keeps `win32-overlay` even if `?desktopPreview=win32` is present
  const winPreviewInRealWco = resolveDesktopChromeState({
    bridgeInitialState: {
      platform: "win32",
      captionStyle: "win32-overlay",
      titlebarHeight: 38,
    },
    previewPlatform: "win32",
  });
  assert.equal(winPreviewInRealWco.captionStyle, "win32-overlay");
});

test("computeTitlebarLayout calculates macOS traffic-light fullscreen collapse and Windows caption modes", () => {
  const macWindowed = computeTitlebarLayout({
    active: true,
    platform: "darwin",
    captionStyle: "macos",
    fullScreen: false,
  });
  assert.equal(macWindowed.topbarHeightPx, 38);
  assert.equal(macWindowed.leftInsetPx, 74);
  assert.equal(macWindowed.showTrafficLightZone, true);
  assert.equal(macWindowed.showLeadingBrandMark, false);
  assert.equal(formatDesktopShortcut("darwin", "K"), "⌘K");

  const macFullScreen = computeTitlebarLayout({
    active: true,
    platform: "darwin",
    captionStyle: "macos",
    fullScreen: true,
  });
  assert.equal(macFullScreen.leftInsetPx, 10);
  assert.equal(macFullScreen.showTrafficLightZone, false);

  const winOverlay = computeTitlebarLayout({
    active: true,
    platform: "win32",
    captionStyle: "win32-overlay",
    fullScreen: false,
  });
  assert.equal(winOverlay.leftInsetPx, 12);
  assert.equal(winOverlay.showLeadingBrandMark, true);
  assert.equal(winOverlay.reserveWin32Overlay, true);
  assert.equal(winOverlay.showCustomWindowControls, false);
  assert.equal(formatDesktopShortcut("win32", "K"), "Ctrl+K");

  const winCustom = computeTitlebarLayout({
    active: true,
    platform: "win32",
    captionStyle: "custom",
    fullScreen: false,
  });
  assert.equal(winCustom.showCustomWindowControls, true);
  assert.equal(winCustom.reserveWin32Overlay, false);
});

test("SPA navigation history stack tracks push, replace, back/forward, and repeated URL disambiguation", () => {
  let stack = createSpaHistory("/?view=live&project=ws-a");
  assert.deepEqual(stack, { entries: ["/?view=live&project=ws-a"], index: 0 });
  assert.equal(stepSpaHistoryBack(stack).target, null);
  assert.equal(stepSpaHistoryForward(stack).target, null);

  // Duplicate push is idempotent
  stack = pushSpaHistory(stack, "/?view=live&project=ws-a");
  assert.equal(stack.entries.length, 1);

  // Push Replay -> Perf
  stack = pushSpaHistory(stack, "/?view=replay&project=ws-a");
  stack = pushSpaHistory(stack, "/?view=perf&project=ws-a");
  assert.equal(stack.index, 2);

  // Replace in Replay/Perf keeps forward/back bounds intact
  stack = stepSpaHistoryBack(stack).stack;
  assert.equal(stack.index, 1);
  stack = replaceSpaHistory(stack, "/?view=replay&project=ws-a&at=4200");
  assert.equal(stack.index, 1);
  assert.equal(stack.entries.length, 3);
  assert.equal(
    stepSpaHistoryForward(stack).target,
    "/?view=perf&project=ws-a",
  );

  // Pushing from middle truncates forward branch
  stack = pushSpaHistory(stack, "/?view=live&project=ws-a");
  assert.deepEqual(stack.entries, [
    "/?view=live&project=ws-a",
    "/?view=replay&project=ws-a&at=4200",
    "/?view=live&project=ws-a",
  ]);
  assert.equal(stack.index, 2);

  // Reconcile repeated URL A -> B -> A using stamped history stateIndex
  const backOne = reconcileSpaHistoryPop(stack, "/?view=replay&project=ws-a&at=4200", {
    stateIndex: 1,
  });
  assert.equal(backOne.index, 1);
  const forwardToRepeatedA = reconcileSpaHistoryPop(
    backOne,
    "/?view=live&project=ws-a",
    { stateIndex: 2 },
  );
  assert.equal(forwardToRepeatedA.index, 2);
  const backToInitialA = reconcileSpaHistoryPop(
    backOne,
    "/?view=live&project=ws-a",
    { stateIndex: 0 },
  );
  assert.equal(backToInitialA.index, 0);
});

test("DesktopTitlebar renders Antigravity macOS layout, Windows 11 custom Fluent caption buttons, and WCO spacer", () => {
  const noop = () => {};
  const baseProps = {
    active: true,
    maximized: false,
    fullScreen: false,
    focused: true,
    isPreview: true,
    sidebarCollapsed: false,
    workspaceTitle: "switch2-diablo3",
    viewTitle: "Live",
    canGoBack: true,
    canGoForward: false,
    companionAvailable: true,
    companionVisible: true,
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
    onSelectPreviewPlatform: noop,
  };

  assert.equal(
    renderToStaticMarkup(
      createElement(DesktopTitlebar, {
        ...baseProps,
        active: false,
        platform: "darwin",
        captionStyle: "macos",
      }),
    ),
    "",
  );

  const macHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DesktopTitlebar, {
        ...baseProps,
        platform: "darwin",
        captionStyle: "macos",
      }),
    ),
  );
  assert.match(macHtml, /padding-left:74px/);
  assert.match(macHtml, /data-preview-traffic-lights/);
  assert.match(macHtml, /switch2-diablo3/);
  assert.match(macHtml, /data-action="toggle-companion"/);
  assert.match(macHtml, /data-preview-switcher/);
  assert.match(macHtml, /⌘K/);
  assert.doesNotMatch(macHtml, /data-win-controls/);
  assert.doesNotMatch(macHtml, /data-titlebar-brand/);

  const macFsNativeHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DesktopTitlebar, {
        ...baseProps,
        platform: "darwin",
        captionStyle: "macos",
        isPreview: false,
        hasNativeMacTrafficLights: true,
        fullScreen: true,
      }),
    ),
  );
  assert.match(macFsNativeHtml, /padding-left:10px/);
  assert.doesNotMatch(macFsNativeHtml, /data-preview-traffic-lights/);

  const winCustomHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DesktopTitlebar, {
        ...baseProps,
        platform: "win32",
        captionStyle: "custom",
        maximized: true,
      }),
    ),
  );
  assert.match(winCustomHtml, /padding-left:12px/);
  assert.match(winCustomHtml, /data-titlebar-brand/);
  assert.match(winCustomHtml, /data-win-control="minimize"/);
  assert.match(winCustomHtml, /data-win-control="maximize"/);
  assert.match(winCustomHtml, /Restore window/);
  assert.match(winCustomHtml, /data-win-control="close"/);
  assert.match(winCustomHtml, /Ctrl\+K/);

  const winOverlayHtml = renderToStaticMarkup(
    createElement(DesktopTitlebar, {
      ...baseProps,
      platform: "win32",
      captionStyle: "win32-overlay",
      isPreview: false,
    }),
  );
  assert.match(winOverlayHtml, /data-win32-overlay-spacer/);
  assert.doesNotMatch(winOverlayHtml, /data-win-controls/);
});

test("DesktopQuickSwitcher renders grouped workspaces, views, and window actions and filters by query tokens", () => {
  const sampleItems: QuickSwitcherItem[] = [
    {
      id: "workspace:diablo",
      group: "workspaces",
      title: "switch2-diablo3",
      subtitle: "/tmp/switch2-diablo3",
      keywords: "workspace live",
      icon: "workspace",
      onSelect() {},
    },
    {
      id: "view:replay",
      group: "views",
      title: "Replay",
      subtitle: "Align perception frames",
      keywords: "timeline video",
      icon: "view",
      onSelect() {},
    },
  ];
  assert.equal(filterQuickSwitcherItems(sampleItems, "diablo live").length, 1);
  assert.equal(filterQuickSwitcherItems(sampleItems, "timeline").length, 1);
  assert.equal(filterQuickSwitcherItems(sampleItems, "nonexistent").length, 0);

  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(DesktopQuickSwitcher, {
      open: true,
      onOpenChange: noop,
      platform: "darwin",
      projects: [
        {
          id: "ws-1",
          name: "switch2-diablo3",
          workspace: "/tmp/switch2-diablo3",
          available: true,
          runs: [],
        },
      ],
      currentProject: "ws-1",
      currentView: "live",
      viewLink: (id) => `?view=${id}`,
      onNavigate: noop,
      onSelectWorkspace: noop,
      sidebarCollapsed: false,
      onToggleSidebar: noop,
      canGoBack: true,
      canGoForward: false,
      onGoBack: noop,
      onGoForward: noop,
      onReload: noop,
      companionAvailable: true,
      companionVisible: true,
      onToggleCompanion: noop,
    }),
    ),
  );
  assert.equal(QUICK_SWITCHER_VIEW_IDS.length, 9);
  assert.match(html, /role="dialog"/);
  assert.match(html, /data-qs-group="workspaces"/);
  assert.match(html, /data-qs-group="views"/);
  assert.match(html, /data-qs-group="actions"/);
  assert.match(html, /switch2-diablo3/);
});

test("ConsoleSidebar renders Web collapse control when desktopChrome is false and hides it when desktopChrome is true", () => {
  const webHtml = renderToStaticMarkup(
    createElement(ConsoleSidebar, {
      view: "live",
      viewLink: (id) => `?view=${id}`,
      onNavigate() {},
      onToggleCollapse() {},
      collapseShortcut: "⌘B",
    }),
  );
  assert.match(webHtml, /sidebar-collapse-toggle/);

  const desktopHtml = renderToStaticMarkup(
    createElement(ConsoleSidebar, {
      view: "live",
      viewLink: (id) => `?view=${id}`,
      onNavigate() {},
      onToggleCollapse() {},
      desktopChrome: true,
      collapsed: true,
    }),
  );
  assert.doesNotMatch(desktopHtml, /sidebar-collapse-toggle/);
  assert.match(desktopHtml, /data-desktop-chrome="true"/);
  assert.match(desktopHtml, /data-collapsed="true"/);
});

test("Viewport 100dvh budgets subtract --shell-topbar-height across shell, live, replay, perf, and docs", () => {
  const globalsCss = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const liveCss = readFileSync(
    new URL("../features/live/activity-feed.css", import.meta.url),
    "utf8",
  );
  const replayCss = readFileSync(
    new URL("../features/replay/timeline-player.css", import.meta.url),
    "utf8",
  );
  const runAnalysisTsx = readFileSync(
    new URL("../features/live/run-analysis.tsx", import.meta.url),
    "utf8",
  );

  assert.match(globalsCss, /--shell-topbar-height:\s*0px/);
  assert.match(
    globalsCss,
    /\.sidebar\s*\{[\s\S]*?height:\s*calc\(100dvh\s*-\s*var\(--shell-topbar-height,\s*0px\)\)/,
  );
  assert.match(
    liveCss,
    /\.codex-workbench\s*\{[\s\S]*?height:\s*calc\(100dvh\s*-\s*var\(--shell-topbar-height,\s*0px\)\)/,
  );
  assert.match(
    replayCss,
    /\.replay-studio\s*\{[\s\S]*?height:\s*calc\(100dvh\s*-\s*var\(--shell-topbar-height,\s*0px\)\)/,
  );
  assert.match(
    runAnalysisTsx,
    /min-\[1080px\]:h-\[calc\(100dvh-100px-var\(--shell-topbar-height,0px\)\)\]/,
  );
});
