"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Cable, Check, CheckCircle2, CloudUpload, Copy, Database, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import {
  DEFAULT_IMAGE_URL_BACKENDS,
  IMAGE_URL_BACKENDS,
  type AppendOnlyContextMode,
  type CacheRetentionMode,
  type ImageUrlBackend,
  type ModelConnectionConfig,
  type OpenaiWebsocketsMode,
} from "@ludens/protocol/connection";
import type { GlobalConnectionResult, WorkspaceConnectionSnapshot, WorkspaceSettings } from "@/lib/workspaces";
import type { Project } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLocale, useTranslations } from "@/lib/locale";

const BACKEND_FAMILY: Record<ImageUrlBackend, "api" | "tunnel" | "host"> = {
  "provider-files": "api",
  cloudflared: "tunnel",
  tailscale: "tunnel",
  pinggy: "tunnel",
  "localhost-run": "tunnel",
  uguu: "host",
  tmpfiles: "host",
  litterbox: "host",
  "0x0": "host",
  catbox: "host",
};

function normalizeConnection(input?: ModelConnectionConfig): ModelConnectionConfig {
  if (!input) return {};
  const imageUrls = {
    ...(input.imageUrls?.enabled !== undefined ? { enabled: input.imageUrls.enabled } : {}),
    ...(input.imageUrls?.backends?.length ? { backends: [...input.imageUrls.backends] } : {}),
  };
  return {
    ...(input.openaiWebsockets !== undefined ? { openaiWebsockets: input.openaiWebsockets } : {}),
    ...(input.cacheRetention !== undefined ? { cacheRetention: input.cacheRetention } : {}),
    ...(input.appendOnlyContext !== undefined ? { appendOnlyContext: input.appendOnlyContext } : {}),
    ...(Object.keys(imageUrls).length > 0 ? { imageUrls } : {}),
  };
}

function sameConnection(a?: ModelConnectionConfig, b?: ModelConnectionConfig): boolean {
  return JSON.stringify(normalizeConnection(a)) === JSON.stringify(normalizeConnection(b));
}

export function reloadWorkspaceHostCommand(workspace: string): string {
  const quoted = `'${workspace.replace(/'/g, "'\\''")}'`;
  return `env -u LUDENS_WORKSPACE -u LUDENS_SOCKET ludens --workspace ${quoted} down --keep-emulator && env -u LUDENS_WORKSPACE -u LUDENS_SOCKET ludens --workspace ${quoted} up`;
}

