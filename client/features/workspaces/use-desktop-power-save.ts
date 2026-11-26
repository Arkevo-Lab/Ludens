"use client";

import { useCallback, useEffect, useState } from "react";
import type { DesktopPowerBridge, DesktopPowerState } from "@/lib/desktop";

const DEFAULT_POWER_STATE: DesktopPowerState = {
  preventAppSuspension: true,
  blocking: false,
  activeCoreCount: 0,
};

export interface UseDesktopPowerSaveResult {
  available: boolean;
  loading: boolean;
  saving: boolean;
  state: DesktopPowerState;
  error: string | null;
  setPreventAppSuspension(enabled: boolean): Promise<void>;
}

function getDesktopPowerBridge(): DesktopPowerBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.ludens?.power;
  if (
    !bridge ||
    typeof bridge.getState !== "function" ||
    typeof bridge.setPreventAppSuspension !== "function" ||
    typeof bridge.onState !== "function"
  ) {
    return null;
  }
  return bridge;
}

export function useDesktopPowerSave(): UseDesktopPowerSaveResult {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<DesktopPowerState>(DEFAULT_POWER_STATE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = getDesktopPowerBridge();
    if (!bridge) {
      setAvailable(false);
      setLoading(false);
      return;
    }
    setAvailable(true);
    let active = true;
    const unsubscribe = bridge.onState(next => {
      if (!active || !next || typeof next !== "object") return;
      setState(next);
    });
    void bridge
      .getState()
      .then(next => {
        if (!active) return;
        setState(next);
        setError(null);
      })
      .catch(err => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const setPreventAppSuspension = useCallback(async (enabled: boolean) => {
    const bridge = getDesktopPowerBridge();
    if (!bridge) return;
    setSaving(true);
    setError(null);
    setState(current => ({ ...current, preventAppSuspension: enabled }));
    try {
      const next = await bridge.setPreventAppSuspension(enabled);
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    available,
    loading,
    saving,
    state,
    error,
    setPreventAppSuspension,
  };
}
