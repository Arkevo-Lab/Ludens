"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ActivityBlock } from "@/features/live/activity-feed-model";
import type { StreamSegment } from "@/features/live/shiori-segments";

export const BOTTOM_REATTACH_THRESHOLD_PX = 36;
export const BOTTOM_DETACH_MIN_DISTANCE_PX = 44;

export interface ScrollViewportMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function computeBottomDistance(metrics: ScrollViewportMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export interface ScrollFollowTransitionInput {
  currentlyFollowing: boolean;
  manualHold: boolean;
  prevScrollTop: number | null;
  currentScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isProgrammatic: boolean;
  hasUpwardUserIntent: boolean;
}

export interface ScrollFollowTransitionResult {
  nextFollowing: boolean;
  nextManualHold: boolean;
  bottomDistance: number;
  scrolledUp: boolean;
}

/**
 * Pure state transition for smart stick-to-bottom behavior:
 * - Content height growing below the fold NEVER detaches `currentlyFollowing`.
 * - Detach happens ONLY when explicit upward user intent or genuine upward `scrollTop` motion moves past threshold.
 * - Re-attach happens automatically when the user scrolls back within `BOTTOM_REATTACH_THRESHOLD_PX` of the bottom
 *   (unless `manualHold` was armed at the bottom and the user has not scrolled away first).
 */
export function evaluateScrollFollowTransition(
  input: ScrollFollowTransitionInput,
): ScrollFollowTransitionResult {
  const bottomDistance = computeBottomDistance({
    scrollHeight: input.scrollHeight,
    scrollTop: input.currentScrollTop,
    clientHeight: input.clientHeight,
  });
  const scrolledUp =
    input.prevScrollTop !== null && input.currentScrollTop < input.prevScrollTop - 3;

  if (input.isProgrammatic) {
    return {
      nextFollowing: input.currentlyFollowing,
      nextManualHold: input.manualHold,
      bottomDistance,
      scrolledUp: false,
    };
  }

  if (input.currentlyFollowing) {
    if (
      (input.hasUpwardUserIntent || scrolledUp) &&
      bottomDistance > BOTTOM_DETACH_MIN_DISTANCE_PX
    ) {
      return {
        nextFollowing: false,
        nextManualHold: false,
        bottomDistance,
        scrolledUp,
      };
    }
    return {
      nextFollowing: true,
      nextManualHold: false,
      bottomDistance,
      scrolledUp,
    };
  }

  // Clear `manualHold` once the user actually scrolls away from the bottom zone so scrolling back down re-attaches naturally.
  const nextManualHold =
    input.manualHold && bottomDistance <= BOTTOM_DETACH_MIN_DISTANCE_PX;

  if (
    !nextManualHold &&
    !input.hasUpwardUserIntent &&
    bottomDistance <= BOTTOM_REATTACH_THRESHOLD_PX
  ) {
    return {
      nextFollowing: true,
      nextManualHold: false,
      bottomDistance,
      scrolledUp,
    };
  }

  return {
    nextFollowing: false,
    nextManualHold,
    bottomDistance,
    scrolledUp,
  };
}

export interface TailSignatureInput {
  run: string;
  blocks: readonly ActivityBlock[];
  segments: readonly StreamSegment[];
  poolLatestSeq?: number;
  thinking?: boolean;
  consolidating?: boolean;
}

/**
 * Computes a compact signature that changes whenever new tail content or streaming token updates arrive,
 * while remaining invariant when older history blocks/runs are prepended at the top of the stream.
 */
export function computeTailActivitySignature(input: TailSignatureInput): string {
  const lastBlock = input.blocks.at(-1);
  const blockSig = lastBlock
    ? `${lastBlock.id}:${lastBlock.status ?? ""}:${lastBlock.text?.length ?? 0}:${lastBlock.tool?.result ? 1 : 0}:${lastBlock.at}`
    : "empty";

  const lastSeg = input.segments.at(-1);
  let segSig = "none";
  if (lastSeg) {
    if (lastSeg.kind === "turn") {
      const lastStep = lastSeg.steps.at(-1);
      segSig = `t:${lastSeg.id}:${lastSeg.steps.length}:${lastSeg.responseBlock?.id ?? ""}:${lastSeg.responseText?.length ?? 0}:${lastStep?.id ?? ""}:${lastStep?.status ?? ""}:${lastStep?.text?.length ?? 0}`;
    } else if (lastSeg.kind === "user") {
      segSig = `u:${lastSeg.id}:${lastSeg.text.length}:${lastSeg.poolEvent?.status ?? ""}`;
    } else if (lastSeg.kind === "outbound_event") {
      segSig = `o:${lastSeg.id}:${lastSeg.event.status}:${lastSeg.event.text.length}`;
    } else if (lastSeg.kind === "input") {
      segSig = `i:${lastSeg.id}:${lastSeg.observations.length}`;
    } else {
      segSig = `${lastSeg.kind}:${lastSeg.id}`;
    }
  }

  return `${input.run}|${blockSig}|${segSig}|p:${input.poolLatestSeq ?? 0}|t:${input.thinking ? 1 : 0}|c:${input.consolidating ? 1 : 0}`;
}

export interface TailPauseBaseline {
  run: string;
  anchorBlockId: string | null;
  anchorMs: number;
  seenIds: Set<string>;
}

export function createTailPauseBaseline(
  run: string,
  blocks: readonly Pick<ActivityBlock, "id" | "at">[],
): TailPauseBaseline {
  const lastBlock = blocks.at(-1);
  const parsedMs = lastBlock ? Date.parse(lastBlock.at) : NaN;
  return {
    run,
    anchorBlockId: lastBlock?.id ?? null,
    anchorMs: Number.isFinite(parsedMs) ? parsedMs : -Infinity,
    seenIds: new Set(blocks.map(b => b.id)),
  };
}

/**
 * Counts blocks that arrived strictly at the tail AFTER `baseline` was captured,
 * ignoring historical blocks prepended above `anchorBlockId` during upward pagination.
 */
export function countNewTailBlocks(
  baseline: TailPauseBaseline,
  currentRun: string,
  blocks: readonly Pick<ActivityBlock, "id" | "at">[],
): number {
  if (blocks.length === 0) return 0;

  if (baseline.run !== currentRun) {
    let count = 0;
    for (const block of blocks) {
      if (!baseline.seenIds.has(block.id)) count += 1;
    }
    return count;
  }

  if (baseline.anchorBlockId !== null) {
    const anchorIdx = blocks.findIndex(b => b.id === baseline.anchorBlockId);
    if (anchorIdx >= 0) {
      let count = 0;
      for (let i = anchorIdx + 1; i < blocks.length; i += 1) {
        if (!baseline.seenIds.has(blocks[i]!.id)) {
          count += 1;
        }
      }
      return count;
    }
  }

  let count = 0;
  for (const block of blocks) {
    if (baseline.seenIds.has(block.id)) continue;
    const blockMs = Date.parse(block.at);
    if (!Number.isFinite(baseline.anchorMs) || baseline.anchorMs === -Infinity) {
      count += 1;
    } else if (Number.isFinite(blockMs) && blockMs >= baseline.anchorMs) {
      count += 1;
    }
  }
  return count;
}

export interface UseLiveAutoScrollOptions {
  project: string;
  run: string;
  blocks: readonly ActivityBlock[];
  segments: readonly StreamSegment[];
  olderRunsCount: number;
  loadingOlder?: boolean;
  loadingOlderRun?: boolean;
  historical: boolean;
  loading: boolean;
  poolLatestSeq?: number;
  thinking?: boolean;
  consolidating?: boolean;
  onNearTopScrollUp?: () => void;
  onReachedBottom?: () => void;
  onScrolledAwayFromBottom?: (container: HTMLDivElement) => void;
}

export function useLiveAutoScroll(options: UseLiveAutoScrollOptions) {
  const {
    project,
    run,
    blocks,
    segments,
    olderRunsCount,
    loadingOlder = false,
    loadingOlderRun = false,
    historical,
    loading,
    poolLatestSeq = 0,
    thinking = false,
    consolidating = false,
    onNearTopScrollUp,
    onReachedBottom,
    onScrolledAwayFromBottom,
  } = options;

  const streamRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [isFollowing, setIsFollowingState] = useState(true);
  const isFollowingRef = useRef(true);
  const manualHoldRef = useRef(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const pauseBaselineRef = useRef<TailPauseBaseline | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const runRef = useRef(run);
  runRef.current = run;

  const prependScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const isJumpingRef = useRef(false);
  const lastScrollTopRef = useRef<number | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const upwardIntentUntilRef = useRef(0);
  const scrollbarDragRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const suppressResizePinUntilRef = useRef(0);
  const lastContentHeightRef = useRef<number | null>(null);

  const applyFollowing = useCallback((next: boolean, options?: { manualHold?: boolean }) => {
    if (options?.manualHold !== undefined) {
      manualHoldRef.current = options.manualHold;
    } else if (next) {
      manualHoldRef.current = false;
    }

    if (isFollowingRef.current === next) {
      if (next) {
        pauseBaselineRef.current = null;
        setUnreadCount(0);
      }
      return;
    }

    isFollowingRef.current = next;
    setIsFollowingState(next);

    if (next) {
      pauseBaselineRef.current = null;
      setUnreadCount(0);
    } else {
      pauseBaselineRef.current = createTailPauseBaseline(runRef.current, blocksRef.current);
      setUnreadCount(0);
    }
  }, []);

  const markProgrammaticScroll = useCallback((durationMs: number) => {
    programmaticScrollUntilRef.current = Math.max(
      programmaticScrollUntilRef.current,
      Date.now() + durationMs,
    );
  }, []);

  const pinToBottomImmediate = useCallback(() => {
    if (scrollbarDragRef.current || Date.now() < upwardIntentUntilRef.current) {
      return;
    }
    const el = streamRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - targetTop) > 1) {
      markProgrammaticScroll(140);
      el.scrollTop = el.scrollHeight;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, [markProgrammaticScroll]);

  // Reset follow state on workspace switch
  useEffect(() => {
    lastScrollTopRef.current = null;
    lastContentHeightRef.current = null;
    prependScrollAnchorRef.current = null;
    isJumpingRef.current = false;
    upwardIntentUntilRef.current = 0;
    scrollbarDragRef.current = false;
    applyFollowing(true, { manualHold: false });
  }, [project, applyFollowing]);

  // Clear scrollbar drag flag globally on pointer release
  useEffect(() => {
    const clearPointerDrag = () => {
      scrollbarDragRef.current = false;
    };
    window.addEventListener("pointerup", clearPointerDrag, { passive: true });
    window.addEventListener("pointercancel", clearPointerDrag, { passive: true });
    return () => {
      window.removeEventListener("pointerup", clearPointerDrag);
      window.removeEventListener("pointercancel", clearPointerDrag);
    };
  }, []);

  const capturePrependAnchor = useCallback(() => {
    const el = streamRef.current;
    if (el && !isFollowingRef.current && !isJumpingRef.current) {
      prependScrollAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
    }
  }, []);

  const headAnchorSignature = `${olderRunsCount}|${blocks[0]?.id ?? ""}|${segments[0]?.id ?? ""}|${segments.length}|${blocks.length}`;

  // Preserve reading position when prepending earlier history or older run segments
  useLayoutEffect(() => {
    const anchor = prependScrollAnchorRef.current;
    const el = streamRef.current;
    if (!anchor || !el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta !== 0) {
      markProgrammaticScroll(300);
      el.scrollTop = Math.max(0, anchor.scrollTop + delta);
      lastScrollTopRef.current = el.scrollTop;
      prependScrollAnchorRef.current = null;
    } else if (!loadingOlder && !loadingOlderRun) {
      prependScrollAnchorRef.current = null;
    }
  }, [headAnchorSignature, blocks, segments, loadingOlder, loadingOlderRun, markProgrammaticScroll]);

  const tailSignature = useMemo(
    () =>
      computeTailActivitySignature({
        run,
        blocks,
        segments,
        poolLatestSeq,
        thinking,
        consolidating,
      }),
    [run, blocks, segments, poolLatestSeq, thinking, consolidating],
  );

  // Auto-pin when tail content updates while following (and once initial loading finishes)
  useLayoutEffect(() => {
    if (!isFollowing || historical || isJumpingRef.current || prependScrollAnchorRef.current) {
      return;
    }
    pinToBottomImmediate();
  }, [tailSignature, isFollowing, historical, loading, pinToBottomImmediate]);

  // Update unread count when paused and new tail blocks arrive
  useEffect(() => {
    if (isFollowing) {
      if (unreadCount !== 0) setUnreadCount(0);
      return;
    }
    if (!pauseBaselineRef.current) {
      pauseBaselineRef.current = createTailPauseBaseline(run, blocks);
      return;
    }
    const nextUnread = countNewTailBlocks(pauseBaselineRef.current, run, blocks);
    setUnreadCount(prev => (prev === nextUnread ? prev : nextUnread));
  }, [isFollowing, run, blocks, tailSignature, unreadCount]);

  // Keep pinned to bottom when async media / multi-line layout grows `.codex-chat-column`
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      const nextHeight = entry?.contentRect.height ?? contentEl.offsetHeight;
      const prevHeight = lastContentHeightRef.current;
      lastContentHeightRef.current = nextHeight;

      if (
        !isFollowingRef.current ||
        historical ||
        isJumpingRef.current ||
        prependScrollAnchorRef.current ||
        Date.now() < suppressResizePinUntilRef.current
      ) {
        return;
      }

      if (prevHeight === null || nextHeight !== prevHeight) {
        pinToBottomImmediate();
      }
    });

    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [historical, pinToBottomImmediate]);

  const scrollToBottom = useCallback(
    (opts?: { behavior?: ScrollBehavior; onBeforeScroll?: () => void }) => {
      opts?.onBeforeScroll?.();
      isJumpingRef.current = false;
      upwardIntentUntilRef.current = 0;
      applyFollowing(true, { manualHold: false });
      onReachedBottom?.();

      const el = streamRef.current;
      if (!el) return;
      const behavior = opts?.behavior ?? "smooth";
      const distance = computeBottomDistance({
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
      });

      if (behavior === "instant" || distance <= 4) {
        markProgrammaticScroll(200);
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
        return;
      }

      markProgrammaticScroll(850);
      if (distance > 2200) {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 520);
        requestAnimationFrame(() => {
          markProgrammaticScroll(850);
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    },
    [applyFollowing, markProgrammaticScroll, onReachedBottom],
  );

  const pauseFollow = useCallback(
    (opts?: { manualHold?: boolean }) => {
      applyFollowing(false, { manualHold: opts?.manualHold ?? true });
    },
    [applyFollowing],
  );

  const toggleFollow = useCallback(
    (onResumeBeforeScroll?: () => void) => {
      if (isFollowingRef.current && !historical) {
        pauseFollow({ manualHold: true });
      } else {
        scrollToBottom({ behavior: "smooth", onBeforeScroll: onResumeBeforeScroll });
      }
    },
    [historical, pauseFollow, scrollToBottom],
  );

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -1) {
      upwardIntentUntilRef.current = Date.now() + 450;
      programmaticScrollUntilRef.current = 0;
    } else if (event.deltaY > 1) {
      upwardIntentUntilRef.current = 0;
      manualHoldRef.current = false;
    }
  }, []);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY == null || currentY == null) return;
    const deltaY = currentY - startY;
    if (deltaY > 5) {
      // Finger moving down = scrolling content up toward earlier messages
      upwardIntentUntilRef.current = Date.now() + 500;
      programmaticScrollUntilRef.current = 0;
    } else if (deltaY < -5) {
      upwardIntentUntilRef.current = 0;
      manualHoldRef.current = false;
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const el = streamRef.current;
    if (!el) return;

    // Detect native scrollbar thumb/track interaction on the right edge of the scroll container
    if (event.target === el) {
      const rect = el.getBoundingClientRect();
      if (event.clientX >= rect.right - 22) {
        scrollbarDragRef.current = true;
        programmaticScrollUntilRef.current = 0;
      }
    }
  }, []);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const el = streamRef.current;
    if (!el || !(event.target instanceof Element)) return;
    // Covers pointer clicks (including nested SVG icons) and keyboard Enter/Space activation on step-group toggles
    const stepToggle = event.target.closest("[data-step-group-toggle]");
    if (stepToggle instanceof HTMLElement) {
      const containerRect = el.getBoundingClientRect();
      const toggleRect = stepToggle.getBoundingClientRect();
      if (containerRect.bottom - toggleRect.bottom > 150) {
        suppressResizePinUntilRef.current = Date.now() + 340;
      }
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) {
          return;
        }
      }
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
        upwardIntentUntilRef.current = Date.now() + 450;
        programmaticScrollUntilRef.current = 0;
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        upwardIntentUntilRef.current = 0;
        manualHoldRef.current = false;
      } else if (event.key === "End") {
        scrollToBottom({ behavior: "smooth" });
      }
    },
    [scrollToBottom],
  );

  const handleScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;

    const prevScrollTop = lastScrollTopRef.current;
    const currentScrollTop = el.scrollTop;
    lastScrollTopRef.current = currentScrollTop;

    const now = Date.now();
    const isProgrammatic = now < programmaticScrollUntilRef.current;
    const hasUpwardUserIntent =
      scrollbarDragRef.current || now < upwardIntentUntilRef.current;

    const transition = evaluateScrollFollowTransition({
      currentlyFollowing: isFollowingRef.current,
      manualHold: manualHoldRef.current,
      prevScrollTop,
      currentScrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      isProgrammatic,
      hasUpwardUserIntent,
    });

    manualHoldRef.current = transition.nextManualHold;
    applyFollowing(transition.nextFollowing, { manualHold: transition.nextManualHold });

    if (isProgrammatic) return;

    if (transition.nextFollowing) {
      onReachedBottom?.();
    } else {
      onScrolledAwayFromBottom?.(el);
    }

    const scrollingUp = prevScrollTop === null || currentScrollTop < prevScrollTop;
    if (scrollingUp && currentScrollTop < 280) {
      onNearTopScrollUp?.();
    }
  }, [applyFollowing, onNearTopScrollUp, onReachedBottom, onScrolledAwayFromBottom]);

  const scrollContainerProps = useMemo(
    () => ({
      onScroll: handleScroll,
      onWheel: handleWheel,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onPointerDown: handlePointerDown,
      onClickCapture: handleClickCapture,
      onKeyDown: handleKeyDown,
    }),
    [
      handleScroll,
      handleWheel,
      handleTouchStart,
      handleTouchMove,
      handlePointerDown,
      handleClickCapture,
      handleKeyDown,
    ],
  );

  return {
    streamRef,
    contentRef,
    isFollowing,
    isFollowingRef,
    unreadCount,
    isJumpingRef,
    prependScrollAnchorRef,
    capturePrependAnchor,
    markProgrammaticScroll,
    scrollToBottom,
    pauseFollow,
    toggleFollow,
    scrollContainerProps,
  };
}
