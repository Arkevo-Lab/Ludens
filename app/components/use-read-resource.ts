"use client";

import type { LudensEventTopic } from "@ludens/protocol/app-rpc";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";

interface ReadState<T> {
  key: string;
  value?: T;
  error: string;
  loading: boolean;
}

export interface UseReadResourceOptions {
  readonly refreshOnEvents?: readonly LudensEventTopic[];
  readonly workspaceId?: string;
  readonly runId?: string;
}

/** A retryable RPC read whose cached value is separate from any editor draft or write. */
export function useReadResource<T>(
  key: string | null,
  reader: ((signal: AbortSignal) => Promise<T>) | null,
  fallback: string,
  options?: UseReadResourceOptions,
) {
  const rpcCtx = useOptionalLudensRpc();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<ReadState<T> | null>(null);
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  const readFailure = useRef(fallback);
  readFailure.current = fallback;
  const readerRef = useRef(reader);
  readerRef.current = reader;

  const reconnectGen = rpcCtx?.snapshot.reconnectGeneration ?? 0;

  useEffect(() => {
    if (!key || !readerRef.current) return;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      request.current === controller &&
      currentKey.current === key;

    setLoaded(previous => ({
      key,
      value: previous?.key === key ? previous.value : undefined,
      error: previous?.key === key ? previous.error : "",
      loading: true,
    }));

    void (async () => {
      try {
        const value = await readerRef.current!(controller.signal);
        if (isCurrent()) setLoaded({ key, value, error: "", loading: false });
      } catch (error) {
        if (isCurrent()) {
          setLoaded(previous => ({
            key,
            value: previous?.key === key ? previous.value : undefined,
            error:
              error instanceof Error && error.message
                ? error.message
                : readFailure.current,
            loading: false,
          }));
        }
      }
    })();

    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [key, revision, reconnectGen]);

  useLudensEvent(
    options?.refreshOnEvents ?? [],
    () => {
      if (key) {
        setRevision(value => value + 1);
      }
    },
    {
      enabled: Boolean(key && options?.refreshOnEvents?.length),
      workspaceId: options?.workspaceId,
      runId: options?.runId,
    },
  );

  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setLoaded(previous =>
      previous?.key === key ? { ...previous, loading: false } : previous,
    );
  }, [key]);

  const retry = useCallback(() => {
    if (!key) return;
    cancel();
    setRevision(value => value + 1);
  }, [key, cancel]);

  // A successful mutation is authoritative. A pre-write read may never replace it.
  const replace = useCallback(
    (value: T) => {
      cancel();
      if (key) setLoaded({ key, value, error: "", loading: false });
    },
    [key, cancel],
  );

  const current = loaded?.key === key ? loaded : null;
  return {
    value: current?.value,
    error: current?.error ?? "",
    loading: !!key && (!current || current.loading),
    retry,
    cancel,
    replace,
  };
}
