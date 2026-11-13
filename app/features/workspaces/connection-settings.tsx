"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, RefreshCw, RotateCcw } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  AdvancedDiagnosticsDisclosure,
  InlineCopyButton,
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/ui/settings-primitives";
import { Switch } from "@/components/ui/switch";
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
  const wsId = useId();
  const cacheId = useId();
  const appendId = useId();
  const imageModeId = useId();

  const isGlobal = !initialScope || initialScope === "global";
  const scope = isGlobal ? "global" : initialScope;
  const workspaceProject = !isGlobal ? projects.find(item => item.id === scope) : undefined;

  const [saved, setSaved] = useState<ModelConnectionConfig>({});
  const [draft, setDraft] = useState<ModelConnectionConfig>({});
  const [workspaceMeta, setWorkspaceMeta] = useState<{ workspace: string; model: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setLoading(true);
    setReadError(null);
    setWriteError(null);
    setJustSaved(false);
    const url = isGlobal
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
        if (isGlobal) {
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
  }, [isGlobal, scope, reloadTick, t]);

  const dirty = !sameConnection(saved, draft);
  const hasSavedOverrides = Object.keys(normalizeConnection(saved)).length > 0;
  const hasDraftOverrides = Object.keys(normalizeConnection(draft)).length > 0;
  const imageUrlsEnabled = draft.imageUrls?.enabled === true;
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
      const body = isGlobal
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
      const committed = isGlobal
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

  const resolvedWorkspacePath = !isGlobal ? (workspaceMeta?.workspace ?? workspaceProject?.workspace ?? null) : null;
  const command = resolvedWorkspacePath ? reloadWorkspaceHostCommand(resolvedWorkspacePath) : "";
  const orderedChoices: ImageUrlBackend[] = [
    ...activeBackends,
    ...IMAGE_URL_BACKENDS.filter(id => !activeBackends.includes(id)),
  ];

  const statusSubtitle = loading
    ? t("reading")
    : isGlobal
      ? t(hasSavedOverrides ? "statusGlobalActive" : "statusGlobalDefault")
      : t(hasSavedOverrides ? "statusOverridden" : "statusInherited");

  return (
    <div data-connection-settings className="grid min-w-0 gap-4">
      {readError && (
        <Alert variant="destructive">
          <AlertDescription className="space-y-1 text-xs">
            <p>{t("readFailed")}</p>
            <pre className="whitespace-pre-wrap break-all">{readError}</pre>
          </AlertDescription>
        </Alert>
      )}
      {writeError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{writeError}</AlertDescription>
        </Alert>
      )}

      <SettingsSection
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{t("transportSettingsTitle")}</span>
            <Badge variant="outline">
              {isGlobal
                ? t("scopeLockedGlobal")
                : workspaceProject?.name
                  ? `${t("scopeLockedWorkspace")} · ${workspaceProject.name}`
                  : t("scopeLockedWorkspace")}
            </Badge>
          </span>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-2" role="status">
            <span>{statusSubtitle}</span>
            {workspaceMeta?.model && (
              <Badge variant="outline" className="font-mono text-[11px]">
                {workspaceMeta.model}
              </Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <a href={`?view=docs&doc=insights%2Fws-recovery&docLang=${locale}`}>
                <BookOpen className="size-3.5" aria-hidden="true" />
                {t("guideDocLink")}
              </a>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={loading || saving}
              className="aria-disabled:opacity-50"
              onClick={() => { if (!loading && !saving) setReloadTick(value => value + 1); }}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t(loading ? "reading" : readError ? "retryRead" : "refresh")}
            </Button>
          </>
        }
      >
        <SettingsRow
          label={t("wsLabel")}
          htmlFor={wsId}
          description={t("wsHint")}
          descriptionId={`${wsId}-hint`}
          control={
            <NativeSelect
              id={wsId}
              value={draft.openaiWebsockets ?? ""}
              disabled={loading || saving}
              aria-describedby={`${wsId}-hint`}
              wrapperClassName="w-full sm:w-72"
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
          }
        />

        <SettingsRow
          label={t("cacheLabel")}
          htmlFor={cacheId}
          description={t("cacheHint")}
          descriptionId={`${cacheId}-hint`}
          control={
            <NativeSelect
              id={cacheId}
              value={draft.cacheRetention ?? ""}
              disabled={loading || saving}
              aria-describedby={`${cacheId}-hint`}
              wrapperClassName="w-full sm:w-72"
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
          }
        />

        <SettingsRow
          label={t("appendLabel")}
          htmlFor={appendId}
          description={t("appendHint")}
          descriptionId={`${appendId}-hint`}
          control={
            <NativeSelect
              id={appendId}
              value={draft.appendOnlyContext ?? ""}
              disabled={loading || saving}
              aria-describedby={`${appendId}-hint`}
              wrapperClassName="w-full sm:w-72"
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
          }
        />

        <SettingsRow
          label={t("imageUrlsTitle")}
          htmlFor={imageModeId}
          description={t("imageUrlsDesc")}
          descriptionId={`${imageModeId}-hint`}
          stacked={imageUrlsEnabled}
          control={
            <div className={imageUrlsEnabled ? "grid w-full gap-3" : "flex items-center"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Switch
                  id={imageModeId}
                  checked={imageUrlsEnabled}
                  disabled={loading || saving}
                  aria-describedby={`${imageModeId}-hint`}
                  onCheckedChange={checked => {
                    updateDraft(current => {
                      const next = { ...current };
                      if (checked) {
                        next.imageUrls = {
                          enabled: true,
                          backends: next.imageUrls?.backends?.length
                            ? next.imageUrls.backends
                            : [...DEFAULT_IMAGE_URL_BACKENDS],
                        };
                      } else if (saved.imageUrls?.enabled === undefined) {
                        delete next.imageUrls;
                      } else {
                        next.imageUrls = {
                          ...(next.imageUrls?.backends?.length ? { backends: next.imageUrls.backends } : {}),
                          enabled: false,
                        };
                      }
                      return next;
                    });
                  }}
                />
                {imageUrlsEnabled && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={loading || saving}
                    onClick={() => updateDraft(current => ({
                      ...current,
                      imageUrls: {
                        ...current.imageUrls,
                        enabled: true,
                        backends: [...DEFAULT_IMAGE_URL_BACKENDS],
                      },
                    }))}
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    {t("resetDefaultBackends")}
                  </Button>
                )}
              </div>

              {imageUrlsEnabled && (
                <>
                  <p className="text-xs text-muted-foreground">{t("backendsHint")}</p>

                  <div className="grid gap-1.5 min-[860px]:grid-cols-2">
                    {orderedChoices.map(backend => {
                      const selectedIndex = activeBackends.indexOf(backend);
                      const isSelected = selectedIndex >= 0;
                      const family = BACKEND_FAMILY[backend];
                      const familyLabel = family === "api" ? t("familyApi") : family === "tunnel" ? t("familyTunnel") : t("familyHost");
                      const checkboxId = `${titleId}-backend-${backend}`;
                      return (
                        <div
                          key={backend}
                          className="flex items-start justify-between gap-2 border-b border-border/50 py-2"
                        >
                          <div className="flex min-w-0 items-start gap-2.5">
                            <Checkbox
                              id={checkboxId}
                              checked={isSelected}
                              disabled={loading || saving}
                              onCheckedChange={value => toggleBackend(backend, value === true)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 space-y-0.5">
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
                </>
              )}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSaveBar
        dirty={dirty}
        statusText={justSaved && !dirty ? t("savedNotice") : t(dirty ? "unsavedNotice" : "noChanges")}
        discardLabel={t("discard")}
        onDiscard={() => {
          setDraft(saved);
          setWriteError(null);
          setJustSaved(false);
        }}
        saveLabel={t("save")}
        savingLabel={t("saving")}
        saving={saving}
        disabled={loading}
        onSave={() => void saveConnection(draft)}
        secondaryAction={
          !isGlobal && (hasSavedOverrides || hasDraftOverrides) ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading || saving}
              onClick={() => void saveConnection({})}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("resetOverride")}
            </Button>
          ) : undefined
        }
      />

      {!isGlobal && resolvedWorkspacePath && (
        <AdvancedDiagnosticsDisclosure summary={t("advancedCliTitle")}>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("applyHint")}</p>
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
              <code
                className="min-w-0 flex-1 select-all break-all font-mono text-xs"
                data-connection-reload-command
              >
                {command}
              </code>
              <InlineCopyButton
                text={command}
                ariaLabel={t("copyCommand")}
                copiedText={t("copiedCommand")}
                failedText={t("copyFailed")}
              />
            </div>
          </div>
        </AdvancedDiagnosticsDisclosure>
      )}
    </div>
  );
}
