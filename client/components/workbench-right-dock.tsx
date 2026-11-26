"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useAnimatedPresence } from "@/components/use-motion-preferences";

function joinClasses(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

export const WORKBENCH_OVERLAY_MAX_WIDTH_PX = 1099;
export const WORKBENCH_OVERLAY_QUERY = `(max-width: ${WORKBENCH_OVERLAY_MAX_WIDTH_PX}px)`;

function subscribeOverlayMedia(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(WORKBENCH_OVERLAY_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getOverlayMediaSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(WORKBENCH_OVERLAY_QUERY).matches;
}

function getOverlayMediaServerSnapshot(): boolean {
  return false;
}

export function clampWorkbenchDockWidth(
  desired: number,
  containerWidth: number,
  minDockWidthPx = 320,
  minMainWidthPx = 360,
): number {
  const maxAllowed = Math.max(minDockWidthPx, containerWidth - minMainWidthPx);
  return Math.round(Math.max(minDockWidthPx, Math.min(maxAllowed, desired)));
}

export interface UseWorkbenchRightDockOptions {
  workbenchRef?: RefObject<HTMLElement | null>;
  defaultInlineOpen?: boolean;
  defaultOverlayOpen?: boolean;
  forceInlineMode?: boolean;
  preferredWidthPx?: number | null | ((containerWidth: number) => number | null);
  minDockWidthPx?: number;
  minMainWidthPx?: number;
  compactWidthPx?: number;
  resetKey?: string;
}

export interface CloseWorkbenchDockOptions {
  restoreFocus?: boolean;
}

export interface UseWorkbenchRightDockResult {
  dockId: string;
  isOverlay: boolean;
  dockOpen: boolean;
  inlineOpen: boolean;
  drawerOpen: boolean;
  mainInert: boolean;
  resizing: boolean;
  resolvedWidthPx: number | null;
  customWidthPx: number | null;
  isExpandedWidth: boolean;
  backdropPresence: { mounted: boolean; state: "open" | "closed" };
  toggleButtonRef: RefObject<HTMLButtonElement | null>;
  openDock(): void;
  closeDock(options?: CloseWorkbenchDockOptions): void;
  toggleDock(): void;
  setCustomWidthPx(width: number | null): void;
  resetCustomWidth(): void;
  toggleWidthPreset(): void;
  handleResizeStart(event: ReactPointerEvent<HTMLDivElement>): void;
}

/**
 * Unified 3-column workbench right-dock controller shared by Live ("运行") and Replay ("回放"):
 * - `>= 1100px`: inline resizable split column (`inlineOpen` remembered independently)
 * - `< 1100px`: modal slide-over drawer (`drawerOpen`, Escape + backdrop light-dismiss + focus restoration)
 */
export function useWorkbenchRightDock({
  workbenchRef,
  defaultInlineOpen = true,
  defaultOverlayOpen = false,
  forceInlineMode = false,
  preferredWidthPx,
  minDockWidthPx = 320,
  minMainWidthPx = 360,
  compactWidthPx = 400,
  resetKey,
}: UseWorkbenchRightDockOptions = {}): UseWorkbenchRightDockResult {
  const dockId = useId();
  const rawOverlay = useSyncExternalStore(
    subscribeOverlayMedia,
    getOverlayMediaSnapshot,
    getOverlayMediaServerSnapshot,
  );
  const isOverlay = rawOverlay && !forceInlineMode;

  const [inlineOpen, setInlineOpen] = useState<boolean>(defaultInlineOpen);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(defaultOverlayOpen);
  const [customWidthPx, setCustomWidthPx] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [viewportWidthPx, setViewportWidthPx] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );

  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const prevOverlayRef = useRef<boolean>(rawOverlay);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Close the transient overlay drawer whenever crossing into `<1100px` from desktop split mode
  useEffect(() => {
    if (prevOverlayRef.current !== rawOverlay) {
      prevOverlayRef.current = rawOverlay;
      if (rawOverlay) {
        setDrawerOpen(false);
      }
    }
  }, [rawOverlay]);

  useEffect(() => {
    if (resetKey !== undefined) {
      setCustomWidthPx(null);
    }
  }, [resetKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => setViewportWidthPx(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  const dockOpen = forceInlineMode ? true : isOverlay ? drawerOpen : inlineOpen;
  const mainInert = isOverlay && dockOpen;
  const backdropPresence = useAnimatedPresence(isOverlay && dockOpen, 180);

  const restoreToggleFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const btn = toggleButtonRef.current;
      if (btn?.isConnected) {
        btn.focus({ preventScroll: true });
      }
    });
  }, []);

  const openDock = useCallback(() => {
    setInlineOpen(true);
    setDrawerOpen(true);
  }, []);

  const closeDock = useCallback(
    (options?: CloseWorkbenchDockOptions) => {
      if (isOverlay) {
        setDrawerOpen(false);
        if (options?.restoreFocus) {
          restoreToggleFocus();
        }
      } else {
        setInlineOpen(false);
      }
    },
    [isOverlay, restoreToggleFocus],
  );

  const toggleDock = useCallback(() => {
    if (isOverlay) {
      setDrawerOpen(prev => !prev);
    } else {
      setInlineOpen(prev => !prev);
    }
  }, [isOverlay]);

  useEffect(() => {
    if (!isOverlay || !drawerOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setDrawerOpen(false);
        restoreToggleFocus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOverlay, drawerOpen, restoreToggleFocus]);

  const containerWidth = workbenchRef?.current?.clientWidth || viewportWidthPx;

  const resolvedWidthPx = useMemo(() => {
    if (!dockOpen || isOverlay || forceInlineMode) return null;
    if (customWidthPx != null) {
      return clampWorkbenchDockWidth(customWidthPx, containerWidth, minDockWidthPx, minMainWidthPx);
    }
    const preferred =
      typeof preferredWidthPx === "function" ? preferredWidthPx(containerWidth) : (preferredWidthPx ?? null);
    if (preferred != null) {
      return clampWorkbenchDockWidth(preferred, containerWidth, minDockWidthPx, minMainWidthPx);
    }
    return null;
  }, [
    dockOpen,
    isOverlay,
    forceInlineMode,
    customWidthPx,
    containerWidth,
    preferredWidthPx,
    minDockWidthPx,
    minMainWidthPx,
  ]);

  const isExpandedWidth = resolvedWidthPx != null && resolvedWidthPx >= 500;

  const resetCustomWidth = useCallback(() => {
    setCustomWidthPx(null);
  }, []);

  const toggleWidthPreset = useCallback(() => {
    const widthNow = workbenchRef?.current?.clientWidth || viewportWidthPx;
    if (isExpandedWidth) {
      setCustomWidthPx(compactWidthPx);
      return;
    }
    const expandedTarget = Math.min(680, Math.max(560, Math.round(widthNow * 0.48)));
    setCustomWidthPx(clampWorkbenchDockWidth(expandedTarget, widthNow, minDockWidthPx, minMainWidthPx));
  }, [workbenchRef, viewportWidthPx, isExpandedWidth, compactWidthPx, minDockWidthPx, minMainWidthPx]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isOverlay || forceInlineMode || !dockOpen || event.button !== 0) return;
      event.preventDefault();
      resizeCleanupRef.current?.();
      setResizing(true);

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        const host = workbenchRef?.current;
        const rect = host?.getBoundingClientRect();
        const totalWidth = rect?.width || window.innerWidth;
        const rightEdge = rect?.right ?? window.innerWidth;
        const desired = rightEdge - moveEvent.clientX;
        setCustomWidthPx(clampWorkbenchDockWidth(desired, totalWidth, minDockWidthPx, minMainWidthPx));
      };

      const finish = () => {
        setResizing(false);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        resizeCleanupRef.current = null;
      };

      resizeCleanupRef.current = finish;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [isOverlay, forceInlineMode, dockOpen, workbenchRef, minDockWidthPx, minMainWidthPx],
  );

  return {
    dockId,
    isOverlay,
    dockOpen,
    inlineOpen,
    drawerOpen,
    mainInert,
    resizing,
    resolvedWidthPx,
    customWidthPx,
    isExpandedWidth,
    backdropPresence,
    toggleButtonRef,
    openDock,
    closeDock,
    toggleDock,
    setCustomWidthPx,
    resetCustomWidth,
    toggleWidthPreset,
    handleResizeStart,
  };
}

