"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export type InfoVerbosityLevel = 1 | 2 | 3 | 4 | 5;

export const INFO_VERBOSITY_LEVELS: readonly InfoVerbosityLevel[] = [1, 2, 3, 4, 5] as const;
export const DEFAULT_INFO_VERBOSITY: InfoVerbosityLevel = 3;
export const INFO_VERBOSITY_STORAGE_KEY = "ludens:info-verbosity";

export interface LiveVerbosityFlags {
  /** Level 2+: show collapsed/expanded execution step groups */
  showSteps: boolean;
  /** Level 3+: show system status and standby system events */
  showSystemEvents: boolean;
  /** Level 3+: show model input observation cards */
  showModelInputs: boolean;
  /** Level 4+: expand execution step groups by default */
  expandStepsByDefault: boolean;
  /** Level 5: expand system status / standby system events by default */
  expandSystemEventsByDefault: boolean;
  /** Level 5: expand model input payload details by default */
  expandModelInputsByDefault: boolean;
}

export function normalizeInfoVerbosity(raw: unknown): InfoVerbosityLevel {
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (num === 1 || num === 2 || num === 3 || num === 4 || num === 5) return num;
  return DEFAULT_INFO_VERBOSITY;
}

export function getLiveVerbosityFlags(level: InfoVerbosityLevel): LiveVerbosityFlags {
  return {
    showSteps: level >= 2,
    showSystemEvents: level >= 3,
    showModelInputs: level >= 3,
    expandStepsByDefault: level >= 4,
    expandSystemEventsByDefault: level >= 5,
    expandModelInputsByDefault: level >= 5,
  };
}

let memoryLevel: InfoVerbosityLevel | null = null;
const listeners = new Set<() => void>();

function readStoredLevel(): InfoVerbosityLevel {
  if (memoryLevel !== null) return memoryLevel;
  if (typeof window === "undefined") return DEFAULT_INFO_VERBOSITY;
  try {
    const raw = window.localStorage.getItem(INFO_VERBOSITY_STORAGE_KEY);
    memoryLevel = raw == null ? DEFAULT_INFO_VERBOSITY : normalizeInfoVerbosity(raw);
    return memoryLevel;
  } catch {
    return DEFAULT_INFO_VERBOSITY;
  }
}

export function setInfoVerbosity(next: InfoVerbosityLevel): void {
  const normalized = normalizeInfoVerbosity(next);
  memoryLevel = normalized;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(INFO_VERBOSITY_STORAGE_KEY, String(normalized));
    } catch {
      // Ignore storage quota / privacy mode errors; in-memory state still updates.
    }
  }
  for (const listener of listeners) listener();
}

/** Test-only helper to reset the cached in-memory verbosity level. */
export function resetInfoVerbosityCache(): void {
  memoryLevel = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInfoVerbosity() {
  const level = useSyncExternalStore(
    subscribe,
    readStoredLevel,
    () => DEFAULT_INFO_VERBOSITY,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== INFO_VERBOSITY_STORAGE_KEY) return;
      memoryLevel = event.newValue == null ? DEFAULT_INFO_VERBOSITY : normalizeInfoVerbosity(event.newValue);
      for (const listener of listeners) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLevel = useCallback((next: InfoVerbosityLevel) => {
    setInfoVerbosity(next);
  }, []);

  const flags = useMemo(() => getLiveVerbosityFlags(level), [level]);

  return { level, setLevel, flags };
}
