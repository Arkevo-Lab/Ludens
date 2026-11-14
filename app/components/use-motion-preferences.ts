"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * SSR-safe check for `prefers-reduced-motion: reduce`.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Return `"auto"` when the user prefers reduced motion so programmatic
 * `scrollTo` / `scrollIntoView` calls do not bypass CSS reduced-motion rules.
 */
export function prefersSmoothScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/**
 * Subscribe reactively to `(prefers-reduced-motion: reduce)`.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Keep conditional overlays, popovers, and inline drawers mounted long enough
 * for exit animations to play while preserving exact initial/SSR markup.
 */
export function useAnimatedPresence(
  open: boolean,
  exitDurationMs = 160,
): { mounted: boolean; state: "open" | "closed" } {
  const [mounted, setMounted] = useState<boolean>(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (exitDurationMs <= 0 || prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setMounted(false);
    }, exitDurationMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitDurationMs]);

  if (open) {
    return { mounted: true, state: "open" };
  }
  return { mounted, state: "closed" };
}

export interface AnimatedNativeDialogOptions {
  /** Fallback duration (ms) used alongside `transitionend` when closing. */
  closeDurationMs?: number;
  /** Invoked right before `dialog.close()` runs on a programmatic close. */
  onBeforeProgrammaticClose?: () => void;
  /** Disable automatic `showModal()` call (caller invokes `showModal()` itself). */
  manualShowModal?: boolean;
}

/**
 * Coordinate open/close lifecycle and retained content for native top-layer
 * `<dialog>` elements so `@starting-style`, `allow-discrete`, and
 * `[data-closing="true"]` exit transitions run without prematurely blanking children.
 */
export function useAnimatedNativeDialog<T = true>(
  dialogRef: RefObject<HTMLDialogElement | null>,
  payload: T | null | false | undefined,
  options?: AnimatedNativeDialogOptions,
): T | null {
  const closeDurationMs = options?.closeDurationMs ?? 180;
  const manualShowModal = options?.manualShowModal ?? false;
  const onBeforeProgrammaticCloseRef = useRef(options?.onBeforeProgrammaticClose);
  onBeforeProgrammaticCloseRef.current = options?.onBeforeProgrammaticClose;

  const isOpen = Boolean(payload);
  const resolvedPayload: T | null = payload ? (payload as T) : null;
  const [retainedPayload, setRetainedPayload] = useState<T | null>(resolvedPayload);

  useEffect(() => {
    if (isOpen && resolvedPayload !== null) {
      setRetainedPayload(resolvedPayload);
    }
  }, [isOpen, resolvedPayload]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleNativeClose = () => {
      delete dialog.dataset.closing;
    };
    dialog.addEventListener("close", handleNativeClose);
    return () => {
      dialog.removeEventListener("close", handleNativeClose);
    };
  }, [dialogRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      delete dialog.dataset.closing;
      if (!manualShowModal && !dialog.open) {
        dialog.showModal();
      }
      return;
    }

    if (closeDurationMs <= 0 || prefersReducedMotion()) {
      delete dialog.dataset.closing;
      if (dialog.open) {
        onBeforeProgrammaticCloseRef.current?.();
        dialog.close();
      }
      setRetainedPayload(null);
      return;
    }

    let finished = false;
    let fallbackTimer = 0;

    const finishClose = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallbackTimer);
      dialog.removeEventListener("transitionend", onTransitionEnd);
      delete dialog.dataset.closing;
      if (dialog.open) {
        onBeforeProgrammaticCloseRef.current?.();
        dialog.close();
      }
      setRetainedPayload(null);
    };

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === dialog) {
        finishClose();
      }
    };

    if (dialog.open) {
      dialog.dataset.closing = "true";
      dialog.addEventListener("transitionend", onTransitionEnd);
    }

    fallbackTimer = window.setTimeout(
      finishClose,
      dialog.open ? closeDurationMs + 40 : closeDurationMs,
    );

    return () => {
      window.clearTimeout(fallbackTimer);
      dialog.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [dialogRef, isOpen, closeDurationMs, manualShowModal]);

  return resolvedPayload ?? retainedPayload;
}
