"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  BUILTIN_BROWSER_START_URL,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  decodeViewportFrame,
  viewportFormatMimeType,
  type DeviceStageKind,
  type MouseButtonName,
  type NativeViewportBounds,
  type ViewportControlAction,
  type ViewportFramePacket,
  type ViewportHumanInput,
  type ViewportState,
  type ViewportWsClientMessage,
  type ViewportWsServerMessage,
} from "@ludens/protocol/viewport";
import {
  isLoopbackHost,
  type ConnectionTarget,
  type ResolvedConnectionEndpoints,
} from "@/lib/connection-target";
import type {
  DesktopViewportFramePayload,
  DesktopViewportHostInfo,
} from "@/lib/desktop";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";

export type ViewportTransportMode = "native-electron" | "stream" | "none";
export type ViewportStreamStatus = "idle" | "connecting" | "connected" | "disconnected";

const MODAL_OCCLUSION_SELECTOR =
  '[role="dialog"], [data-slot="dialog-content"], .codex-dock-backdrop, [data-viewport-floating-overlay]';

const PREVENT_DEFAULT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  " ",
  "Spacebar",
  "Tab",
  "Backspace",
]);

const STREAM_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000] as const;

/** Compute the effective right-dock stage kind with graceful `computer -> observe` fallback. */
export function resolveEffectiveStageKind(
  state: Pick<ViewportState, "stageKind" | "available" | "connected"> | null | undefined,
): DeviceStageKind {
  if (!state) return "observe";
  if (state.stageKind === "browser") return "browser";
  if (state.stageKind === "computer" && state.available && state.connected) return "computer";
  return "observe";
}

/** Build the `/viewport` WebSocket URL for stream mode, returning `null` for pure UDS/IPC targets. */
export function buildViewportWsUrl(options: {
  project: string;
  machineId?: string | null;
  target: ConnectionTarget;
  resolved: ResolvedConnectionEndpoints;
  mediaTicket?: string;
  viewportBasePath?: string;
}): string | null {
  const { project, machineId, resolved, mediaTicket, viewportBasePath = "/viewport" } = options;
  if (!project.trim() || !resolved.ok || resolved.transport !== "ws" || !resolved.wsUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(resolved.wsUrl);
  } catch {
    return null;
  }

  const normalizedBasePath = viewportBasePath.startsWith("/")
    ? viewportBasePath
    : `/${viewportBasePath}`;
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  const prefix = trimmedPath.endsWith("/rpc") ? trimmedPath.slice(0, -4) : trimmedPath;
  parsed.pathname = `${prefix}${normalizedBasePath}`;
  parsed.search = "";
  parsed.searchParams.set("project", project);
  if (machineId?.trim()) {
    parsed.searchParams.set("machine", machineId.trim());
  }
  if (mediaTicket?.trim()) {
    parsed.searchParams.set("ticket", mediaTicket.trim());
  }
  return parsed.toString();
}

/** Normalize user-entered omnibox text into a safe navigable URL (`http:`, `https:`, or start page). */
export function normalizeBrowserNavigationUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === BUILTIN_BROWSER_START_URL) {
    return BUILTIN_BROWSER_START_URL;
  }
  if (trimmed.toLowerCase() === "about:blank") {
    return "about:blank";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).href;
    } catch {
      return null;
    }
  }

  if (
    /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ||
    /^(javascript|data|blob|vbscript|file|about|mailto):/i.test(trimmed)
  ) {
    return null;
  }

  const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
  if (!authority) return null;
  const hostOnly = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : (authority.split(":")[0] ?? "");
  const isLocal =
    isLoopbackHost(hostOnly) ||
    hostOnly === "0.0.0.0" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostOnly);
  const candidate = `${isLocal ? "http" : "https"}://${trimmed}`;
  try {
    return new URL(candidate).href;
  } catch {
    return null;
  }
}

export function extractInputModifiers(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  let mask = 0;
  if (event.altKey) mask |= 1;
  if (event.ctrlKey) mask |= 2;
  if (event.metaKey) mask |= 4;
  if (event.shiftKey) mask |= 8;
  return mask;
}

