"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchiveBuildState } from "@/lib/archive-client";
import { useTranslations } from "@/lib/locale";
import { useLudensEvent, useOptionalLudensRpc } from "@/lib/ludens-rpc";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const stages: Record<string, string> = {
  queued: "stageQueued",
  snapshot: "stageSnapshot",
  events: "stageEvents",
  projections: "stageProjections",
  operations: "stageOperations",
  write: "stageWrite",
  ready: "stageReady",
};
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + " MiB";

/** Observes archive build state over RPC without starting a build. */
export function ArchiveBuild({ project, run, onReady }: { project: string; run: string; onReady(): void }) {
  const t = useTranslations("archiveBuild");
  const rpcCtx = useOptionalLudensRpc();
  const [state, setState] = useState<ArchiveBuildState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const scope = project + "/" + run;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const current = useRef<ArchiveBuildState | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const reconnectGen = rpcCtx?.snapshot.reconnectGeneration ?? 0;

  useEffect(() => {
    setState(null);
    setError("");
    setBusy(false);
    current.current = null;
  }, [project, run]);

  const rpcCall = rpcCtx?.call;
  useEffect(() => {
    if (!project || !run || !rpcCall) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const next = (await rpcCall(
          "archive/build",
          { project, run },
          { signal: abort.signal },
        )) as unknown as ArchiveBuildState | null;
        if (abort.signal.aborted) return;
        const previous = current.current;
        current.current = next;
        setState(next);
        setError("");
        if (next?.state === "ready" && previous && (previous.id !== next.id || previous.state !== "ready")) {
          onReadyRef.current();
        }
        if (next && (next.state === "queued" || next.state === "building")) {
          timer = setTimeout(() => {
            if (!abort.signal.aborted) {
              void load();
            }
          }, 1000);
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void load();
    return () => {
      abort.abort();
      mutation.current?.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [project, run, rpcCall, refreshTick, reconnectGen]);

  const triggerRefresh = useCallback(() => {
    setRefreshTick(v => v + 1);
  }, []);

  useLudensEvent("run", triggerRefresh, {
    enabled: Boolean(project && run),
    workspaceId: project,
    runId: run,
  });

  async function control(action: "cancel" | "retry") {
    if (!state || busy || !rpcCtx) return;
    mutation.current?.abort();
    const abort = (mutation.current = new AbortController());
    setBusy(true);
    setError("");
    try {
      const next = (await rpcCtx.call(
        "archive/build",
        { project, run, action, buildId: state.id },
        { signal: abort.signal },
      )) as unknown as ArchiveBuildState | null;
      if (!abort.signal.aborted && currentScope.current === scope) {
        current.current = next;
        setState(next);
        setRefreshTick(v => v + 1);
      }
    } catch (e) {
      if (!abort.signal.aborted && currentScope.current === scope) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!abort.signal.aborted && currentScope.current === scope) setBusy(false);
    }
  }

  if (!state || state.state === "ready") {
    return error ? (
      <Alert variant="destructive">
        <AlertDescription>{t("statusPrefix")}{error}</AlertDescription>
      </Alert>
    ) : null;
  }

  const working = state.state === "queued" || state.state === "building";
  const stageKey = stages[state.stage ?? ""];
  return (
    <div className="archive-build" role="status">
      <div>
        <strong>
          {working
            ? state.state === "queued"
              ? t("waitingTitle")
              : t("buildingTitle")
            : state.state === "cancelled"
              ? t("cancelledTitle")
              : t("failedTitle")}
        </strong>
        <p>
          {working
            ? `${stageKey ? t(stageKey) : t("stageFallback")}${
                state.totalBytes ? ` · ${mib(state.bytes ?? 0)} / ${mib(state.totalBytes)}` : ""
              }${state.eventPosition ? ` · ${state.eventPosition.toLocaleString()}${t("eventsSuffix")}` : ""}`
            : state.error ?? t("retryHint")}
        </p>
        {error && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void control(working ? "cancel" : "retry")}
      >
        {busy ? t("processing") : working ? t("cancel") : t("retry")}
      </Button>
    </div>
  );
}