export function ConnectionSettings({
  projects,
  initialScope = "global",
  onSaved,
}: {
  projects: Project[];
  initialScope?: string;
  onSaved?: () => void;
}) {
  const t = useTranslations("connectionSettings");
  const { locale } = useLocale();
  const titleId = useId();
  const scopeId = useId();
  const wsId = useId();
  const cacheId = useId();
  const appendId = useId();
  const imageModeId = useId();

  const availableProjects = projects.filter(item => item.workspace);
  const [scope, setScope] = useState<string>(initialScope || "global");
  const [saved, setSaved] = useState<ModelConnectionConfig>({});
  const [draft, setDraft] = useState<ModelConnectionConfig>({});
  const [workspaceMeta, setWorkspaceMeta] = useState<{ workspace: string; model: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [reloadTick, setReloadTick] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (initialScope && (initialScope === "global" || availableProjects.some(item => item.id === initialScope))) {
      setScope(initialScope);
    }
  }, [initialScope, availableProjects]);

  useEffect(() => {
    if (scope !== "global" && availableProjects.length > 0 && !availableProjects.some(item => item.id === scope)) {
      setScope("global");
    }
  }, [availableProjects, scope]);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setLoading(true);
    setReadError(null);
    setWriteError(null);
    setJustSaved(false);
    const url = scope === "global"
      ? "/api/workspaces"
      : `/api/workspaces?workspaceId=${encodeURIComponent(scope)}`;
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error ?? t("readFailed"));
        return value;
      })
      .then(value => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        if (scope === "global") {
          const settings = value as WorkspaceSettings;
          const next = normalizeConnection(settings.config.defaults.connection);
          setSaved(next);
          setDraft(next);
          setWorkspaceMeta(null);
        } else {
          const snapshot = value as WorkspaceConnectionSnapshot;
          const next = normalizeConnection(snapshot.connection);
          setSaved(next);
          setDraft(next);
          setWorkspaceMeta({ workspace: snapshot.workspace, model: snapshot.model });
        }
      })
      .catch(error => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setReadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && version === requestVersion.current) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, reloadTick, t]);

  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const dirty = !sameConnection(saved, draft);
  const hasSavedOverrides = Object.keys(normalizeConnection(saved)).length > 0;
  const hasDraftOverrides = Object.keys(normalizeConnection(draft)).length > 0;
  const activeBackends: ImageUrlBackend[] = draft.imageUrls?.backends?.length
    ? draft.imageUrls.backends
    : [...DEFAULT_IMAGE_URL_BACKENDS];

  const updateDraft = (updater: (current: ModelConnectionConfig) => ModelConnectionConfig) => {
    setJustSaved(false);
    setWriteError(null);
    setDraft(current => normalizeConnection(updater(current)));
  };

  const toggleBackend = (backend: ImageUrlBackend, checked: boolean) => {
    updateDraft(current => {
      const list = current.imageUrls?.backends?.length
        ? [...current.imageUrls.backends]
        : [...DEFAULT_IMAGE_URL_BACKENDS];
      const next = checked
        ? (list.includes(backend) ? list : [...list, backend])
        : list.filter(item => item !== backend);
      return {
        ...current,
        imageUrls: {
          ...current.imageUrls,
          enabled: current.imageUrls?.enabled ?? true,
          backends: next.length > 0 ? next : ["uguu"],
        },
      };
    });
  };

  const moveBackend = (backend: ImageUrlBackend, direction: -1 | 1) => {
    updateDraft(current => {
      const list = current.imageUrls?.backends?.length
        ? [...current.imageUrls.backends]
        : [...DEFAULT_IMAGE_URL_BACKENDS];
      const index = list.indexOf(backend);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return current;
      const swapped = [...list];
      [swapped[index], swapped[target]] = [swapped[target]!, swapped[index]!];
      return {
        ...current,
        imageUrls: {
          ...current.imageUrls,
          backends: swapped,
        },
      };
    });
  };

  const saveConnection = async (nextConfig: ModelConnectionConfig) => {
    if (saving || loading) return;
    const version = ++requestVersion.current;
    setSaving(true);
    setWriteError(null);
    setJustSaved(false);
    try {
      const normalized = normalizeConnection(nextConfig);
      const body = scope === "global"
        ? { action: "globalConnection", connection: normalized }
        : { action: "workspaceConnection", id: scope, connection: normalized };
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? t("readFailed"));
      if (version !== requestVersion.current) return;
      const committed = scope === "global"
        ? normalizeConnection((value as GlobalConnectionResult).config.defaults.connection)
        : normalizeConnection((value as WorkspaceConnectionSnapshot).connection);
      setSaved(committed);
      setDraft(committed);
      setJustSaved(true);
      onSaved?.();
    } catch (error) {
      if (version === requestVersion.current) {
        setWriteError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (version === requestVersion.current) setSaving(false);
    }
  };

  const command = workspaceMeta ? reloadWorkspaceHostCommand(workspaceMeta.workspace) : "";
  const copyReload = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  const orderedChoices: ImageUrlBackend[] = [
    ...activeBackends,
    ...IMAGE_URL_BACKENDS.filter(id => !activeBackends.includes(id)),
  ];

  return (
    <section aria-labelledby={titleId} data-connection-settings className="grid min-w-0 gap-5 rounded-md border bg-card p-5 max-[480px]:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3.5">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-[var(--surface-inset)] text-[var(--gold)]">
            <Cable aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-base font-semibold">{t("title")}</h2>
              <Badge variant="outline">{t("badge")}</Badge>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`?view=docs&doc=insights%2Fws-recovery&docLang=${locale}`}>
            <BookOpen className="size-3.5" />
            {t("guideDocLink")}
          </a>
        </Button>
      </header>

      <Card className="shadow-none" data-connection-guide>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-[var(--gold)]" />
            <CardTitle role="heading" aria-level={3} className="text-sm">{t("guideTitle")}</CardTitle>
          </div>
          <CardDescription>{t("guideSummary")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-1 min-[960px]:grid-cols-3">
          <div className="flex flex-col justify-between rounded-md border border-border/80 bg-[var(--surface-inset)] p-3.5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs font-semibold text-foreground">{t("tierWsTitle")}</span>
                <Badge variant="outline" className="font-mono text-[11px] text-[var(--gold)]">{t("tierWsBadge")}</Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("tierWsBody")}</p>
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-md border border-border/80 bg-[var(--surface-inset)] p-3.5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs font-semibold text-foreground">{t("tierCacheTitle")}</span>
                <Badge variant="outline" className="font-mono text-[11px]">{t("tierCacheBadge")}</Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("tierCacheBody")}</p>
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-md border border-border/80 bg-[var(--surface-inset)] p-3.5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs font-semibold text-foreground">{t("tierBlobTitle")}</span>
                <Badge variant="outline" className="font-mono text-[11px]">{t("tierBlobBadge")}</Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("tierBlobBody")}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={scopeId}>{t("scopeLabel")}</Label>
            <p id={`${scopeId}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("scopeHint")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              id={scopeId}
              value={scope}
              aria-describedby={`${scopeId}-hint`}
              wrapperClassName="w-full min-[520px]:w-72"
              className="w-full"
              onChange={event => setScope(event.target.value)}
            >
              <NativeSelectOption value="global">{t("scopeGlobal")}</NativeSelectOption>
              {availableProjects.map(item => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {`${t("scopeWorkspacePrefix")}${item.name}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={loading || saving}
              className="aria-disabled:opacity-50"
              onClick={() => { if (!loading && !saving) setReloadTick(value => value + 1); }}
            >
              <RefreshCw className="size-3.5" />
              {t(loading ? "reading" : readError ? "retryRead" : "refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
            <span>
              {loading
                ? t("reading")
                : scope === "global"
                  ? t(hasSavedOverrides ? "statusGlobalActive" : "statusGlobalDefault")
                  : t(hasSavedOverrides ? "statusOverridden" : "statusInherited")}
            </span>
            {workspaceMeta?.model && (
              <span className="font-mono text-xs text-foreground">
                {t("workspaceModelLabel")}: <Badge variant="outline" className="font-mono">{workspaceMeta.model}</Badge>
              </span>
            )}
          </div>

          {readError && (
            <Alert variant="destructive">
              <AlertDescription className="space-y-1">
                <p>{t("readFailed")}</p>
                <pre className="whitespace-pre-wrap break-all text-xs">{readError}</pre>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={wsId} className="flex items-center gap-1.5">
                  <Cable className="size-3.5 text-[var(--gold)]" />
                  {t("wsLabel")}
                </Label>
                <p id={`${wsId}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("wsHint")}</p>
              </div>
              <NativeSelect
                id={wsId}
                value={draft.openaiWebsockets ?? ""}
                disabled={loading || saving}
                aria-describedby={`${wsId}-hint`}
                wrapperClassName="w-full min-[560px]:w-80"
                className="w-full"
                onChange={event => {
                  const val = event.target.value as OpenaiWebsocketsMode | "";
                  updateDraft(current => {
                    const next = { ...current };
                    if (!val) delete next.openaiWebsockets;
                    else next.openaiWebsockets = val;
                    return next;
                  });
                }}
              >
                <NativeSelectOption value="">{t("inheritOption")}</NativeSelectOption>
                <NativeSelectOption value="auto">{t("wsAuto")}</NativeSelectOption>
                <NativeSelectOption value="on">{t("wsOn")}</NativeSelectOption>
                <NativeSelectOption value="off">{t("wsOff")}</NativeSelectOption>
              </NativeSelect>
            </div>

            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={cacheId} className="flex items-center gap-1.5">
                  <Database className="size-3.5 text-[var(--gold)]" />
                  {t("cacheLabel")}
                </Label>
                <p id={`${cacheId}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("cacheHint")}</p>
              </div>
              <NativeSelect
                id={cacheId}
                value={draft.cacheRetention ?? ""}
                disabled={loading || saving}
                aria-describedby={`${cacheId}-hint`}
                wrapperClassName="w-full min-[560px]:w-80"
                className="w-full"
                onChange={event => {
                  const val = event.target.value as CacheRetentionMode | "";
                  updateDraft(current => {
                    const next = { ...current };
                    if (!val) delete next.cacheRetention;
                    else next.cacheRetention = val;
                    return next;
                  });
                }}
              >
                <NativeSelectOption value="">{t("inheritOption")}</NativeSelectOption>
                <NativeSelectOption value="auto">{t("cacheAuto")}</NativeSelectOption>
                <NativeSelectOption value="short">{t("cacheShort")}</NativeSelectOption>
                <NativeSelectOption value="long">{t("cacheLong")}</NativeSelectOption>
                <NativeSelectOption value="none">{t("cacheNone")}</NativeSelectOption>
              </NativeSelect>
            </div>

            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={appendId} className="flex items-center gap-1.5">
                  <Database className="size-3.5 text-[var(--gold)]" />
                  {t("appendLabel")}
                </Label>
                <p id={`${appendId}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("appendHint")}</p>
              </div>
              <NativeSelect
                id={appendId}
                value={draft.appendOnlyContext ?? ""}
                disabled={loading || saving}
                aria-describedby={`${appendId}-hint`}
                wrapperClassName="w-full min-[560px]:w-80"
                className="w-full"
                onChange={event => {
                  const val = event.target.value as AppendOnlyContextMode | "";
                  updateDraft(current => {
                    const next = { ...current };
                    if (!val) delete next.appendOnlyContext;
                    else next.appendOnlyContext = val;
                    return next;
                  });
                }}
              >
                <NativeSelectOption value="">{t("inheritOption")}</NativeSelectOption>
                <NativeSelectOption value="auto">{t("appendAuto")}</NativeSelectOption>
                <NativeSelectOption value="on">{t("appendOn")}</NativeSelectOption>
                <NativeSelectOption value="off">{t("appendOff")}</NativeSelectOption>
              </NativeSelect>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={imageModeId} className="flex items-center gap-1.5">
                    <CloudUpload className="size-3.5 text-[var(--gold)]" />
                    {t("imageUrlsTitle")}
                  </Label>
                  <p id={`${imageModeId}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("imageUrlsDesc")}</p>
                </div>
                <NativeSelect
                  id={imageModeId}
                  value={draft.imageUrls?.enabled === undefined ? "" : draft.imageUrls.enabled ? "on" : "off"}
                  disabled={loading || saving}
                  aria-describedby={`${imageModeId}-hint`}
                  wrapperClassName="w-full min-[560px]:w-80"
                  className="w-full"
                  onChange={event => {
                    const val = event.target.value;
                    updateDraft(current => {
                      const next = { ...current };
                      if (!val) {
                        if (next.imageUrls?.backends?.length) next.imageUrls = { backends: next.imageUrls.backends };
                        else delete next.imageUrls;
                      } else if (val === "on") {
                        next.imageUrls = {
                          enabled: true,
                          backends: next.imageUrls?.backends?.length ? next.imageUrls.backends : [...DEFAULT_IMAGE_URL_BACKENDS],
                        };
                      } else {
                        next.imageUrls = {
                          ...(next.imageUrls?.backends?.length ? { backends: next.imageUrls.backends } : {}),
                          enabled: false,
                        };
                      }
                      return next;
                    });
                  }}
                >
                  <NativeSelectOption value="">{t("imageUrlsModeInherit")}</NativeSelectOption>
                  <NativeSelectOption value="off">{t("imageUrlsModeOff")}</NativeSelectOption>
                  <NativeSelectOption value="on">{t("imageUrlsModeOn")}</NativeSelectOption>
                </NativeSelect>
              </div>

              <div className="rounded-md border border-border/80 bg-[var(--surface-inset)] p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-foreground">{t("backendsLabel")}</p>
                    <p className="text-xs text-muted-foreground">{t("backendsHint")}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={loading || saving}
                    onClick={() => updateDraft(current => ({
                      ...current,
                      imageUrls: {
                        ...current.imageUrls,
                        backends: [...DEFAULT_IMAGE_URL_BACKENDS],
                      },
                    }))}
                  >
                    <RotateCcw className="size-3.5" />
                    {t("resetDefaultBackends")}
                  </Button>
                </div>

                <div className="grid gap-2 min-[860px]:grid-cols-2">
                  {orderedChoices.map(backend => {
                    const selectedIndex = activeBackends.indexOf(backend);
                    const isSelected = selectedIndex >= 0;
                    const family = BACKEND_FAMILY[backend];
                    const familyLabel = family === "api" ? t("familyApi") : family === "tunnel" ? t("familyTunnel") : t("familyHost");
                    const checkboxId = `${titleId}-backend-${backend}`;
                    return (
                      <div
                        key={backend}
                        className="flex items-start justify-between gap-2.5 rounded-md border border-border/70 bg-card/70 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 items-start gap-2.5">
                          <Checkbox
                            id={checkboxId}
                            checked={isSelected}
                            disabled={loading || saving}
                            onCheckedChange={value => toggleBackend(backend, value === true)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Label htmlFor={checkboxId} className="cursor-pointer font-mono text-xs font-semibold">
                                {isSelected ? `${selectedIndex + 1}. ${backend}` : backend}
                              </Label>
                              <Badge variant="outline" className="text-[10px]">{familyLabel}</Badge>
                            </div>
                            <p className="text-[11px] leading-snug text-muted-foreground">
                              {t(`backendDesc.${backend}`)}
                            </p>
                          </div>
                        </div>
                        {isSelected && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              disabled={loading || saving || selectedIndex === 0}
                              aria-label={`${t("moveUp")} ${backend}`}
                              onClick={() => moveBackend(backend, -1)}
                            >
                              <ArrowUp className="size-3" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              disabled={loading || saving || selectedIndex === activeBackends.length - 1}
                              aria-label={`${t("moveDown")} ${backend}`}
                              onClick={() => moveBackend(backend, 1)}
                            >
                              <ArrowDown className="size-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {writeError && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{writeError}</AlertDescription>
            </Alert>
          )}
          {justSaved && !dirty && (
            <Alert role="status" className="border-success/35 bg-success/5">
              <CheckCircle2 className="text-success" />
              <AlertDescription className="text-xs">{t("savedNotice")}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-xs text-muted-foreground" role="status">
              {t(dirty ? "unsavedNotice" : "noChanges")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {(hasSavedOverrides || hasDraftOverrides) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={loading || saving}
                  onClick={() => void saveConnection({})}
                >
                  <RotateCcw className="size-3.5" />
                  {t("resetOverride")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!dirty || loading || saving}
                onClick={() => { setDraft(saved); setWriteError(null); }}
              >
                {t("discard")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || loading || saving}
                onClick={() => void saveConnection(draft)}
              >
                {t(saving ? "saving" : "save")}
              </Button>
            </div>
          </div>

          {workspaceMeta && (
            <div className="space-y-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">{t("applyHint")}</p>
              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/50 p-3">
                <code className="min-w-0 flex-1 basis-64 select-all break-all text-xs" data-connection-reload-command>
                  {command}
                </code>
                <Button type="button" variant="outline" size="sm" onClick={() => void copyReload()}>
                  {copied === "done" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {t(copied === "done" ? "copiedCommand" : "copyCommand")}
                </Button>
              </div>
              {copied === "failed" && <p role="alert" className="text-xs text-destructive">{t("copyFailed")}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