export function mapMouseButton(button: number): MouseButtonName {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

export function computePointerCoordinates(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const safeW = rect.width > 0 ? rect.width : 1;
  const safeH = rect.height > 0 ? rect.height : 1;
  const normX = (clientX - rect.left) / safeW;
  const normY = (clientY - rect.top) / safeH;
  const x = Math.round(Math.max(0, Math.min(viewportWidth, normX * viewportWidth)));
  const y = Math.round(Math.max(0, Math.min(viewportHeight, normY * viewportHeight)));
  return { x, y };
}

export function rectsIntersectWithTolerance(
  a: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  b: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  tolerancePx = 2,
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    a.right > b.left + tolerancePx &&
    a.left < b.right - tolerancePx &&
    a.bottom > b.top + tolerancePx &&
    a.top < b.bottom - tolerancePx
  );
}

export function desktopFramePayloadToPacket(
  frame: DesktopViewportFramePayload,
): ViewportFramePacket {
  let bytes: Uint8Array;
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(frame.dataBase64, "base64");
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    const binary = atob(frame.dataBase64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  }
  return {
    format: frame.format,
    width: frame.width,
    height: frame.height,
    timestampMs: frame.timestampMs,
    seq: frame.seq,
    pointerLocked: frame.pointerLocked,
    bytes,
  };
}

