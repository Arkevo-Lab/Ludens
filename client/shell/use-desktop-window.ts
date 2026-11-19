"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  DesktopCaptionStyle,
  DesktopPlatform,
  DesktopWindowCommand,
  DesktopWindowInitialState,
  DesktopWindowState,
} from "@/lib/desktop";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "ludens:sidebar-collapsed";
export const DEFAULT_DESKTOP_TITLEBAR_HEIGHT = 38;
const MAX_SPA_HISTORY_ENTRIES = 200;
const COMMAND_DEDUPE_MS = 45;

export type DesktopPreviewDirective = DesktopPlatform | "off" | null;

/**
 * Parse `?desktopPreview=...` from a URL search string.
 * Supports `"darwin"` (`mac` / `macos`), `"win32"` (`win` / `windows`), `"linux"`,
 * and `"off"` (`0` / `false` / `none`) to explicitly exit a latched preview.
 */
export function parseDesktopPreviewDirective(
  search: string | null | undefined,
): DesktopPreviewDirective {
  if (!search) return null;
  const raw = new URLSearchParams(search)
    .get("desktopPreview")
    ?.trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === "darwin" || raw === "macos" || raw === "mac") return "darwin";
  if (raw === "win32" || raw === "windows" || raw === "win") return "win32";
  if (raw === "linux") return "linux";
  if (raw === "off" || raw === "0" || raw === "false" || raw === "none") {
    return "off";
  }
  return null;
}

/** Convenience helper returning only active preview platforms (`"darwin" | "win32" | "linux" | null`). */
export function parseDesktopPreviewParam(
  search: string | null | undefined,
): DesktopPlatform | null {
  const directive = parseDesktopPreviewDirective(search);
  return directive === "off" ? null : directive;
}

export function detectBrowserPlatform(
  userAgent = "",
  platformHint = "",
): DesktopPlatform {
  const combined = `${platformHint} ${userAgent}`.toLowerCase();
  if (combined.includes("win")) return "win32";
  if (combined.includes("mac") || combined.includes("darwin")) return "darwin";
  if (combined.includes("linux")) return "linux";
  return "darwin";
}

