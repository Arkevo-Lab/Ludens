"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Cloud,
  Database,
  Edit3,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  Pin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { BasewareModalDialog } from "@/features/baseware/baseware-modal-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
  SingleLineTruncate,
} from "@/components/ui/settings-primitives";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/lib/locale";
import {
  BUILTIN_LOCAL_PROFILE_ID,
  DEFAULT_LOCAL_CACHE_BYTES,
  DEFAULT_LOCAL_MAX_BYTES,
  buildStorageTestParamsFromDraft,
  createEmptyStorageProfileDraft,
  draftToStorageProfileInput,
  fallbackGlobalStorageConfig,
  formatStorageBytes,
  maintainActionKey,
  redactedProfileToInput,
  slugifyStorageProfileId,
  storageProfileToDraft,
  useStorageOverview,
  validateStorageProfileDraft,
  type RedactedStorageProfile,
  type StorageBackendKind,
  type StorageOverviewSnapshot,
  type StorageProfileDraft,
  type StorageProfileErrorCode,
  type StorageProfileErrorField,
  type StorageProfileInput,
  type StorageTestParams,
  type StorageTestResult,
  type VideoQualityPreset,
} from "@/lib/storage";

const BACKEND_KINDS: readonly StorageBackendKind[] = ["local", "directory", "s3", "ephemeral"];

function BackendKindIcon({ kind }: { kind: StorageBackendKind }) {
  switch (kind) {
    case "local":
      return <HardDrive className="size-3.5 text-primary" aria-hidden="true" />;
    case "directory":
      return <FolderOpen className="size-3.5 text-primary" aria-hidden="true" />;
    case "s3":
      return <Cloud className="size-3.5 text-primary" aria-hidden="true" />;
    case "ephemeral":
      return <Zap className="size-3.5 text-amber-500" aria-hidden="true" />;
  }
}

function profileErrorKey(code: StorageProfileErrorCode): string {
  switch (code) {
    case "required":
      return "errRequired";
    case "invalidId":
      return "errInvalidId";
    case "duplicateId":
      return "errDuplicateId";
    case "reservedId":
      return "errReservedId";
    case "invalidPositiveNumber":
      return "errInvalidPositiveNumber";
    case "invalidAbsolutePath":
      return "errInvalidAbsolutePath";
    case "invalidEndpointUrl":
      return "errInvalidEndpointUrl";
  }
}

export interface StorageSettingsProps {
  initialData?: StorageOverviewSnapshot | null;
}