export interface WorkbenchRightDockProps extends Omit<HTMLAttributes<HTMLElement>, "id"> {
  dock: UseWorkbenchRightDockResult;
  ariaLabel: string;
  immersive?: boolean;
  disableResize?: boolean;
  resizeAriaLabel?: string;
  resizeTitle?: string;
  backdropClassName?: string;
  resizerClassName?: string;
  children?: ReactNode;
}

export function WorkbenchRightDock({
  dock,
  ariaLabel,
  immersive = false,
  disableResize = false,
  resizeAriaLabel = "Resize right panel",
  resizeTitle,
  className,
  backdropClassName,
  resizerClassName,
  children,
  ...rest
}: WorkbenchRightDockProps) {
  const effectiveOpen = immersive || dock.dockOpen;
  const effectiveOverlay = !immersive && dock.isOverlay;

  return (
    <>
      {!immersive && dock.backdropPresence.mounted && (
        <div
          className={joinClasses("workbench-dock-backdrop", backdropClassName)}
          data-dock-backdrop=""
          data-motion-state={dock.backdropPresence.state}
          data-state={dock.backdropPresence.state}
          aria-hidden="true"
          onClick={() => dock.closeDock({ restoreFocus: true })}
        />
      )}
      <aside
        id={dock.dockId}
        role={effectiveOverlay ? "dialog" : undefined}
        aria-modal={effectiveOverlay && effectiveOpen ? "true" : undefined}
        aria-label={ariaLabel}
        className={joinClasses("workbench-right-dock", className)}
        data-workbench-dock=""
        data-dock-open={effectiveOpen ? "true" : undefined}
        data-dock-state={effectiveOpen ? "open" : "closed"}
        data-immersive={immersive ? "true" : undefined}
        data-overlay={effectiveOverlay ? "true" : undefined}
        aria-hidden={!effectiveOpen || undefined}
        inert={!effectiveOpen || undefined}
        {...rest}
      >
        {!immersive && !effectiveOverlay && effectiveOpen && !disableResize && (
          <div
            className={joinClasses("workbench-dock-resizer", resizerClassName)}
            role="separator"
            aria-orientation="vertical"
            aria-label={resizeAriaLabel}
            title={resizeTitle}
            onPointerDown={dock.handleResizeStart}
            onDoubleClick={dock.resetCustomWidth}
          />
        )}
        {children}
      </aside>
    </>
  );
}