export function hasVisibleModalOcclusion(
  doc: Document,
  slotEl?: HTMLElement | null,
): boolean {
  const nodes = doc.querySelectorAll<HTMLElement>(MODAL_OCCLUSION_SELECTOR);
  const slotRect = slotEl ? slotEl.getBoundingClientRect() : null;
  for (const node of nodes) {
    if (node.hidden) continue;
    if (node.getAttribute("aria-hidden") === "true" && !node.classList.contains("codex-dock-backdrop")) {
      continue;
    }
    if (node.dataset.motionState === "closed" || node.dataset.state === "closed") {
      continue;
    }
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    if (node.hasAttribute("data-viewport-floating-overlay")) {
      if (!slotRect) continue;
      if (rectsIntersectWithTolerance(rect, slotRect, 2)) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

function measureSlotBounds(el: HTMLElement | null): NativeViewportBounds {
  if (!el) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

function boundsEqual(a: NativeViewportBounds | null, b: NativeViewportBounds): boolean {
  return Boolean(
    a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height,
  );
}

export interface UseDeviceViewportOptions {
  project: string;
  workspace: string | null;
  machineId?: string | null;
  isAuto: boolean;
  hostOnline: boolean;
  immersive?: boolean;
  suspended?: boolean;
  enabled?: boolean;
}

export interface DeviceViewportStageHandlers {
  onMouseMove: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onMouseUp: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLCanvasElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onBlur: () => void;
}

export interface UseDeviceViewportResult {
  readonly state: ViewportState | null;
  readonly effectiveStageKind: DeviceStageKind;
  readonly transportMode: ViewportTransportMode;
  readonly streamStatus: ViewportStreamStatus;
  readonly loading: boolean;
  readonly error: string | null;
  readonly occluded: boolean;
  readonly hasFrame: boolean;
  readonly pointerLockedLocal: boolean;
  readonly slotRef: RefObject<HTMLDivElement | null>;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly stageHandlers: DeviceViewportStageHandlers;
  readonly refresh: () => Promise<void>;
  readonly performAction: (action: ViewportControlAction) => Promise<void>;
  readonly sendInput: (input: ViewportHumanInput) => void;
  readonly requestPointerLock: () => void;
  readonly exitPointerLock: () => void;
}

export function useDeviceViewport(options: UseDeviceViewportOptions): UseDeviceViewportResult {
  const {
    project,
    workspace,
    machineId = null,
    isAuto,
    hostOnline,
    immersive = false,
    suspended = false,
    enabled = true,
  } = options;

  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const [state, setState] = useState<ViewportState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostInfo, setHostInfo] = useState<DesktopViewportHostInfo | null>(null);
  const [occluded, setOccluded] = useState(false);
  const [streamStatus, setStreamStatus] = useState<ViewportStreamStatus>("idle");
  const [hasFrame, setHasFrame] = useState(false);
  const [pointerLockedLocal, setPointerLockedLocal] = useState(false);

  const slotRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const stateRef = useRef<ViewportState | null>(state);
  stateRef.current = state;

  const wsRef = useRef<WebSocket | null>(null);
  const lastBitmapRef = useRef<ImageBitmap | null>(null);
  const decodingFrameRef = useRef(false);
  const pendingFrameRef = useRef<ViewportFramePacket | null>(null);
  const lastRpcMoveMsRef = useRef(0);
  const hadHeldInputRef = useRef(false);
  const describeAbortRef = useRef<AbortController | null>(null);

  const effectiveStageKind = useMemo(() => resolveEffectiveStageKind(state), [state]);

  const targetKind = rpc?.snapshot.target.kind ?? null;
  const resolvedEndpoints = rpc?.snapshot.resolved ?? null;
  const mediaTicket = rpc?.snapshot.mediaTicket;
  const viewportBasePath = rpc?.snapshot.serverInfo?.media?.viewportBasePath ?? "/viewport";
  const reconnectGeneration = rpc?.reconnectGeneration ?? 0;

  // Reset per-workspace viewport state on workspace switch
  useEffect(() => {
    setState(null);
    setError(null);
    setHasFrame(false);
    if (lastBitmapRef.current) {
      try {
        lastBitmapRef.current.close();
      } catch {
        // Ignore already-closed bitmap
      }
      lastBitmapRef.current = null;
    }
  }, [project, workspace, machineId]);

  // Query Desktop native viewport host info when running inside Electron
  useEffect(() => {
    if (typeof window === "undefined" || !window.ludens?.viewport?.getHostInfo) {
      setHostInfo(null);
      return;
    }
    let cancelled = false;
    void window.ludens.viewport
      .getHostInfo()
      .then(info => {
        if (!cancelled) setHostInfo(info);
      })
      .catch(() => {
        if (!cancelled) setHostInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state?.nativeHostId, reconnectGeneration]);

  const refresh = useCallback(async () => {
    const caller = rpcRef.current;
    if (!enabled || !caller || !project) return;
    describeAbortRef.current?.abort();
    const controller = new AbortController();
    describeAbortRef.current = controller;
    setLoading(true);
    try {
      const next = await caller.call(
        "viewport/describe",
        {
          project,
          ...(workspace ? { workspace } : {}),
          ...(machineId ? { machineId } : {}),
        },
        { signal: controller.signal, timeoutMs: 10_000 },
      );
      if (controller.signal.aborted) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [enabled, machineId, project, workspace]);

  useEffect(() => {
    if (!enabled || !project || !rpc) return;
    void refresh();
    return () => {
      describeAbortRef.current?.abort();
    };
  }, [enabled, project, workspace, machineId, isAuto, hostOnline, reconnectGeneration, Boolean(rpc), refresh]);

  useLudensEvent(
    ["viewport", "baseware", "run", "core"],
    () => {
      if (enabled && project) {
        void refresh();
      }
    },
    { enabled: enabled && Boolean(project), workspaceId: project || undefined },
  );

  const wsUrl = useMemo(() => {
    if (!rpc || !resolvedEndpoints || !project) return null;
    return buildViewportWsUrl({
      project,
      machineId,
      target: rpc.snapshot.target,
      resolved: resolvedEndpoints,
      mediaTicket,
      viewportBasePath,
    });
  }, [rpc, resolvedEndpoints, project, machineId, mediaTicket, viewportBasePath]);

  const canNativeEmbed = Boolean(
    typeof window !== "undefined" &&
      window.ludens?.viewport &&
      targetKind === "electron-local" &&
      state?.available &&
      state.capabilities.nativeEmbed &&
      state.sessionId &&
      hostInfo?.available &&
      hostInfo.hostId &&
      state.nativeHostId &&
      state.nativeHostId === hostInfo.hostId,
  );

  const transportMode: ViewportTransportMode = useMemo(() => {
    if (!enabled || effectiveStageKind === "observe" || !state?.available) {
      return "none";
    }
    if (canNativeEmbed) {
      return "native-electron";
    }
    if (wsUrl) {
      return "stream";
    }
    return "none";
  }, [enabled, effectiveStageKind, state?.available, canNativeEmbed, wsUrl]);

  // Detect modal / dialog / geometric floating-overlay occlusion when using native Electron WebContentsView
  useEffect(() => {
    if (transportMode !== "native-electron" || typeof document === "undefined") {
      setOccluded(false);
      return;
    }

    const check = () => {
      setOccluded(hasVisibleModalOcclusion(document, slotRef.current));
    };
    check();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && slotRef.current) {
      resizeObserver = new ResizeObserver(check);
      resizeObserver.observe(slotRef.current);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", check);
    }

    if (typeof MutationObserver === "undefined" || !document.body) {
      return () => {
        resizeObserver?.disconnect();
        if (typeof window !== "undefined") {
          window.removeEventListener("resize", check);
        }
      };
    }
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "role",
        "data-slot",
        "data-state",
        "data-motion-state",
        "data-viewport-floating-overlay",
        "data-pod-tier",
        "data-pod-anchor",
        "class",
        "hidden",
        "style",
      ],
    });
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", check);
      }
    };
  }, [transportMode, immersive]);

  // Synchronize Electron native WebContentsView bounds, visibility, and interactivity
  const nativeSessionId = transportMode === "native-electron" ? (state?.sessionId ?? null) : null;
  const nativeInitialUrl = state?.navigation?.url;
  const nativeInteractive = state?.controlMode === "manual";
  const nativeVisible = !occluded && !suspended;

  useEffect(() => {
    if (
      transportMode !== "native-electron" ||
      !nativeSessionId ||
      typeof window === "undefined" ||
      !window.ludens?.viewport
    ) {
      return;
    }

    const bridge = window.ludens.viewport;
    let disposed = false;
    let attached = false;
    let rafId: number | null = null;
    let lastBounds: NativeViewportBounds | null = null;
    let lastVisible: boolean | null = null;
    let lastInteractive: boolean | null = null;

    const syncNow = () => {
      if (disposed) return;
      const bounds = measureSlotBounds(slotRef.current);
      const effectiveVisible = nativeVisible && bounds.width > 10 && bounds.height > 10;

      if (!attached) {
        attached = true;
        lastBounds = bounds;
        lastVisible = effectiveVisible;
        lastInteractive = nativeInteractive;
        void bridge
          .attach({
            sessionId: nativeSessionId,
            ...(nativeInitialUrl ? { initialUrl: nativeInitialUrl } : {}),
            bounds,
            visible: effectiveVisible,
            interactive: nativeInteractive,
          })
          .catch(() => {
            // Non-fatal; next bounds tick or describe refresh retries.
          });
        return;
      }

      if (
        boundsEqual(lastBounds, bounds) &&
        lastVisible === effectiveVisible &&
        lastInteractive === nativeInteractive
      ) {
        return;
      }
      lastBounds = bounds;
      lastVisible = effectiveVisible;
      lastInteractive = nativeInteractive;
      void bridge
        .updateBounds({
          sessionId: nativeSessionId,
          bounds,
          visible: effectiveVisible,
          interactive: nativeInteractive,
        })
        .catch(() => {
          // Ignore transient IPC update failures during teardown.
        });
    };

    const scheduleSync = () => {
      if (disposed || rafId !== null) return;
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          syncNow();
        });
      } else {
        syncNow();
      }
    };

    syncNow();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && slotRef.current) {
      resizeObserver = new ResizeObserver(scheduleSync);
      resizeObserver.observe(slotRef.current);
    }
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("scroll", scheduleSync, true);

    return () => {
      disposed = true;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scroll", scheduleSync, true);
    };
  }, [transportMode, nativeSessionId, nativeInitialUrl, nativeVisible, nativeInteractive]);

  // Detach Electron native view when switching sessions, leaving native mode, or unmounting
  useEffect(() => {
    if (
      transportMode !== "native-electron" ||
      !nativeSessionId ||
      typeof window === "undefined" ||
      !window.ludens?.viewport
    ) {
      return;
    }
    const bridge = window.ludens.viewport;
    return () => {
      void bridge.detach(nativeSessionId).catch(() => {
        // Ignore teardown errors
      });
    };
  }, [transportMode, nativeSessionId]);

  // Binary `/viewport` WebSocket stream (Web Console, remote targets, and Electron occluded backdrop when WS available)
  const shouldConnectStream = Boolean(
    enabled &&
      wsUrl &&
      state?.available &&
      (effectiveStageKind === "browser" || effectiveStageKind === "computer") &&
      (transportMode === "stream" || (transportMode === "native-electron" && occluded)),
  );

  const drawFramePacket = useCallback((packet: ViewportFramePacket) => {
    const canvas = canvasRef.current;
    if (!canvas || typeof createImageBitmap !== "function") return;
    if (decodingFrameRef.current) {
      pendingFrameRef.current = packet;
      return;
    }

    const decodeAndRender = (nextPacket: ViewportFramePacket) => {
      decodingFrameRef.current = true;
      const mimeType = viewportFormatMimeType(nextPacket.format);
      const blob = new Blob([new Uint8Array(nextPacket.bytes)], { type: mimeType });
      void createImageBitmap(blob)
        .then(bitmap => {
          const targetCanvas = canvasRef.current;
          if (!targetCanvas) {
            bitmap.close();
            return;
          }
          if (nextPacket.width > 0 && nextPacket.height > 0) {
            if (targetCanvas.width !== nextPacket.width) targetCanvas.width = nextPacket.width;
            if (targetCanvas.height !== nextPacket.height) targetCanvas.height = nextPacket.height;
          }
          const ctx = targetCanvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, targetCanvas.width, targetCanvas.height);
          }
          const prev = lastBitmapRef.current;
          lastBitmapRef.current = bitmap;
          if (prev) {
            try {
              prev.close();
            } catch {
              // Ignore already-closed bitmap
            }
          }
          setHasFrame(true);
          setState(prevState =>
            prevState && prevState.pointerLocked !== nextPacket.pointerLocked
              ? { ...prevState, pointerLocked: nextPacket.pointerLocked }
              : prevState,
          );
        })
        .catch(() => {
          // Drop malformed or aborted frame cleanly
        })
        .finally(() => {
          decodingFrameRef.current = false;
          const queued = pendingFrameRef.current;
          pendingFrameRef.current = null;
          if (queued) {
            decodeAndRender(queued);
          }
        });
    };

    decodeAndRender(packet);
  }, []);

  useEffect(() => {
    if (!shouldConnectStream || !wsUrl || typeof WebSocket === "undefined") {
      setStreamStatus("idle");
      return;
    }

    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      setStreamStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStreamStatus("disconnected");
        return;
      }
      ws.binaryType = "arraybuffer";
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        attempt = 0;
        setStreamStatus("connected");
        setError(null);
        const sub: ViewportWsClientMessage = { type: "subscribe", maxFps: 30, quality: 78 };
        try {
          ws.send(JSON.stringify(sub));
        } catch {
          // Socket close handler will reconnect
        }
      };

      ws.onmessage = event => {
        if (disposed || wsRef.current !== ws) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as ViewportWsServerMessage;
            if (msg.type === "state" && msg.state) {
              setState(msg.state);
              setError(null);
            } else if (msg.type === "error") {
              setError(msg.message);
            }
          } catch {
            // Ignore malformed control frame
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          try {
            drawFramePacket(decodeViewportFrame(event.data));
          } catch {
            // Ignore malformed binary packet
          }
          return;
        }
        if (event.data instanceof Blob) {
          void event.data
            .arrayBuffer()
            .then(buf => {
              if (disposed) return;
              drawFramePacket(decodeViewportFrame(buf));
            })
            .catch(() => {
              // Ignore
            });
        }
      };

      ws.onerror = () => {
        if (disposed || wsRef.current !== ws) return;
        setStreamStatus("disconnected");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (disposed) return;
        setStreamStatus("disconnected");
        const delay =
          STREAM_RECONNECT_DELAYS_MS[Math.min(attempt, STREAM_RECONNECT_DELAYS_MS.length - 1)] ??
          4000;
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pendingFrameRef.current = null;
      if (socket) {
        if (wsRef.current === socket) wsRef.current = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Ignore
        }
      }
      setStreamStatus("idle");
    };
  }, [shouldConnectStream, wsUrl, drawFramePacket]);

  // Zero-port Electron IPC frame stream fallback when native WebContentsView is occluded by an overlay
  useEffect(() => {
    if (
      !enabled ||
      suspended ||
      transportMode !== "native-electron" ||
      !occluded ||
      !nativeSessionId ||
      Boolean(wsUrl) ||
      typeof window === "undefined" ||
      !window.ludens?.viewport?.setFrameStream ||
      !window.ludens?.viewport?.onFrame
    ) {
      return;
    }

    const bridge = window.ludens.viewport;
    let disposed = false;
    setStreamStatus("connected");

    const offFrame = bridge.onFrame!(frame => {
      if (disposed || frame.sessionId !== nativeSessionId) return;
      try {
        drawFramePacket(desktopFramePayloadToPacket(frame));
      } catch {
        // Ignore malformed frame payload
      }
    });

    void bridge
      .setFrameStream!({
        sessionId: nativeSessionId,
        active: true,
        maxFps: 30,
        quality: 82,
      })
      .catch(() => {
        if (!disposed) {
          setStreamStatus("disconnected");
        }
      });

    return () => {
      disposed = true;
      offFrame();
      pendingFrameRef.current = null;
      void bridge
        .setFrameStream!({ sessionId: nativeSessionId, active: false })
        .catch(() => {
          // Ignore teardown errors
        });
      setStreamStatus("idle");
    };
  }, [enabled, suspended, transportMode, occluded, nativeSessionId, wsUrl, drawFramePacket]);

  // Clean up retained ImageBitmap on unmount
  useEffect(() => {
    return () => {
      if (lastBitmapRef.current) {
        try {
          lastBitmapRef.current.close();
        } catch {
          // Ignore
        }
        lastBitmapRef.current = null;
      }
    };
  }, []);

  // Track browser Pointer Lock status on our stream canvas
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handlePointerLockChange = () => {
      const locked = Boolean(canvasRef.current && document.pointerLockElement === canvasRef.current);
      setPointerLockedLocal(locked);
    };
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
    };
  }, []);

  const exitPointerLock = useCallback(() => {
    if (typeof document !== "undefined" && document.pointerLockElement) {
      try {
        document.exitPointerLock?.();
      } catch {
        // Ignore
      }
    }
  }, []);

  const requestPointerLock = useCallback(() => {
    const current = stateRef.current;
    const canvas = canvasRef.current;
    if (
      !canvas ||
      !current ||
      current.controlMode !== "manual" ||
      !current.capabilities.pointerLock
    ) {
      return;
    }
    try {
      canvas.requestPointerLock?.();
    } catch {
      // Ignore browser gesture restriction errors
    }
  }, []);

  const sendInput = useCallback(
    (input: ViewportHumanInput) => {
      const canDispatchCanvasInput =
        transportMode === "stream" || (transportMode === "native-electron" && occluded);
      if (!canDispatchCanvasInput && input.type !== "releaseAll") return;

      const current = stateRef.current;
      if (!current || current.controlMode !== "manual") return;

      if (input.type === "keyDown" || input.type === "mouseDown") {
        hadHeldInputRef.current = true;
      } else if (input.type === "releaseAll") {
        hadHeldInputRef.current = false;
      }

      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        const msg: ViewportWsClientMessage = { type: "input", input };
        try {
          ws.send(JSON.stringify(msg));
          return;
        } catch {
          // Fall through to RPC fallback
        }
      }

      const caller = rpcRef.current;
      if (!caller || !project) return;
      if (input.type === "mouseMove" || input.type === "mouseMoveRelative") {
        const now = Date.now();
        if (now - lastRpcMoveMsRef.current < 32) return;
        lastRpcMoveMsRef.current = now;
      }
      void caller
        .call("viewport/input", {
          project,
          ...(workspace ? { workspace } : {}),
          ...(machineId ? { machineId } : {}),
          input,
        })
        .catch(() => {
          // Non-fatal during mode transitions
        });
    },
    [machineId, occluded, project, transportMode, workspace],
  );

  // Release pointer lock & held inputs whenever leaving manual mode or suspending
  useEffect(() => {
    if (state?.controlMode !== "manual" || suspended) {
      exitPointerLock();
      if (hadHeldInputRef.current && state?.controlMode === "manual") {
        sendInput({ type: "releaseAll" });
      }
      hadHeldInputRef.current = false;
    }
  }, [state?.controlMode, suspended, exitPointerLock, sendInput]);

  const performAction = useCallback(
    async (action: ViewportControlAction) => {
      const current = stateRef.current;
      if (!current || current.controlMode !== "manual") return;

      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        const msg: ViewportWsClientMessage = { type: "action", action };
        try {
          ws.send(JSON.stringify(msg));
          return;
        } catch {
          // Fall through to RPC fallback
        }
      }

      const caller = rpcRef.current;
      if (!caller || !project) return;
      try {
        const updated = await caller.call("viewport/action", {
          project,
          ...(workspace ? { workspace } : {}),
          ...(machineId ? { machineId } : {}),
          action,
        });
        setState(updated);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [machineId, project, workspace],
  );

  // Live Browser Resize Sync: full-bleed slot dimensions in Immersive Mode, 1280x720 desktop layout on Split exit
  const wasImmersiveRef = useRef(Boolean(immersive));
  useEffect(() => {
    const prevImmersive = wasImmersiveRef.current;
    wasImmersiveRef.current = Boolean(immersive);
    if (
      prevImmersive &&
      !immersive &&
      enabled &&
      effectiveStageKind === "browser" &&
      stateRef.current?.available &&
      stateRef.current.capabilities.resize
    ) {
      void performAction({
        kind: "resize",
        width: DEFAULT_VIEWPORT_WIDTH,
        height: DEFAULT_VIEWPORT_HEIGHT,
      });
    }
  }, [immersive, enabled, effectiveStageKind, performAction]);

  useEffect(() => {
    if (
      !immersive ||
      !enabled ||
      suspended ||
      effectiveStageKind !== "browser" ||
      !state?.available ||
      !state.capabilities.resize ||
      state.controlMode !== "manual"
    ) {
      return;
    }
    const slotEl = slotRef.current;
    if (!slotEl) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSlotResize = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const el = slotRef.current;
        const current = stateRef.current;
        if (!el || !current || !current.available || current.controlMode !== "manual") {
          return;
        }
        const rect = el.getBoundingClientRect();
        const slotW = Math.round(rect.width);
        const slotH = Math.round(rect.height);
        if (slotW < 320 || slotH < 240) return;
        if (Math.abs(slotW - current.width) > 2 || Math.abs(slotH - current.height) > 2) {
          void performAction({ kind: "resize", width: slotW, height: slotH });
        }
      }, 120);
    };

    scheduleSlotResize();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleSlotResize);
      resizeObserver.observe(slotEl);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", scheduleSlotResize);
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", scheduleSlotResize);
      }
    };
  }, [
    immersive,
    enabled,
    suspended,
    effectiveStageKind,
    state?.available,
    state?.capabilities.resize,
    state?.controlMode,
    performAction,
  ]);

  const stageHandlers = useMemo<DeviceViewportStageHandlers>(() => {
    const getViewportSize = () => ({
      width: stateRef.current?.width || DEFAULT_VIEWPORT_WIDTH,
      height: stateRef.current?.height || DEFAULT_VIEWPORT_HEIGHT,
    });

    return {
      onMouseMove(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.mouse) return;
        const modifiers = extractInputModifiers(event);
        const locked =
          typeof document !== "undefined" &&
          Boolean(canvasRef.current && document.pointerLockElement === canvasRef.current);
        if (locked) {
          sendInput({
            type: "mouseMoveRelative",
            dx: event.movementX,
            dy: event.movementY,
            buttons: event.buttons,
            modifiers,
          });
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const { width, height } = getViewportSize();
        const { x, y } = computePointerCoordinates(rect, event.clientX, event.clientY, width, height);
        sendInput({ type: "mouseMove", x, y, buttons: event.buttons, modifiers });
      },

      onMouseDown(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.mouse) return;
        stageRef.current?.focus({ preventScroll: true });
        if (current.pointerLocked && current.capabilities.pointerLock) {
          requestPointerLock();
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const { width, height } = getViewportSize();
        const { x, y } = computePointerCoordinates(rect, event.clientX, event.clientY, width, height);
        sendInput({
          type: "mouseDown",
          x,
          y,
          button: mapMouseButton(event.button),
          clickCount: Math.max(1, event.detail || 1),
          modifiers: extractInputModifiers(event),
        });
      },

      onMouseUp(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.mouse) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const { width, height } = getViewportSize();
        const { x, y } = computePointerCoordinates(rect, event.clientX, event.clientY, width, height);
        sendInput({
          type: "mouseUp",
          x,
          y,
          button: mapMouseButton(event.button),
          clickCount: Math.max(1, event.detail || 1),
          modifiers: extractInputModifiers(event),
        });
      },

      onWheel(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.mouse) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const { width, height } = getViewportSize();
        const { x, y } = computePointerCoordinates(rect, event.clientX, event.clientY, width, height);
        sendInput({
          type: "mouseWheel",
          x,
          y,
          deltaX: Math.round(event.deltaX),
          deltaY: Math.round(event.deltaY),
          modifiers: extractInputModifiers(event),
        });
      },

      onContextMenu(event) {
        const current = stateRef.current;
        if (current?.controlMode === "manual") {
          event.preventDefault();
        }
      },

      onDoubleClick() {
        const current = stateRef.current;
        if (current?.controlMode === "manual" && current.capabilities.pointerLock) {
          requestPointerLock();
        }
      },

      onKeyDown(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.keyboard) return;
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
          return;
        }
        if (PREVENT_DEFAULT_KEYS.has(event.key)) {
          event.preventDefault();
        }
        sendInput({
          type: "keyDown",
          key: event.key,
          code: event.code || undefined,
          text: event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : undefined,
          modifiers: extractInputModifiers(event),
          autoRepeat: event.repeat || undefined,
        });
      },

      onKeyUp(event) {
        const current = stateRef.current;
        if (!current || current.controlMode !== "manual" || !current.capabilities.keyboard) return;
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
          return;
        }
        sendInput({
          type: "keyUp",
          key: event.key,
          code: event.code || undefined,
          modifiers: extractInputModifiers(event),
        });
      },

      onBlur() {
        if (hadHeldInputRef.current) {
          sendInput({ type: "releaseAll" });
        }
      },
    };
  }, [requestPointerLock, sendInput]);

  return {
    state,
    effectiveStageKind,
    transportMode,
    streamStatus,
    loading,
    error,
    occluded,
    hasFrame,
    pointerLockedLocal,
    slotRef,
    canvasRef,
    stageRef,
    stageHandlers,
    refresh,
    performAction,
    sendInput,
    requestPointerLock,
    exitPointerLock,
  };
}
