"use client";
import { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdvancedDiagnosticsDisclosure,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-primitives";
import { useTranslations } from "@/lib/locale";
import type { PerceptionRuntimeSnapshot } from "@/lib/perception-config";
import { PERCEPTION_KEYS, type SavedPerception } from "@/features/capabilities/perception-draft";

export function PerceptionRuntimeStatus({ project, workspace, settings, revision, saving }: {
  project: string; workspace: string; settings: SavedPerception | null; revision: number; saving: boolean;
}) {
  const t = useTranslations("perceptionSettings");
  const [result, setResult] = useState<{ value: PerceptionRuntimeSnapshot; revision: number } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const check = async () => {
    if (request.current || saving) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/perception-config/runtime?" + new URLSearchParams({ project, workspace }),
        { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted && request.current === controller) { setResult({ value, revision }); setError(""); }
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setLoading(false); } }
  };
  useEffect(() => {
    void check();
    return () => { const controller = request.current; request.current = null; controller?.abort(); };
  }, [project, workspace]);
  const perception = result?.value.perception, values = perception?.values;
  const stale = !!result && (result.revision !== revision || !!error);
  const current = perception?.valueStatus === "current" && !stale;
  const overrides = PERCEPTION_KEYS.filter(key => settings?.[key] !== undefined);
  const matching = current && overrides.length > 0 && overrides.every(key => settings?.[key] === values?.[key]);
  const status = !result ? "runtimeUnchecked" : stale ? "runtimeStale"
    : result.value.connection === "unavailable" ? "runtimeUnavailable"
      : current ? !settings ? "runtimeSavedUnknown" : overrides.length ? matching ? "runtimeOverridesMatch" : "runtimeOverridesDiffer" : "runtimeObserved"
        : perception?.valueStatus === "last-loaded" ? "runtimeLastLoaded" : "runtimeNoValues";
  const hasTechnicalDetails = Boolean(error || perception?.error || result);

  return (
    <div className="space-y-4" data-perception-runtime>
      <SettingsSection
        headingLevel={3}
        title={t("runtimeTitle")}
        description={<span role="status">{t(status)}</span>}
        actions={
          <div className="flex items-center gap-2">
            {perception && <Badge variant="outline">{t(`runtimeStates.${perception.state}`)}</Badge>}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={loading || saving}
              className="aria-disabled:opacity-50"
              onClick={() => void check()}
            >
              {loading
                ? <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                : <Activity className="size-3.5" aria-hidden="true" />}
              {t(loading ? "checkingRuntime" : "checkRuntime")}
            </Button>
          </div>
        }
      >
        {values ? (
          PERCEPTION_KEYS.map(key => (
            <SettingsRow
              key={key}
              label={t(`limits.${key}.label`)}
              control={
                <span className="font-mono text-sm tabular-nums text-foreground">
                  {values[key]} {t("seconds")}
                </span>
              }
            />
          ))
        ) : (
          <SettingsRow
            label={t("runtimeTitle")}
            description={t("runtimeReadOnly")}
            control={
              <span className="text-xs text-muted-foreground">
                {perception ? t(`runtimeStates.${perception.state}`) : "—"}
              </span>
            }
          />
        )}
      </SettingsSection>

      {error && (
        <Alert variant="destructive" className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
          <AlertDescription>
            <p>{t("runtimeReadFailed")}</p>
          </AlertDescription>
        </Alert>
      )}

      {hasTechnicalDetails && (
        <AdvancedDiagnosticsDisclosure summary={t("errorDetails")}>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>{t("runtimeReadOnly")}</p>
            {result && (
              <p>
                {t("checkedAt")}{" "}
                <time dateTime={result.value.checkedAt}>
                  {new Date(result.value.checkedAt).toLocaleTimeString()}
                </time>
              </p>
            )}
            {error && <p className="break-all font-mono text-destructive">{error}</p>}
            {perception?.error && <p className="break-all font-mono">{perception.error}</p>}
          </div>
        </AdvancedDiagnosticsDisclosure>
      )}
    </div>
  );
}