export function StorageSettings({ initialData }: StorageSettingsProps) {
  const t = useTranslations("storageSettings");
  const overview = useStorageOverview({ initialData });
  const effectiveConfig = overview.config ?? fallbackGlobalStorageConfig();

  const defaultProfileSelectId = useId();
  const videoQualitySelectId = useId();
  const usageCaptionId = useId();

  const [defaultsDraft, setDefaultsDraft] = useState<{
    defaultProfileId: string;
    videoQuality: VideoQualityPreset;
    protectReferenced: boolean;
  }>({
    defaultProfileId: effectiveConfig.defaultProfileId,
    videoQuality: effectiveConfig.videoQuality,
    protectReferenced: effectiveConfig.protectReferenced,
  });
  const [defaultsSavedNotice, setDefaultsSavedNotice] = useState(false);

  const [editorState, setEditorState] = useState<{
    open: boolean;
    editingProfile: RedactedStorageProfile | null;
  }>({
    open: false,
    editingProfile: null,
  });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!overview.config) return;
    setDefaultsDraft({
      defaultProfileId: overview.config.defaultProfileId,
      videoQuality: overview.config.videoQuality,
      protectReferenced: overview.config.protectReferenced,
    });
  }, [overview.config]);

  const defaultsDirty =
    defaultsDraft.defaultProfileId !== effectiveConfig.defaultProfileId ||
    defaultsDraft.videoQuality !== effectiveConfig.videoQuality ||
    defaultsDraft.protectReferenced !== effectiveConfig.protectReferenced;

  const saveGlobalDefaults = async () => {
    if (overview.saving || !defaultsDirty) return;
    setDefaultsSavedNotice(false);
    try {
      await overview.updateStorage({
        defaultProfileId: defaultsDraft.defaultProfileId,
        videoQuality: defaultsDraft.videoQuality,
        protectReferenced: defaultsDraft.protectReferenced,
      });
      setDefaultsSavedNotice(true);
    } catch {
      // Error surfaced via overview.actionError
    }
  };

  const handleSetDefaultProfile = async (profileId: string) => {
    if (overview.saving || profileId === effectiveConfig.defaultProfileId) return;
    setDefaultsSavedNotice(false);
    try {
      await overview.updateStorage({ defaultProfileId: profileId });
    } catch {
      // Error surfaced via overview.actionError
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (overview.saving || profileId === BUILTIN_LOCAL_PROFILE_ID) return;
    const remainingProfiles = effectiveConfig.profiles
      .filter(item => item.id !== profileId)
      .map(redactedProfileToInput);
    const nextDefault =
      effectiveConfig.defaultProfileId === profileId
        ? BUILTIN_LOCAL_PROFILE_ID
        : effectiveConfig.defaultProfileId;
    try {
      await overview.updateStorage({
        defaultProfileId: nextDefault,
        profiles: remainingProfiles,
      });
      setConfirmDeleteId(null);
    } catch {
      // Error surfaced via overview.actionError
    }
  };

  const handleSaveProfile = async (
    nextProfile: StorageProfileInput,
    editingId: string | null,
  ): Promise<void> => {
    const existingInputs = effectiveConfig.profiles.map(item =>
      editingId && item.id === editingId ? nextProfile : redactedProfileToInput(item),
    );
    const updatedProfiles = editingId
      ? existingInputs
      : [...existingInputs, nextProfile];
    await overview.updateStorage({ profiles: updatedProfiles });
    setEditorState({ open: false, editingProfile: null });
  };

  const allPruneBusy = overview.maintainingKey === maintainActionKey({ action: "prune" });
  const allSyncBusy = overview.maintainingKey === maintainActionKey({ action: "sync" });
  const anyMaintainBusy = overview.maintainingKey !== null;
  const unlimitedText = t("unlimitedQuota");

  const formatProfileSummary = (profile: RedactedStorageProfile): string => {
    if (profile.kind === "ephemeral") {
      return t("profileEphemeralSummary");
    }
    const maxText = formatStorageBytes(profile.maxBytes, { unlimitedLabel: unlimitedText });
    const ttlSuffix =
      profile.maxAgeHours !== null && profile.maxAgeHours !== undefined && profile.maxAgeHours > 0
        ? t("profileTtlSuffix").replace("{hours}", String(profile.maxAgeHours))
        : "";
    if (profile.kind === "directory" || profile.kind === "s3") {
      const cacheText = formatStorageBytes(
        profile.localCacheBytes ?? DEFAULT_LOCAL_CACHE_BYTES,
        { unlimitedLabel: unlimitedText },
      );
      return (
        t("profileRemoteQuotaSummary")
          .replace("{max}", maxText)
          .replace("{cache}", cacheText) + ttlSuffix
      );
    }
    return t("profileLocalQuotaSummary").replace("{max}", maxText) + ttlSuffix;
  };

  return (
    <div className="grid min-w-0 gap-6" data-storage-settings>
      {overview.loadError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{overview.loadError}</AlertDescription>
        </Alert>
      )}
      {overview.actionError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{overview.actionError}</AlertDescription>
        </Alert>
      )}

      {/* 1. Storage Footprint & Maintenance */}
      <SettingsSection
        title={t("footprintTitle")}
        description={t("footprintDesc")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={overview.loading || overview.refreshing || anyMaintainBusy}
              onClick={() => void overview.refresh()}
              data-storage-action="refresh"
            >
              <RefreshCw
                className={
                  "size-3.5" + (overview.refreshing ? " motion-safe:animate-spin" : "")
                }
                aria-hidden="true"
              />
              {t(overview.refreshing ? "refreshing" : "refresh")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={overview.loading || anyMaintainBusy}
              onClick={() => void overview.maintainStorage({ action: "sync" })}
              data-storage-action="sync-all"
            >
              {allSyncBusy ? (
                <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Archive className="size-3.5" aria-hidden="true" />
              )}
              {t(allSyncBusy ? "syncingAll" : "syncAll")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={overview.loading || anyMaintainBusy}
              onClick={() => void overview.maintainStorage({ action: "prune" })}
              data-storage-action="prune-all"
            >
              {allPruneBusy ? (
                <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3.5" aria-hidden="true" />
              )}
              {t(allPruneBusy ? "pruningAll" : "pruneAll")}
            </Button>
          </>
        }
      >
        {overview.lastMaintainResult && (
          <div
            role="status"
            data-storage-maintain-result
            className="my-2 flex flex-wrap items-start justify-between gap-2 rounded-md border border-emerald-500/35 bg-emerald-500/5 px-3 py-2 text-xs text-foreground"
          >
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
                <span>
                  {t("maintainResultSummary")
                    .replace("{freed}", formatStorageBytes(overview.lastMaintainResult.freedBytes))
                    .replace("{archived}", String(overview.lastMaintainResult.archivedCount))
                    .replace("{evicted}", String(overview.lastMaintainResult.evictedCount))}
                </span>
              </p>
              {overview.lastMaintainResult.errors.length > 0 && (
                <p className="text-destructive">
                  {t("maintainErrorsPrefix").replace(
                    "{count}",
                    String(overview.lastMaintainResult.errors.length),
                  )}
                  {overview.lastMaintainResult.errors
                    .map(item => `${item.workspaceId}: ${item.error}`)
                    .join(" · ")}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={overview.clearMaintainResult}
              aria-label={t("dismissNotice")}
            >
              ×
            </Button>
          </div>
        )}

        <SettingsRow
          stacked
          label={
            <span className="inline-flex items-center gap-2">
              <Database className="size-3.5 text-primary" aria-hidden="true" />
              <span>{t("totalLocalLabel")}</span>
            </span>
          }
          badge={
            <Badge variant="secondary" className="font-mono tabular-nums text-[11px]">
              {formatStorageBytes(overview.totals.totalLocalBytes)}
            </Badge>
          }
          meta={t("workspacesCount").replace("{count}", String(overview.totals.workspaceCount))}
          description={t("breakdownArchiveSummary")
            .replace("{archived}", String(overview.totals.archivedSegments))
            .replace("{archivedBytes}", formatStorageBytes(overview.totals.archivedBytes))
            .replace("{evicted}", String(overview.totals.evictedSegments))
            .replace("{pinned}", String(overview.totals.pinnedSegments))}
          control={
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t("breakdownVideo")}</div>
                <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
                  {formatStorageBytes(overview.totals.localVideoBytes)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {t("breakdownVideoSegments").replace(
                    "{count}",
                    String(overview.totals.localVideoSegments),
                  )}
                </div>
              </div>
              <div className="rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t("breakdownCache")}</div>
                <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
                  {formatStorageBytes(
                    overview.totals.localCacheBytes + overview.totals.localObjectsBytes,
                  )}
                </div>
              </div>
              <div className="rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t("breakdownSegments")}</div>
                <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
                  {formatStorageBytes(overview.totals.segmentsIndexBytes)}
                </div>
              </div>
              <div className="rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t("breakdownLogs")}</div>
                <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
                  {formatStorageBytes(overview.totals.logsBytes)}
                </div>
              </div>
            </div>
          }
        />

        {overview.usage.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">{t("emptyWorkspaces")}</p>
        ) : (
          <div className="py-2">
            <div
              tabIndex={0}
              role="region"
              aria-labelledby={usageCaptionId}
              className="rounded-md border border-border/70 bg-[var(--surface-inset)]"
            >
              <Table>
                <caption id={usageCaptionId} className="sr-only">
                  {t("tableCaption")}
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("colWorkspace")}</TableHead>
                    <TableHead scope="col">{t("colBackend")}</TableHead>
                    <TableHead scope="col">{t("colLocalBreakdown")}</TableHead>
                    <TableHead scope="col">{t("colArchiveState")}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {t("colActions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.usage.map(ws => {
                    const pruneBusy =
                      overview.maintainingKey ===
                      maintainActionKey({ action: "prune", workspaceId: ws.workspaceId });
                    const syncBusy =
                      overview.maintainingKey ===
                      maintainActionKey({ action: "sync", workspaceId: ws.workspaceId });
                    const clearCacheBusy =
                      overview.maintainingKey ===
                      maintainActionKey({ action: "clear_cache", workspaceId: ws.workspaceId });

                    return (
                      <TableRow key={ws.workspaceId} data-storage-workspace={ws.workspaceId}>
                        <TableHead scope="row" className="max-w-[14rem] py-2.5 font-medium">
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                              <span>{ws.workspaceName || ws.workspaceId}</span>
                              {!ws.available && (
                                <Badge variant="outline" className="text-[10px] text-destructive">
                                  {t("wsUnavailable")}
                                </Badge>
                              )}
                            </span>
                            <SingleLineTruncate
                              mono
                              text={ws.workspacePath}
                              className="max-w-[13rem] text-[11px] font-normal text-muted-foreground"
                            />
                          </div>
                        </TableHead>

                        <TableCell className="py-2.5">
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant="outline" className="gap-1 text-[11px]">
                              <BackendKindIcon kind={ws.effectiveKind} />
                              <span>{t(`kindBadges.${ws.effectiveKind}`)}</span>
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">
                              {ws.effectiveProfileName}
                              {ws.effectiveKind !== "ephemeral" &&
                                ` · ${t("wsQuotaPrefix").replace(
                                  "{quota}",
                                  formatStorageBytes(ws.maxBytes, {
                                    unlimitedLabel: unlimitedText,
                                  }),
                                )}`}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-xs font-semibold tabular-nums">
                              {formatStorageBytes(ws.totalLocalBytes)}
                            </span>
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {t("wsBreakdownLine")
                                .replace(
                                  "{video}",
                                  formatStorageBytes(ws.localVideoBytes + ws.localObjectsBytes),
                                )
                                .replace("{cache}", formatStorageBytes(ws.localCacheBytes))
                                .replace("{index}", formatStorageBytes(ws.segmentsIndexBytes))
                                .replace("{logs}", formatStorageBytes(ws.logsBytes))}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="py-2.5">
                          <div className="flex flex-col gap-0.5 text-[11px] tabular-nums">
                            <span className="text-foreground">
                              {t("wsArchivedStat")
                                .replace("{count}", String(ws.archivedSegments))
                                .replace("{bytes}", formatStorageBytes(ws.archivedBytes))}
                            </span>
                            <span className="inline-flex flex-wrap items-center gap-2 text-muted-foreground">
                              <span>
                                {t("wsEvictedStat").replace("{count}", String(ws.evictedSegments))}
                              </span>
                              {ws.pinnedSegments > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-primary">
                                  <Pin className="size-3" aria-hidden="true" />
                                  {t("wsPinnedStat").replace("{count}", String(ws.pinnedSegments))}
                                </span>
                              )}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="py-2.5 text-right">
                          <div className="inline-flex flex-wrap justify-end gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              disabled={!ws.available || anyMaintainBusy}
                              onClick={() =>
                                void overview.maintainStorage({
                                  action: "prune",
                                  workspaceId: ws.workspaceId,
                                })
                              }
                              data-storage-ws-action="prune"
                            >
                              {t(pruneBusy ? "btnPruning" : "btnPrune")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              disabled={!ws.available || anyMaintainBusy}
                              onClick={() =>
                                void overview.maintainStorage({
                                  action: "sync",
                                  workspaceId: ws.workspaceId,
                                })
                              }
                              data-storage-ws-action="sync"
                            >
                              {t(syncBusy ? "btnSyncing" : "btnSync")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              disabled={!ws.available || anyMaintainBusy}
                              onClick={() =>
                                void overview.maintainStorage({
                                  action: "clear_cache",
                                  workspaceId: ws.workspaceId,
                                })
                              }
                              data-storage-ws-action="clear_cache"
                            >
                              {t(clearCacheBusy ? "btnClearingCache" : "btnClearCache")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* 2. Global Recording & Retention Defaults */}
      <SettingsSection title={t("defaultsTitle")} description={t("defaultsDesc")}>
        <SettingsRow
          label={t("defaultProfileLabel")}
          htmlFor={defaultProfileSelectId}
          description={t("defaultProfileHint")}
          control={
            <NativeSelect
              id={defaultProfileSelectId}
              disabled={overview.loading || overview.saving}
              value={defaultsDraft.defaultProfileId}
              onChange={event => {
                setDefaultsDraft(prev => ({
                  ...prev,
                  defaultProfileId: event.target.value,
                }));
                setDefaultsSavedNotice(false);
              }}
              wrapperClassName="w-full sm:w-72"
              className="w-full"
              data-storage-default-profile
            >
              {effectiveConfig.profiles.map(profile => (
                <NativeSelectOption key={profile.id} value={profile.id}>
                  {`${profile.name} (${profile.kind})`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
        />

        <SettingsRow
          label={t("videoQualityLabel")}
          htmlFor={videoQualitySelectId}
          description={t("videoQualityHint")}
          control={
            <NativeSelect
              id={videoQualitySelectId}
              disabled={overview.loading || overview.saving}
              value={defaultsDraft.videoQuality}
              onChange={event => {
                const val = event.target.value;
                const nextQuality: VideoQualityPreset =
                  val === "high" || val === "compact" ? val : "balanced";
                setDefaultsDraft(prev => ({
                  ...prev,
                  videoQuality: nextQuality,
                }));
                setDefaultsSavedNotice(false);
              }}
              wrapperClassName="w-full sm:w-80"
              className="w-full"
              data-storage-video-quality
            >
              <NativeSelectOption value="balanced">{t("qualityBalanced")}</NativeSelectOption>
              <NativeSelectOption value="compact">{t("qualityCompact")}</NativeSelectOption>
              <NativeSelectOption value="high">{t("qualityHigh")}</NativeSelectOption>
            </NativeSelect>
          }
        />

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
              <span>{t("protectReferencedLabel")}</span>
            </span>
          }
          htmlFor="storage-protect-referenced-switch"
          description={t("protectReferencedHint")}
          control={
            <Switch
              id="storage-protect-referenced-switch"
              disabled={overview.loading || overview.saving}
              checked={defaultsDraft.protectReferenced}
              onCheckedChange={checked => {
                setDefaultsDraft(prev => ({ ...prev, protectReferenced: checked }));
                setDefaultsSavedNotice(false);
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSaveBar
        dirty={defaultsDirty}
        statusText={
          defaultsDirty
            ? t("unsavedDefaults")
            : defaultsSavedNotice
              ? t("savedDefaults")
              : t("syncedDefaults")
        }
        discardLabel={t("discardDefaults")}
        onDiscard={() => {
          setDefaultsDraft({
            defaultProfileId: effectiveConfig.defaultProfileId,
            videoQuality: effectiveConfig.videoQuality,
            protectReferenced: effectiveConfig.protectReferenced,
          });
          setDefaultsSavedNotice(false);
        }}
        saveLabel={t("saveDefaults")}
        savingLabel={t("savingDefaults")}
        saving={overview.saving}
        disabled={overview.loading}
        onSave={() => void saveGlobalDefaults()}
      />

      {/* 3. Storage Profiles Pool */}
      <SettingsSection
        title={t("profilesTitle")}
        description={t("profilesDesc")}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={overview.loading || overview.saving}
            onClick={() => setEditorState({ open: true, editingProfile: null })}
            data-storage-add-profile
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("addProfileBtn")}
          </Button>
        }
      >
        {effectiveConfig.profiles.map(profile => {
          const isDefault = profile.id === effectiveConfig.defaultProfileId;
          const isBuiltin = profile.id === BUILTIN_LOCAL_PROFILE_ID;
          const isConfirmingDelete = confirmDeleteId === profile.id;

          return (
            <SettingsRow
              key={profile.id}
              data-storage-profile={profile.id}
              label={
                <span className="inline-flex items-center gap-2">
                  <BackendKindIcon kind={profile.kind} />
                  <span>{profile.name}</span>
                  <code className="rounded bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {profile.id}
                  </code>
                </span>
              }
              badge={
                <>
                  <Badge variant="outline" className="text-[11px]">
                    {t(`kindBadges.${profile.kind}`)}
                  </Badge>
                  {isDefault && (
                    <Badge
                      variant="outline"
                      className="border-primary/40 bg-primary/10 text-[11px] text-primary"
                    >
                      {t("defaultBadge")}
                    </Badge>
                  )}
                  {isBuiltin && (
                    <Badge variant="secondary" className="text-[11px]">
                      {t("builtinBadge")}
                    </Badge>
                  )}
                  {profile.s3?.hasSecretAccessKey && (
                    <Badge variant="outline" className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      {t("secretSavedBadge")}
                    </Badge>
                  )}
                </>
              }
              description={
                <span className="flex flex-col gap-0.5">
                  <span>{formatProfileSummary(profile)}</span>
                  {profile.kind === "directory" && profile.directory?.path && (
                    <SingleLineTruncate
                      mono
                      text={profile.directory.path}
                      className="text-[11px] text-muted-foreground"
                    />
                  )}
                  {profile.kind === "s3" && profile.s3 && (
                    <SingleLineTruncate
                      mono
                      text={`${profile.s3.endpoint} · ${profile.s3.bucket} (${profile.s3.region})${
                        profile.s3.prefix ? ` / ${profile.s3.prefix}` : ""
                      }`}
                      className="text-[11px] text-muted-foreground"
                    />
                  )}
                  {isBuiltin && (
                    <span className="text-[11px] text-muted-foreground">
                      {t("builtinLockedNote")}
                    </span>
                  )}
                </span>
              }
              control={
                <div className="flex flex-wrap items-center gap-1.5">
                  {!isDefault && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={overview.saving}
                      onClick={() => void handleSetDefaultProfile(profile.id)}
                      data-storage-set-default={profile.id}
                    >
                      {t("setDefaultBtn")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={overview.saving}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      setEditorState({ open: true, editingProfile: profile });
                    }}
                    data-storage-edit-profile={profile.id}
                  >
                    <Edit3 className="size-3" aria-hidden="true" />
                    {t("editBtn")}
                  </Button>
                  {!isBuiltin && (
                    isConfirmingDelete ? (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          disabled={overview.saving}
                          onClick={() => void handleDeleteProfile(profile.id)}
                          data-storage-confirm-delete={profile.id}
                        >
                          {t("confirmDeleteBtn")}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={overview.saving}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          {t("cancelDeleteBtn")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={overview.saving}
                        onClick={() => setConfirmDeleteId(profile.id)}
                        data-storage-delete-profile={profile.id}
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                        {t("deleteBtn")}
                      </Button>
                    )
                  )}
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <StorageProfileDialog
        open={editorState.open}
        editingProfile={editorState.editingProfile}
        existingIds={effectiveConfig.profiles.map(item => item.id)}
        saving={overview.saving}
        onClose={() => setEditorState({ open: false, editingProfile: null })}
        onSave={handleSaveProfile}
        onTest={overview.testBackend}
      />
    </div>
  );
}

export interface StorageProfileDialogProps {
  open: boolean;
  editingProfile: RedactedStorageProfile | null;
  existingIds: readonly string[];
  saving?: boolean;
  onClose(): void;
  onSave(profile: StorageProfileInput, editingId: string | null): Promise<void>;
  onTest(params: StorageTestParams): Promise<StorageTestResult>;
}

export function StorageProfileDialog({
  open,
  editingProfile,
  existingIds,
  saving = false,
  onClose,
  onSave,
  onTest,
}: StorageProfileDialogProps) {
  const t = useTranslations("storageSettings");
  const title = editingProfile
    ? t("dialogEditTitle").replace("{name}", editingProfile.name)
    : t("dialogNewTitle");

  return (
    <BasewareModalDialog
      open={open}
      onClose={onClose}
      title={title}
      subtitle={t("dialogSubtitle")}
      closeLabel={t("closeDialog")}
      closedBy="closerequest"
    >
      <StorageProfileForm
        key={editingProfile?.id ?? "new-profile"}
        editingProfile={editingProfile}
        existingIds={existingIds}
        saving={saving}
        onCancel={onClose}
        onSave={onSave}
        onTest={onTest}
      />
    </BasewareModalDialog>
  );
}

export interface StorageProfileFormProps {
  editingProfile: RedactedStorageProfile | null;
  existingIds: readonly string[];
  saving?: boolean;
  initialTestResult?: StorageTestResult | null;
  onCancel(): void;
  onSave(profile: StorageProfileInput, editingId: string | null): Promise<void>;
  onTest(params: StorageTestParams): Promise<StorageTestResult>;
}

export function StorageProfileForm({
  editingProfile,
  existingIds,
  saving = false,
  initialTestResult = null,
  onCancel,
  onSave,
  onTest,
}: StorageProfileFormProps) {
  const t = useTranslations("storageSettings");
  const formHeadingId = useId();
  const baseId = useId();

  const isEditing = Boolean(editingProfile);
  const isBuiltin = editingProfile?.id === BUILTIN_LOCAL_PROFILE_ID;
  const hasSavedSecret = Boolean(editingProfile?.s3?.hasSecretAccessKey);

  const [draft, setDraft] = useState<StorageProfileDraft>(() =>
    editingProfile ? storageProfileToDraft(editingProfile) : createEmptyStorageProfileDraft("directory"),
  );
  const [idManuallyEdited, setIdManuallyEdited] = useState<boolean>(isEditing);
  const [touched, setTouched] = useState<Partial<Record<StorageProfileErrorField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | StorageTestResult>(
    initialTestResult ?? "idle",
  );

  const fieldRefs = useRef<Partial<Record<StorageProfileErrorField, HTMLInputElement | null>>>({});

  const validation = useMemo(
    () =>
      validateStorageProfileDraft(draft, {
        editingProfile,
        existingIds,
      }),
    [draft, editingProfile, existingIds],
  );

  const errorFor = (field: StorageProfileErrorField): string => {
    if (!(submitted || touched[field])) return "";
    const code = validation.errors[field];
    return code ? t(profileErrorKey(code)) : "";
  };

  const markTouched = (field: StorageProfileErrorField) => {
    setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }));
  };

  const updateField = <K extends keyof StorageProfileDraft>(
    field: K,
    value: StorageProfileDraft[K],
  ) => {
    setDraft(prev => ({ ...prev, [field]: value }));
    setSubmitError(null);
    if (
      field === "directoryPath" ||
      field === "s3Endpoint" ||
      field === "s3Region" ||
      field === "s3Bucket" ||
      field === "s3Prefix" ||
      field === "s3AccessKeyId" ||
      field === "s3SecretAccessKey" ||
      field === "s3ForcePathStyle" ||
      field === "kind"
    ) {
      setTestState("idle");
    }
  };

  const handleRunTest = async () => {
    const params = buildStorageTestParamsFromDraft(draft, editingProfile);
    if (!params) return;
    if (draft.kind === "directory") {
      markTouched("directoryPath");
      if (validation.errors.directoryPath) {
        fieldRefs.current.directoryPath?.focus();
        return;
      }
    } else if (draft.kind === "s3") {
      const s3Fields: StorageProfileErrorField[] = [
        "s3Endpoint",
        "s3Region",
        "s3Bucket",
        "s3AccessKeyId",
        "s3SecretAccessKey",
      ];
      for (const f of s3Fields) markTouched(f);
      const firstInvalid = s3Fields.find(f => validation.errors[f]);
      if (firstInvalid) {
        fieldRefs.current[firstInvalid]?.focus();
        return;
      }
    }
    setTestState("testing");
    const outcome = await onTest(params);
    setTestState(outcome);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError(null);
    if (!validation.valid) {
      const ordered: StorageProfileErrorField[] = [
        "name",
        "id",
        "maxGib",
        "maxAgeHours",
        "localCacheGib",
        "directoryPath",
        "s3Endpoint",
        "s3Region",
        "s3Bucket",
        "s3AccessKeyId",
        "s3SecretAccessKey",
      ];
      const firstInvalid = ordered.find(field => validation.errors[field]);
      if (firstInvalid) {
        fieldRefs.current[firstInvalid]?.focus();
      }
      return;
    }

    try {
      const payload = draftToStorageProfileInput(draft);
      await onSave(payload, editingProfile?.id ?? null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  };

  const secretWarnId = `${baseId}-secret-warn`;
  const testResult = testState !== "idle" && testState !== "testing" ? testState : null;

  return (
    <form
      onSubmit={event => void handleSubmit(event)}
      noValidate
      aria-labelledby={formHeadingId}
      className="grid gap-4"
      data-storage-profile-form
    >
      <span id={formHeadingId} className="sr-only">
        {editingProfile ? editingProfile.name : t("dialogNewTitle")}
      </span>

      {submitError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{submitError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${baseId}-name`}>{t("fieldName")} *</Label>
          <Input
            ref={el => {
              fieldRefs.current.name = el;
            }}
            id={`${baseId}-name`}
            name="name"
            required
            autoFocus
            value={draft.name}
            onBlur={() => markTouched("name")}
            onChange={event => {
              const nextName = event.target.value;
              setDraft(prev => ({
                ...prev,
                name: nextName,
                id:
                  !isEditing && !idManuallyEdited
                    ? slugifyStorageProfileId(nextName)
                    : prev.id,
              }));
              setSubmitError(null);
            }}
            placeholder={t("fieldNamePlaceholder")}
            aria-invalid={Boolean(errorFor("name")) || undefined}
            aria-describedby={errorFor("name") ? `${baseId}-name-err` : undefined}
          />
          {errorFor("name") && (
            <p id={`${baseId}-name-err`} className="text-xs text-destructive">
              {errorFor("name")}
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`${baseId}-id`}>{t("fieldId")} *</Label>
          <Input
            ref={el => {
              fieldRefs.current.id = el;
            }}
            id={`${baseId}-id`}
            name="id"
            required
            disabled={isEditing}
            value={draft.id}
            onBlur={() => markTouched("id")}
            onChange={event => {
              setIdManuallyEdited(true);
              updateField("id", event.target.value);
            }}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono text-sm"
            aria-invalid={Boolean(errorFor("id")) || undefined}
            aria-describedby={
              errorFor("id") ? `${baseId}-id-err` : `${baseId}-id-hint`
            }
          />
          {errorFor("id") ? (
            <p id={`${baseId}-id-err`} className="text-xs text-destructive">
              {errorFor("id")}
            </p>
          ) : (
            <p id={`${baseId}-id-hint`} className="text-[11px] text-muted-foreground">
              {t("fieldIdHint")}
            </p>
          )}
        </div>
      </div>

      {/* Backend Kind Selection */}
      <fieldset className="grid gap-2" disabled={isBuiltin}>
        <legend className="text-xs font-medium text-foreground">{t("fieldKindLegend")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {BACKEND_KINDS.map(kind => {
            const selected = draft.kind === kind;
            const radioId = `${baseId}-kind-${kind}`;
            return (
              <label
                key={kind}
                htmlFor={radioId}
                className={
                  "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors " +
                  (selected
                    ? "border-primary/55 bg-primary/10 text-foreground"
                    : "border-border/70 bg-[var(--surface-inset)] text-muted-foreground hover:border-border hover:text-foreground") +
                  (isBuiltin ? " cursor-not-allowed opacity-70" : "")
                }
              >
                <input
                  id={radioId}
                  type="radio"
                  name="kind"
                  value={kind}
                  checked={selected}
                  disabled={isBuiltin}
                  onChange={() => {
                    setDraft(prev => ({
                      ...prev,
                      kind,
                      maxGib:
                        prev.maxGib ||
                        (kind === "local"
                          ? String(DEFAULT_LOCAL_MAX_BYTES / (1024 * 1024 * 1024))
                          : ""),
                      localCacheGib:
                        kind === "directory" || kind === "s3"
                          ? prev.localCacheGib ||
                            String(DEFAULT_LOCAL_CACHE_BYTES / (1024 * 1024 * 1024))
                          : "",
                    }));
                    setTestState("idle");
                  }}
                  className="mt-0.5 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <BackendKindIcon kind={kind} />
                    <span>{t(`kinds.${kind}`)}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t(`kindHints.${kind}`)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Quota & Retention Inputs */}
      {draft.kind !== "ephemeral" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${baseId}-max-gib`}>{t("fieldMaxGib")}</Label>
            <Input
              ref={el => {
                fieldRefs.current.maxGib = el;
              }}
              id={`${baseId}-max-gib`}
              name="maxGib"
              type="number"
              min="0.1"
              step="0.5"
              value={draft.maxGib}
              onBlur={() => markTouched("maxGib")}
              onChange={event => updateField("maxGib", event.target.value)}
              placeholder={t("fieldMaxGibPlaceholder")}
              className="font-mono tabular-nums"
              aria-invalid={Boolean(errorFor("maxGib")) || undefined}
              aria-describedby={
                errorFor("maxGib") ? `${baseId}-max-gib-err` : `${baseId}-max-gib-hint`
              }
            />
            {errorFor("maxGib") ? (
              <p id={`${baseId}-max-gib-err`} className="text-xs text-destructive">
                {errorFor("maxGib")}
              </p>
            ) : (
              <p id={`${baseId}-max-gib-hint`} className="text-[11px] text-muted-foreground">
                {t("fieldMaxGibHint")}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${baseId}-max-age`}>{t("fieldMaxAgeHours")}</Label>
            <Input
              ref={el => {
                fieldRefs.current.maxAgeHours = el;
              }}
              id={`${baseId}-max-age`}
              name="maxAgeHours"
              type="number"
              min="1"
              step="1"
              value={draft.maxAgeHours}
              onBlur={() => markTouched("maxAgeHours")}
              onChange={event => updateField("maxAgeHours", event.target.value)}
              placeholder={t("fieldMaxAgeHoursPlaceholder")}
              className="font-mono tabular-nums"
              aria-invalid={Boolean(errorFor("maxAgeHours")) || undefined}
              aria-describedby={
                errorFor("maxAgeHours") ? `${baseId}-max-age-err` : `${baseId}-max-age-hint`
              }
            />
            {errorFor("maxAgeHours") ? (
              <p id={`${baseId}-max-age-err`} className="text-xs text-destructive">
                {errorFor("maxAgeHours")}
              </p>
            ) : (
              <p id={`${baseId}-max-age-hint`} className="text-[11px] text-muted-foreground">
                {t("fieldMaxAgeHoursHint")}
              </p>
            )}
          </div>

          {(draft.kind === "directory" || draft.kind === "s3") && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-cache-gib`}>{t("fieldLocalCacheGib")}</Label>
              <Input
                ref={el => {
                  fieldRefs.current.localCacheGib = el;
                }}
                id={`${baseId}-cache-gib`}
                name="localCacheGib"
                type="number"
                min="0.1"
                step="0.5"
                value={draft.localCacheGib}
                onBlur={() => markTouched("localCacheGib")}
                onChange={event => updateField("localCacheGib", event.target.value)}
                placeholder={t("fieldLocalCacheGibPlaceholder")}
                className="font-mono tabular-nums"
                aria-invalid={Boolean(errorFor("localCacheGib")) || undefined}
                aria-describedby={
                  errorFor("localCacheGib")
                    ? `${baseId}-cache-gib-err`
                    : `${baseId}-cache-gib-hint`
                }
              />
              {errorFor("localCacheGib") ? (
                <p id={`${baseId}-cache-gib-err`} className="text-xs text-destructive">
                  {errorFor("localCacheGib")}
                </p>
              ) : (
                <p id={`${baseId}-cache-gib-hint`} className="text-[11px] text-muted-foreground">
                  {t("fieldLocalCacheGibHint")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* External Directory Configuration */}
      {draft.kind === "directory" && (
        <div className="grid gap-3 rounded-md border border-border/70 bg-[var(--surface-inset)] p-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${baseId}-dir-path`}>{t("fieldDirectoryPath")} *</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                ref={el => {
                  fieldRefs.current.directoryPath = el;
                }}
                id={`${baseId}-dir-path`}
                name="directoryPath"
                required
                value={draft.directoryPath}
                onBlur={() => markTouched("directoryPath")}
                onChange={event => updateField("directoryPath", event.target.value)}
                placeholder={t("fieldDirectoryPathPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm sm:flex-1"
                aria-invalid={Boolean(errorFor("directoryPath")) || undefined}
                aria-describedby={
                  errorFor("directoryPath")
                    ? `${baseId}-dir-path-err`
                    : `${baseId}-dir-path-hint`
                }
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={testState === "testing" || saving}
                onClick={() => void handleRunTest()}
                data-storage-test-backend="directory"
              >
                {testState === "testing" ? (
                  <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                )}
                {t(testState === "testing" ? "testingDirectoryBtn" : "testDirectoryBtn")}
              </Button>
            </div>
            {errorFor("directoryPath") ? (
              <p id={`${baseId}-dir-path-err`} className="text-xs text-destructive">
                {errorFor("directoryPath")}
              </p>
            ) : (
              <p id={`${baseId}-dir-path-hint`} className="text-[11px] text-muted-foreground">
                {t("fieldDirectoryPathHint")}
              </p>
            )}
          </div>

          {testResult && (
            <TestOutcomeBanner result={testResult} t={t} />
          )}
        </div>
      )}

      {/* S3 Object Storage Configuration */}
      {draft.kind === "s3" && (
        <div className="grid gap-3 rounded-md border border-border/70 bg-[var(--surface-inset)] p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={`${baseId}-s3-endpoint`}>{t("fieldS3Endpoint")} *</Label>
              <Input
                ref={el => {
                  fieldRefs.current.s3Endpoint = el;
                }}
                id={`${baseId}-s3-endpoint`}
                name="s3Endpoint"
                type="url"
                required
                value={draft.s3Endpoint}
                onBlur={() => markTouched("s3Endpoint")}
                onChange={event => updateField("s3Endpoint", event.target.value)}
                placeholder={t("fieldS3EndpointPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={Boolean(errorFor("s3Endpoint")) || undefined}
                aria-describedby={errorFor("s3Endpoint") ? `${baseId}-s3-endpoint-err` : undefined}
              />
              {errorFor("s3Endpoint") && (
                <p id={`${baseId}-s3-endpoint-err`} className="text-xs text-destructive">
                  {errorFor("s3Endpoint")}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-s3-region`}>{t("fieldS3Region")} *</Label>
              <Input
                ref={el => {
                  fieldRefs.current.s3Region = el;
                }}
                id={`${baseId}-s3-region`}
                name="s3Region"
                required
                value={draft.s3Region}
                onBlur={() => markTouched("s3Region")}
                onChange={event => updateField("s3Region", event.target.value)}
                placeholder={t("fieldS3RegionPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={Boolean(errorFor("s3Region")) || undefined}
                aria-describedby={errorFor("s3Region") ? `${baseId}-s3-region-err` : undefined}
              />
              {errorFor("s3Region") && (
                <p id={`${baseId}-s3-region-err`} className="text-xs text-destructive">
                  {errorFor("s3Region")}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-s3-bucket`}>{t("fieldS3Bucket")} *</Label>
              <Input
                ref={el => {
                  fieldRefs.current.s3Bucket = el;
                }}
                id={`${baseId}-s3-bucket`}
                name="s3Bucket"
                required
                value={draft.s3Bucket}
                onBlur={() => markTouched("s3Bucket")}
                onChange={event => updateField("s3Bucket", event.target.value)}
                placeholder={t("fieldS3BucketPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={Boolean(errorFor("s3Bucket")) || undefined}
                aria-describedby={errorFor("s3Bucket") ? `${baseId}-s3-bucket-err` : undefined}
              />
              {errorFor("s3Bucket") && (
                <p id={`${baseId}-s3-bucket-err`} className="text-xs text-destructive">
                  {errorFor("s3Bucket")}
                </p>
              )}
            </div>

            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={`${baseId}-s3-prefix`}>{t("fieldS3Prefix")}</Label>
              <Input
                id={`${baseId}-s3-prefix`}
                name="s3Prefix"
                value={draft.s3Prefix}
                onChange={event => updateField("s3Prefix", event.target.value)}
                placeholder={t("fieldS3PrefixPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-s3-ak`}>{t("fieldS3AccessKeyId")} *</Label>
              <Input
                ref={el => {
                  fieldRefs.current.s3AccessKeyId = el;
                }}
                id={`${baseId}-s3-ak`}
                name="s3AccessKeyId"
                required
                value={draft.s3AccessKeyId}
                onBlur={() => markTouched("s3AccessKeyId")}
                onChange={event => updateField("s3AccessKeyId", event.target.value)}
                placeholder={t("fieldS3AccessKeyIdPlaceholder")}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="username"
                className="font-mono text-sm"
                aria-invalid={Boolean(errorFor("s3AccessKeyId")) || undefined}
                aria-describedby={errorFor("s3AccessKeyId") ? `${baseId}-s3-ak-err` : undefined}
              />
              {errorFor("s3AccessKeyId") && (
                <p id={`${baseId}-s3-ak-err`} className="text-xs text-destructive">
                  {errorFor("s3AccessKeyId")}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${baseId}-s3-sk`}>
                  {t("fieldS3SecretAccessKey")}
                  {!hasSavedSecret ? " *" : ""}
                </Label>
                <button
                  type="button"
                  aria-pressed={showSecret}
                  aria-label={t(showSecret ? "hideSecret" : "showSecret")}
                  aria-describedby={secretWarnId}
                  onClick={() => setShowSecret(prev => !prev)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showSecret ? (
                    <EyeOff className="size-3" aria-hidden="true" />
                  ) : (
                    <Eye className="size-3" aria-hidden="true" />
                  )}
                  <span>{t(showSecret ? "hideSecret" : "showSecret")}</span>
                </button>
                <span id={secretWarnId} className="sr-only">
                  {t("showSecretWarning")}
                </span>
              </div>
              <Input
                ref={el => {
                  fieldRefs.current.s3SecretAccessKey = el;
                }}
                id={`${baseId}-s3-sk`}
                name="s3SecretAccessKey"
                type={showSecret ? "text" : "password"}
                required={!hasSavedSecret}
                value={draft.s3SecretAccessKey}
                onBlur={() => markTouched("s3SecretAccessKey")}
                onChange={event => updateField("s3SecretAccessKey", event.target.value)}
                placeholder={t(
                  hasSavedSecret ? "fieldS3SecretPlaceholderSaved" : "fieldS3SecretPlaceholderNew",
                )}
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={Boolean(errorFor("s3SecretAccessKey")) || undefined}
                aria-describedby={
                  errorFor("s3SecretAccessKey") ? `${baseId}-s3-sk-err` : undefined
                }
              />
              {errorFor("s3SecretAccessKey") && (
                <p id={`${baseId}-s3-sk-err`} className="text-xs text-destructive">
                  {errorFor("s3SecretAccessKey")}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label htmlFor={`${baseId}-s3-path-style`} className="text-xs font-medium">
                {t("fieldS3ForcePathStyle")}
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {t("fieldS3ForcePathStyleHint")}
              </p>
            </div>
            <Switch
              id={`${baseId}-s3-path-style`}
              checked={draft.s3ForcePathStyle}
              onCheckedChange={checked => updateField("s3ForcePathStyle", checked)}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testState === "testing" || saving}
              onClick={() => void handleRunTest()}
              data-storage-test-backend="s3"
            >
              {testState === "testing" ? (
                <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Cloud className="size-3.5" aria-hidden="true" />
              )}
              {t(testState === "testing" ? "testingS3Btn" : "testS3Btn")}
            </Button>
          </div>

          {testResult && (
            <TestOutcomeBanner result={testResult} t={t} />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-3">
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          {t("cancelBtn")}
        </Button>
        <Button type="submit" size="sm" disabled={saving} data-storage-save-profile>
          {saving ? t("savingProfileBtn") : t("saveProfileBtn")}
        </Button>
      </div>
    </form>
  );
}

function TestOutcomeBanner({
  result,
  t,
}: {
  result: StorageTestResult;
  t: (key: string) => string;
}) {
  return (
    <div
      role="status"
      data-storage-test-result={result.ok ? "ok" : "error"}
      className={
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs " +
        (result.ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-destructive/40 bg-destructive/10 text-destructive")
      }
    >
      {result.ok ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-mono font-semibold tabular-nums">
          {t(result.ok ? "testOkLatency" : "testFailedLatency").replace(
            "{ms}",
            String(Math.max(0, Math.round(result.latencyMs))),
          )}
        </div>
        {(result.detail || result.error) && (
          <div className="break-words text-[11px] opacity-90">
            {result.ok ? result.detail : result.error || result.detail}
          </div>
        )}
      </div>
    </div>
  );
}