export interface ResolvedDesktopChromeState {
  active: boolean;
  isPreview: boolean;
  hasNativeMacTrafficLights: boolean;
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  titlebarHeight: number;
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

/**
 * Pure resolution of effective desktop chrome state across:
 * 1. Real Electron `window.ludens.window` (macOS hiddenInset, Windows WCO, Linux custom)
 * 2. Visual preview `?desktopPreview=darwin` / `?desktopPreview=win32`
 * 3. Plain Web browser (`active: false`, `titlebarHeight: 0`)
 */
export function resolveDesktopChromeState(input: {
  bridgeInitialState?: DesktopWindowInitialState | null;
  bridgeState?: DesktopWindowState | null;
  previewPlatform?: DesktopPlatform | null;
  previewMaximized?: boolean;
  previewFullScreen?: boolean;
  windowFocused?: boolean;
  fallbackWebPlatform?: DesktopPlatform;
}): ResolvedDesktopChromeState {
  const {
    bridgeInitialState = null,
    bridgeState = null,
    previewPlatform = null,
    previewMaximized = false,
    previewFullScreen = false,
    windowFocused = true,
    fallbackWebPlatform = "darwin",
  } = input;

  const isRealWin32Overlay =
    bridgeInitialState?.platform === "win32" &&
    (bridgeState?.captionStyle ?? bridgeInitialState.captionStyle) ===
      "win32-overlay";
  const isRealMacChrome =
    bridgeInitialState?.platform === "darwin" &&
    (bridgeState?.captionStyle ?? bridgeInitialState.captionStyle) === "macos";

  if (previewPlatform) {
    const sameAsNative = bridgeInitialState?.platform === previewPlatform;
    const captionStyle: DesktopCaptionStyle =
      previewPlatform === "darwin"
        ? "macos"
        : previewPlatform === "win32"
          ? isRealWin32Overlay
            ? "win32-overlay"
            : "custom"
          : "custom";
    return {
      active: true,
      isPreview: true,
      hasNativeMacTrafficLights: previewPlatform === "darwin" && isRealMacChrome,
      platform: previewPlatform,
      captionStyle,
      titlebarHeight:
        sameAsNative && bridgeInitialState?.titlebarHeight
          ? bridgeInitialState.titlebarHeight
          : DEFAULT_DESKTOP_TITLEBAR_HEIGHT,
      maximized: sameAsNative
        ? Boolean(bridgeState?.maximized ?? previewMaximized)
        : Boolean(previewMaximized),
      fullScreen: sameAsNative
        ? Boolean(bridgeState?.fullScreen ?? previewFullScreen)
        : Boolean(previewFullScreen),
      focused: bridgeState ? bridgeState.focused : windowFocused,
    };
  }

  if (bridgeInitialState) {
    const platform = bridgeState?.platform ?? bridgeInitialState.platform;
    const captionStyle =
      bridgeState?.captionStyle ?? bridgeInitialState.captionStyle;
    const titlebarHeight =
      bridgeState?.titlebarHeight ??
      bridgeInitialState.titlebarHeight ??
      DEFAULT_DESKTOP_TITLEBAR_HEIGHT;
    return {
      active: true,
      isPreview: false,
      hasNativeMacTrafficLights:
        platform === "darwin" && captionStyle === "macos",
      platform,
      captionStyle,
      titlebarHeight,
      maximized: Boolean(bridgeState?.maximized),
      fullScreen: Boolean(bridgeState?.fullScreen),
      focused: bridgeState ? bridgeState.focused : windowFocused,
    };
  }

  return {
    active: false,
    isPreview: false,
    hasNativeMacTrafficLights: false,
    platform: fallbackWebPlatform,
    captionStyle: "custom",
    titlebarHeight: 0,
    maximized: false,
    fullScreen: false,
    focused: windowFocused,
  };
}

export interface DesktopTitlebarLayout {
  topbarHeightPx: number;
  leftInsetPx: number;
  showTrafficLightZone: boolean;
  showLeadingBrandMark: boolean;
  showCustomWindowControls: boolean;
  reserveWin32Overlay: boolean;
  shortcutPrefix: string;
}

/** Pure platform geometry & shortcut formatting helper for `DesktopTitlebar`. */
export function computeTitlebarLayout(input: {
  active: boolean;
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  fullScreen: boolean;
  titlebarHeight?: number;
}): DesktopTitlebarLayout {
  const height = input.active
    ? (input.titlebarHeight ?? DEFAULT_DESKTOP_TITLEBAR_HEIGHT)
    : 0;
  const isMac = input.platform === "darwin";
  return {
    topbarHeightPx: height,
    leftInsetPx: isMac ? (input.fullScreen ? 10 : 74) : 12,
    showTrafficLightZone: isMac && !input.fullScreen,
    showLeadingBrandMark: !isMac,
    showCustomWindowControls:
      input.active && input.captionStyle === "custom" && !isMac,
    reserveWin32Overlay:
      input.active && input.captionStyle === "win32-overlay",
    shortcutPrefix: isMac ? "⌘" : "Ctrl+",
  };
}

/** Format a primary command shortcut such as `⌘B` on macOS or `Ctrl+B` on Windows/Linux. */
export function formatDesktopShortcut(
  platform: DesktopPlatform,
  key: string,
): string {
  return platform === "darwin" ? `⌘${key}` : `Ctrl+${key}`;
}

/* ── Pure SPA Navigation History State Machine ── */

export interface SpaHistoryStack {
  entries: string[];
  index: number;
}

export function createSpaHistory(initialHref: string): SpaHistoryStack {
  return { entries: [initialHref || "/"], index: 0 };
}

export function pushSpaHistory(
  stack: SpaHistoryStack,
  href: string,
): SpaHistoryStack {
  const normalized = href || "/";
  if (stack.entries[stack.index] === normalized) return stack;
  const nextEntries = [...stack.entries.slice(0, stack.index + 1), normalized];
  if (nextEntries.length > MAX_SPA_HISTORY_ENTRIES) {
    const overflow = nextEntries.length - MAX_SPA_HISTORY_ENTRIES;
    return {
      entries: nextEntries.slice(overflow),
      index: MAX_SPA_HISTORY_ENTRIES - 1,
    };
  }
  return {
    entries: nextEntries,
    index: nextEntries.length - 1,
  };
}

export function replaceSpaHistory(
  stack: SpaHistoryStack,
  href: string,
): SpaHistoryStack {
  const normalized = href || "/";
  if (stack.entries[stack.index] === normalized) return stack;
  const nextEntries = stack.entries.slice();
  nextEntries[stack.index] = normalized;
  return {
    entries: nextEntries,
    index: stack.index,
  };
}

export function stepSpaHistoryBack(stack: SpaHistoryStack): {
  stack: SpaHistoryStack;
  target: string | null;
} {
  if (stack.index <= 0) return { stack, target: null };
  const nextIndex = stack.index - 1;
  return {
    stack: { entries: stack.entries, index: nextIndex },
    target: stack.entries[nextIndex] ?? null,
  };
}

export function stepSpaHistoryForward(stack: SpaHistoryStack): {
  stack: SpaHistoryStack;
  target: string | null;
} {
  if (stack.index >= stack.entries.length - 1) {
    return { stack, target: null };
  }
  const nextIndex = stack.index + 1;
  return {
    stack: { entries: stack.entries, index: nextIndex },
    target: stack.entries[nextIndex] ?? null,
  };
}

export function reconcileSpaHistoryPop(
  stack: SpaHistoryStack,
  href: string,
  options?: { stateIndex?: number | null; directionHint?: -1 | 0 | 1 },
): SpaHistoryStack {
  const normalized = href || "/";
  const stateIdx = options?.stateIndex;
  if (
    typeof stateIdx === "number" &&
    Number.isInteger(stateIdx) &&
    stateIdx >= 0 &&
    stateIdx < stack.entries.length &&
    stack.entries[stateIdx] === normalized
  ) {
    return stateIdx === stack.index
      ? stack
      : { entries: stack.entries, index: stateIdx };
  }

  if (stack.entries[stack.index] === normalized) return stack;

  const hint = options?.directionHint ?? 0;
  if (
    hint === 1 &&
    stack.index + 1 < stack.entries.length &&
    stack.entries[stack.index + 1] === normalized
  ) {
    return { entries: stack.entries, index: stack.index + 1 };
  }
  if (stack.index > 0 && stack.entries[stack.index - 1] === normalized) {
    return { entries: stack.entries, index: stack.index - 1 };
  }
  if (
    stack.index + 1 < stack.entries.length &&
    stack.entries[stack.index + 1] === normalized
  ) {
    return { entries: stack.entries, index: stack.index + 1 };
  }

  for (let distance = 2; distance < stack.entries.length; distance += 1) {
    const backIdx = stack.index - distance;
    if (backIdx >= 0 && stack.entries[backIdx] === normalized) {
      return { entries: stack.entries, index: backIdx };
    }
    const fwdIdx = stack.index + distance;
    if (
      fwdIdx < stack.entries.length &&
      stack.entries[fwdIdx] === normalized
    ) {
      return { entries: stack.entries, index: fwdIdx };
    }
  }

  return pushSpaHistory(stack, normalized);
}

/* ── External Store Snapshot for Zero-Flicker Electron Bridge Detection ── */

const noopSubscribe = () => () => {};
const getBridgeInitialSnapshot = (): DesktopWindowInitialState | null =>
  typeof window === "undefined"
    ? null
    : (window.ludens?.window?.initialState ?? null);
const getServerBridgeSnapshot = (): DesktopWindowInitialState | null => null;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function readLocationRelativeHref(): string {
  if (typeof window === "undefined") return "/";
  return (window.location.pathname || "/") + window.location.search;
}

export interface UseDesktopWindowOptions {
  search: string;
  onNavigate(url: string, options?: { replace?: boolean }): void;
  mobileNavOpen?: boolean;
  onMobileNavOpenChange?(open: boolean): void;
}

export interface DesktopWindowController extends ResolvedDesktopChromeState {
  layout: DesktopTitlebarLayout;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  togglePreviewFullScreen(): void;
  close(): Promise<void>;
  handleTitlebarDoubleClick(): Promise<void>;
  companionAvailable: boolean;
  companionVisible: boolean;
  toggleCompanion(): Promise<void>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed(next: boolean | ((prev: boolean) => boolean)): void;
  toggleSidebar(): void;
  quickSwitcherOpen: boolean;
  setQuickSwitcherOpen(next: boolean | ((prev: boolean) => boolean)): void;
  setPreviewPlatform(platform: DesktopPlatform | null): void;
}

export function useDesktopWindow({
  search,
  onNavigate,
  mobileNavOpen = false,
  onMobileNavOpenChange,
}: UseDesktopWindowOptions): DesktopWindowController {
  const bridgeInitialState = useSyncExternalStore(
    noopSubscribe,
    getBridgeInitialSnapshot,
    getServerBridgeSnapshot,
  );

  const [bridgeState, setBridgeState] = useState<DesktopWindowState | null>(
    null,
  );
  const [windowFocused, setWindowFocused] = useState<boolean>(true);
  const [fallbackWebPlatform, setFallbackWebPlatform] =
    useState<DesktopPlatform>("darwin");

  // Preview state latches `?desktopPreview=darwin|win32` across SPA navigations so clicking
  // sidebar / workspace links never drops the preview chrome until explicitly exited.
  const urlPreviewDirective = useMemo(
    () => parseDesktopPreviewDirective(search),
    [search],
  );
  const [latchedPreview, setLatchedPreview] =
    useState<DesktopPlatform | null>(null);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [previewFullScreen, setPreviewFullScreen] = useState(false);

  useEffect(() => {
    if (urlPreviewDirective === "off") {
      setLatchedPreview(null);
      setPreviewMaximized(false);
      setPreviewFullScreen(false);
    } else if (urlPreviewDirective) {
      setLatchedPreview(urlPreviewDirective);
    }
  }, [urlPreviewDirective]);

  const effectivePreview =
    urlPreviewDirective === "off"
      ? null
      : (urlPreviewDirective ?? latchedPreview);

  const setPreviewPlatform = useCallback(
    (nextPlatform: DesktopPlatform | null) => {
      setLatchedPreview(nextPlatform);
      if (!nextPlatform) {
        setPreviewMaximized(false);
        setPreviewFullScreen(false);
      }
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      if (nextPlatform) {
        params.set("desktopPreview", nextPlatform);
      } else {
        params.delete("desktopPreview");
      }
      const qs = params.toString();
      onNavigate(qs ? `/?${qs}` : "/", { replace: true });
    },
    [onNavigate],
  );

  // Detect host web platform once on client for accurate Ctrl vs ⌘ hints in plain Web mode.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const navWithUAData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    setFallbackWebPlatform(
      detectBrowserPlatform(
        navigator.userAgent,
        navWithUAData.userAgentData?.platform ?? navigator.platform ?? "",
      ),
    );
  }, []);

  // Track window focus in browser & as fallback before Electron bridge push arrives.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setWindowFocused(document.hasFocus());
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Subscribe to Electron `window.ludens.window` state updates.
  useEffect(() => {
    const winBridge = window.ludens?.window;
    if (!winBridge) return;
    let active = true;
    void winBridge
      .getState()
      .then((initial) => {
        if (active) setBridgeState(initial);
      })
      .catch(() => {});
    const offState = winBridge.onState((next) => {
      if (active) setBridgeState(next);
    });
    return () => {
      active = false;
      offState();
    };
  }, []);

  // Companion Pet visibility subscription (`window.ludens.companion`).
  const [companionAvailable, setCompanionAvailable] = useState(false);
  const [companionVisible, setCompanionVisible] = useState(false);

  useEffect(() => {
    const companion = window.ludens?.companion;
    if (!companion) {
      setCompanionAvailable(false);
      return;
    }
    setCompanionAvailable(true);
    let active = true;
    void companion
      .getVisible()
      .then((visible) => {
        if (active) setCompanionVisible(visible);
      })
      .catch(() => {});
    const offVisibility = companion.onVisibility((visible) => {
      if (active) setCompanionVisible(visible);
    });
    return () => {
      active = false;
      offVisibility();
    };
  }, []);

  const toggleCompanion = useCallback(async () => {
    const companion = window.ludens?.companion;
    if (!companion) return;
    try {
      const next = await companion.toggle();
      setCompanionVisible(next);
    } catch {
      // Ignore transient IPC errors; onVisibility keeps state in sync.
    }
  }, []);

  // Persisted Sidebar Collapse (`localStorage["ludens:sidebar-collapsed"]`).
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (stored === "1") setSidebarCollapsedState(true);
    } catch {
      // Storage unavailable in restricted environments.
    }
  }, []);

  const setSidebarCollapsed = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setSidebarCollapsedState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(
            SIDEBAR_COLLAPSED_STORAGE_KEY,
            resolved ? "1" : "0",
          );
        } catch {
          // Ignore storage write errors.
        }
        return resolved;
      });
    },
    [],
  );

  //SPA History Stack + History API instrumentation.
  const [spaHistory, setSpaHistory] = useState<SpaHistoryStack>(() =>
    createSpaHistory("/"),
  );
  const historyDirectionHintRef = useRef<-1 | 0 | 1>(0);
  const spaHistoryRef = useRef(spaHistory);
  spaHistoryRef.current = spaHistory;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const initialHref = readLocationRelativeHref();
    const initialStack = createSpaHistory(initialHref);
    spaHistoryRef.current = initialStack;
    setSpaHistory(initialStack);

    const origPushState = window.history.pushState.bind(window.history);
    const origReplaceState = window.history.replaceState.bind(window.history);

    // Stamp initial entry index so native back/forward disambiguates repeated URLs (e.g. A -> B -> A).
    try {
      const currentState = window.history.state;
      if (
        !currentState ||
        typeof currentState !== "object" ||
        typeof currentState.__ludensNavIdx !== "number"
      ) {
        origReplaceState(
          {
            ...(currentState && typeof currentState === "object"
              ? currentState
              : {}),
            __ludensNavIdx: 0,
          },
          "",
          window.location.href,
        );
      }
    } catch {
      // Ignore security errors on non-standard history objects.
    }

    window.history.pushState = function patchedPushState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const nextPreviewHref =
        url != null
          ? (() => {
              try {
                const parsed = new URL(String(url), window.location.href);
                return (parsed.pathname || "/") + parsed.search;
              } catch {
                return readLocationRelativeHref();
              }
            })()
          : readLocationRelativeHref();
      const nextStack = pushSpaHistory(spaHistoryRef.current, nextPreviewHref);
      const stamped = {
        ...(data && typeof data === "object" ? (data as object) : {}),
        __ludensNavIdx: nextStack.index,
      };
      origPushState(stamped, unused, url);
      const committedHref = readLocationRelativeHref();
      const committedStack =
        committedHref === nextPreviewHref
          ? nextStack
          : pushSpaHistory(spaHistoryRef.current, committedHref);
      spaHistoryRef.current = committedStack;
      setSpaHistory(committedStack);
    };

    window.history.replaceState = function patchedReplaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const currentIdx = spaHistoryRef.current.index;
      const stamped = {
        ...(data && typeof data === "object" ? (data as object) : {}),
        __ludensNavIdx: currentIdx,
      };
      origReplaceState(stamped, unused, url);
      const committedHref = readLocationRelativeHref();
      const nextStack = replaceSpaHistory(spaHistoryRef.current, committedHref);
      spaHistoryRef.current = nextStack;
      setSpaHistory(nextStack);
    };

    const onPopState = (event: PopStateEvent) => {
      const href = readLocationRelativeHref();
      const stateIndex =
        event.state &&
        typeof event.state === "object" &&
        typeof (event.state as { __ludensNavIdx?: unknown }).__ludensNavIdx ===
          "number"
          ? ((event.state as { __ludensNavIdx: number }).__ludensNavIdx ?? null)
          : null;
      const hint = historyDirectionHintRef.current;
      historyDirectionHintRef.current = 0;
      const nextStack = reconcileSpaHistoryPop(spaHistoryRef.current, href, {
        stateIndex,
        directionHint: hint,
      });
      if (nextStack !== spaHistoryRef.current) {
        spaHistoryRef.current = nextStack;
        setSpaHistory(nextStack);
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.history.pushState = origPushState;
      window.history.replaceState = origReplaceState;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  const spaCanGoBack = spaHistory.index > 0;
  const spaCanGoForward = spaHistory.index < spaHistory.entries.length - 1;
  const canGoBack = spaCanGoBack || Boolean(bridgeState?.canGoBack);
  const canGoForward = spaCanGoForward || Boolean(bridgeState?.canGoForward);

  const goBack = useCallback(async () => {
    const winBridge = window.ludens?.window;
    historyDirectionHintRef.current = -1;
    if (spaHistoryRef.current.index > 0) {
      window.history.back();
      return;
    }
    if (winBridge && bridgeState?.canGoBack) {
      await winBridge.goBack().catch(() => false);
    }
  }, [bridgeState?.canGoBack]);

  const goForward = useCallback(async () => {
    const winBridge = window.ludens?.window;
    historyDirectionHintRef.current = 1;
    if (
      spaHistoryRef.current.index <
      spaHistoryRef.current.entries.length - 1
    ) {
      window.history.forward();
      return;
    }
    if (winBridge && bridgeState?.canGoForward) {
      await winBridge.goForward().catch(() => false);
    }
  }, [bridgeState?.canGoForward]);

  const chrome = useMemo(
    () =>
      resolveDesktopChromeState({
        bridgeInitialState,
        bridgeState,
        previewPlatform: effectivePreview,
        previewMaximized,
        previewFullScreen,
        windowFocused,
        fallbackWebPlatform,
      }),
    [
      bridgeInitialState,
      bridgeState,
      effectivePreview,
      previewMaximized,
      previewFullScreen,
      windowFocused,
      fallbackWebPlatform,
    ],
  );

  const layout = useMemo(
    () =>
      computeTitlebarLayout({
        active: chrome.active,
        platform: chrome.platform,
        captionStyle: chrome.captionStyle,
        fullScreen: chrome.fullScreen,
        titlebarHeight: chrome.titlebarHeight,
      }),
    [
      chrome.active,
      chrome.platform,
      chrome.captionStyle,
      chrome.fullScreen,
      chrome.titlebarHeight,
    ],
  );

  // Synchronously publish `--shell-topbar-height` and `data-desktop-chrome` to `<html>`
  // before paint so full-height workbenches (`100dvh - var(--shell-topbar-height)`) never jump.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--shell-topbar-height",
      `${layout.topbarHeightPx}px`,
    );
    if (chrome.active) {
      root.dataset.desktopChrome = "true";
      root.dataset.desktopPlatform = chrome.platform;
    } else {
      delete root.dataset.desktopChrome;
      delete root.dataset.desktopPlatform;
    }
    return () => {
      root.style.setProperty("--shell-topbar-height", "0px");
      delete root.dataset.desktopChrome;
      delete root.dataset.desktopPlatform;
    };
  }, [chrome.active, chrome.platform, layout.topbarHeightPx]);

  const reload = useCallback(async () => {
    const winBridge = window.ludens?.window;
    if (chrome.isPreview && effectivePreview) {
      const params = new URLSearchParams(window.location.search);
      params.set("desktopPreview", effectivePreview);
      window.history.replaceState(
        window.history.state,
        "",
        `/?${params.toString()}`,
      );
    }
    if (winBridge) {
      await winBridge.reload().catch(() => {});
      return;
    }
    window.location.reload();
  }, [chrome.isPreview, effectivePreview]);

  const minimize = useCallback(async () => {
    await window.ludens?.window?.minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(async () => {
    const winBridge = window.ludens?.window;
    if (
      chrome.isPreview &&
      (!winBridge || winBridge.initialState.platform !== chrome.platform)
    ) {
      setPreviewMaximized((prev) => !prev);
      return;
    }
    await winBridge?.toggleMaximize().catch(() => false);
  }, [chrome.isPreview, chrome.platform]);

  const togglePreviewFullScreen = useCallback(() => {
    setPreviewFullScreen((prev) => !prev);
  }, []);

  const close = useCallback(async () => {
    const winBridge = window.ludens?.window;
    if (
      chrome.isPreview &&
      (!winBridge || winBridge.initialState.platform !== chrome.platform)
    ) {
      setPreviewPlatform(null);
      return;
    }
    await winBridge?.close().catch(() => {});
  }, [chrome.isPreview, chrome.platform, setPreviewPlatform]);

  const handleTitlebarDoubleClick = useCallback(async () => {
    const winBridge = window.ludens?.window;
    if (
      chrome.isPreview &&
      (!winBridge || winBridge.initialState.platform !== chrome.platform)
    ) {
      setPreviewMaximized((prev) => !prev);
      return;
    }
    await winBridge?.handleTitlebarDoubleClick().catch(() => {});
  }, [chrome.isPreview, chrome.platform]);

  // Quick Switcher + Sidebar Toggle + Deduplicated Shortcuts & Electron Menu Commands.
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const mobileNavOpenRef = useRef(mobileNavOpen);
  mobileNavOpenRef.current = mobileNavOpen;
  const onMobileNavOpenChangeRef = useRef(onMobileNavOpenChange);
  onMobileNavOpenChangeRef.current = onMobileNavOpenChange;

  const lastToggleSidebarAtRef = useRef(0);
  const lastQuickSwitcherAtRef = useRef(0);

  const toggleSidebar = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleSidebarAtRef.current < COMMAND_DEDUPE_MS) return;
    lastToggleSidebarAtRef.current = now;

    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 680px)").matches &&
      onMobileNavOpenChangeRef.current
    ) {
      onMobileNavOpenChangeRef.current(!mobileNavOpenRef.current);
      return;
    }
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const toggleQuickSwitcher = useCallback(() => {
    const now = Date.now();
    if (now - lastQuickSwitcherAtRef.current < COMMAND_DEDUPE_MS) return;
    lastQuickSwitcherAtRef.current = now;
    setQuickSwitcherOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    const winBridge = window.ludens?.window;
    if (!winBridge) return;
    return winBridge.onCommand((command: DesktopWindowCommand) => {
      if (command === "toggle-sidebar") {
        toggleSidebar();
      } else if (command === "quick-switcher") {
        toggleQuickSwitcher();
      } else if (command === "navigate-back") {
        void goBack();
      } else if (command === "navigate-forward") {
        void goForward();
      }
    });
  }, [toggleSidebar, toggleQuickSwitcher, goBack, goForward]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();

      if (!event.shiftKey && key === "k") {
        event.preventDefault();
        toggleQuickSwitcher();
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (!event.shiftKey && key === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if (!event.shiftKey && event.key === "[") {
        if (canGoBack) {
          event.preventDefault();
          void goBack();
        }
        return;
      }

      if (!event.shiftKey && event.key === "]") {
        if (canGoForward) {
          event.preventDefault();
          void goForward();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleQuickSwitcher, toggleSidebar, canGoBack, canGoForward, goBack, goForward]);

  return {
    ...chrome,
    layout,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    reload,
    minimize,
    toggleMaximize,
    togglePreviewFullScreen,
    close,
    handleTitlebarDoubleClick,
    companionAvailable,
    companionVisible,
    toggleCompanion,
    sidebarCollapsed,
    setSidebarCollapsed,
    toggleSidebar,
    quickSwitcherOpen,
    setQuickSwitcherOpen,
    setPreviewPlatform,
  };
}
