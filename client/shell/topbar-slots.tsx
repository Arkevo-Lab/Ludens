"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type TopbarSlotName = "primary" | "actions" | "dockToggle";

interface TopbarSlotRegistry {
  containers: Record<TopbarSlotName, HTMLElement | null>;
  counts: Record<TopbarSlotName, number>;
  setContainer: (slot: TopbarSlotName, el: HTMLElement | null) => void;
  registerMount: (slot: TopbarSlotName) => () => void;
}

const TopbarSlotContext = createContext<TopbarSlotRegistry | null>(null);

export function TopbarSlotProvider({ children }: { children: ReactNode }) {
  const [containers, setContainers] = useState<Record<TopbarSlotName, HTMLElement | null>>({
    primary: null,
    actions: null,
    dockToggle: null,
  });
  const [counts, setCounts] = useState<Record<TopbarSlotName, number>>({
    primary: 0,
    actions: 0,
    dockToggle: 0,
  });

  const setContainer = useCallback((slot: TopbarSlotName, el: HTMLElement | null) => {
    setContainers(prev => (prev[slot] === el ? prev : { ...prev, [slot]: el }));
  }, []);

  const registerMount = useCallback((slot: TopbarSlotName) => {
    setCounts(prev => ({ ...prev, [slot]: prev[slot] + 1 }));
    return () => {
      setCounts(prev => ({ ...prev, [slot]: Math.max(0, prev[slot] - 1) }));
    };
  }, []);

  const value = useMemo<TopbarSlotRegistry>(
    () => ({ containers, counts, setContainer, registerMount }),
    [containers, counts, setContainer, registerMount],
  );

  return <TopbarSlotContext.Provider value={value}>{children}</TopbarSlotContext.Provider>;
}

/** Used by the shell top bar to expose portal mount targets and query whether a slot is occupied. */
export function useTopbarSlotHost() {
  const ctx = useContext(TopbarSlotContext);
  const setContainer = ctx?.setContainer;
  const bindPrimary = useCallback(
    (el: HTMLElement | null) => setContainer?.("primary", el),
    [setContainer],
  );
  const bindActions = useCallback(
    (el: HTMLElement | null) => setContainer?.("actions", el),
    [setContainer],
  );
  const bindDockToggle = useCallback(
    (el: HTMLElement | null) => setContainer?.("dockToggle", el),
    [setContainer],
  );

  return {
    bindPrimary,
    bindActions,
    bindDockToggle,
    hasPrimary: Boolean(ctx && ctx.counts.primary > 0),
    hasActions: Boolean(ctx && ctx.counts.actions > 0),
    hasDockToggle: Boolean(ctx && ctx.counts.dockToggle > 0),
  };
}

/**
 * Declaratively portal view-specific controls into the unified single-row top bar.
 * When rendered outside a TopbarSlotProvider (e.g. isolated unit tests), renders nothing
 * unless `renderFallback` is explicitly provided.
 */
export function TopbarSlot({
  slot,
  children,
  active = true,
  renderFallback = false,
}: {
  slot: TopbarSlotName;
  children: ReactNode;
  active?: boolean;
  renderFallback?: boolean;
}) {
  const ctx = useContext(TopbarSlotContext);
  const registerMount = ctx?.registerMount;

  useEffect(() => {
    if (!registerMount || !active) return;
    return registerMount(slot);
  }, [registerMount, slot, active]);

  if (!active) return null;
  if (!ctx) {
    return renderFallback ? <>{children}</> : null;
  }
  const container = ctx.containers[slot];
  if (!container) return null;
  return createPortal(children, container);
}
