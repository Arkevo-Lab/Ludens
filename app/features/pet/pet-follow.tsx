"use client";

import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { petStatus, petStatusKey, workspaceLabel, type PetTarget } from "@/lib/pet";
import type { Project } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  AdvancedDiagnosticsDisclosure,
  InlineCopyButton,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-primitives";
import { useLocale, useTranslations } from "@/lib/locale";
import { useRetryFocus } from "@/components/use-retry-focus";
import "@/features/pet/pet-settings.css";

export { usePetFollow } from "@/features/pet/use-pet-follow";
import type { PetFollow } from "@/features/pet/use-pet-follow";
export type { PetFollow } from "@/features/pet/use-pet-follow";

const STOP_TARGET = "!stop";

function targetName(target: PetTarget, projects: Project[], t: (key: string) => string) {
  const project = projects.find(project => project.id === target.project && project.workspace === target.workspace);
  return workspaceLabel(project ?? { id: target.project, workspace: target.workspace }, t);
}

function requestedName(project: string | null, projects: Project[], target: PetTarget | null | undefined, t: (key: string) => string) {
  if (project === null) return t("noSavedTarget");
  const known = projects.find(item => item.id === project);
  return known ? workspaceLabel(known, t) : target?.project === project ? targetName(target, projects, t) : project;
}

export function PetFollowSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { state, pending, reading, readError, writeError, requested, lastReadAt, lastSaved, canWrite } = follow;
  const t = useTranslations("petFollow");
  const ct = useTranslations("connectionSettings");
  const { locale } = useLocale();
  const target = state?.target;
  const options = projects.filter(project => project.workspace);
  const focus = useRetryFocus(reading, readError || writeError);
  const selectedValue = pending && requested !== undefined ? requested ?? STOP_TARGET : target?.project ?? (state?.targetConfigured ? STOP_TARGET : "");
  const knownTarget = target ? targetName(target, projects, t) : state ? t(state.targetConfigured ? "noSavedTarget" : "noSavedChoice") : t("targetUnknown");
  const stale = !!writeError || (!!readError && lastSaved === undefined);
  const observationUnconfirmed = pending || !!readError || !!writeError;
  const statusKey = petStatusKey(state);
  const status = pending ? t("updating") : observationUnconfirmed ? t("statusUnavailable") : petStatus(state, t);
  const consumerError = !observationUnconfirmed ? state?.consumerError : undefined;
  const currentError = !observationUnconfirmed && statusKey === "followError" ? state?.consumer?.error : null;
  const canRead = !reading && !pending;
  const requestLabel = reading ? "readingStatus" : writeError ? "readSavedTarget" : readError || state?.consumerError ? "retryRead" : "refreshStatus";
  const hasDiagnostics = Boolean(target || writeError || readError || consumerError);

  return (
    <div
      ref={focus.target}
      tabIndex={-1}
      data-pet-follow="settings"
      aria-label={t("savedWorkspace")}
      className="grid min-w-0 gap-3 outline-none"
    >
      <SettingsSection title={t("followTargetTitle")} description={t("followTargetDescription")}>
        <SettingsRow
          label={t("savedWorkspace")}
          htmlFor="pet-follow-workspace"
          description={t("savedWorkspaceHelp")}
          descriptionId="pet-follow-help"
          badge={
            state ? (
              <Badge variant="outline" className="pet-follow-save-badge text-primary" data-pet-save-status>
                {!pending && !writeError && !stale && state.targetConfigured && <CheckIcon aria-hidden="true" />}
                {t(pending ? "updating" : writeError ? "saveUnconfirmed" : stale ? "lastKnownLabel" : state.targetConfigured ? "savedLabel" : "notConfigured")}
              </Badge>
            ) : undefined
          }
          control={
            state ? (
              <NativeSelect
                id="pet-follow-workspace"
                aria-label={t("followSelectLabel")}
                aria-describedby="pet-follow-help"
                wrapperClassName="w-full sm:w-64"
                className="w-full aria-disabled:opacity-60"
                value={selectedValue}
                aria-disabled={!canWrite}
                onMouseDown={event => { if (!canWrite) event.preventDefault(); }}
                onKeyDown={event => { if (!canWrite && !["Tab", "Escape"].includes(event.key)) event.preventDefault(); }}
                onChange={event => {
                  const next = event.currentTarget.value;
                  const available = next === STOP_TARGET || options.some(project => project.id === next && project.available !== false);
                  if (!canWrite || !available) { event.currentTarget.value = selectedValue; return; }
                  void follow.follow(next === STOP_TARGET ? null : next);
                }}
              >
                {!state.targetConfigured && <NativeSelectOption value="" disabled>{t("chooseWorkspacePlaceholder")}</NativeSelectOption>}
                <NativeSelectOption value={STOP_TARGET}>{t("stopFollow")}</NativeSelectOption>
                {target && !options.some(project => project.id === target.project) && (
                  <NativeSelectOption value={target.project} disabled>{knownTarget}{t("currentTargetSuffix")}</NativeSelectOption>
                )}
                {requested && requested !== target?.project && !options.some(project => project.id === requested) && (
                  <NativeSelectOption value={requested} disabled>{requestedName(requested, projects, target, t)}</NativeSelectOption>
                )}
                {options.map(project => (
                  <NativeSelectOption key={project.id} value={project.id} disabled={project.available === false}>
                    {workspaceLabel(project, t)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <p className="pet-follow-empty" role="status">{t(readError ? "readUnavailable" : "readingTarget")}</p>
            )
          }
        />

        <SettingsRow
          label={t("desktopStatus")}
          description={t("desktopStatusHelp")}
          meta={
            lastReadAt !== null ? (
              <span className="pet-follow-read-time">
                {t("lastReadAt")}{" "}
                <time dateTime={new Date(lastReadAt).toISOString()}>
                  {new Date(lastReadAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
              </span>
            ) : undefined
          }
          control={
            <div className="pet-follow-desktop-actions">
              <Badge variant="outline" className="pet-follow-desktop-badge whitespace-normal" data-pet-desktop-status>
                <i aria-hidden="true" className={"status-dot " + (!observationUnconfirmed && state?.connected === true ? "online" : "")} />
                {status}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={!canRead}
                className="pet-follow-refresh aria-disabled:opacity-50"
                onClick={event => {
                  if (!canRead) return;
                  focus.remember(event.currentTarget);
                  follow.refresh();
                }}
              >
                <RefreshCwIcon aria-hidden="true" className={reading ? "motion-safe:animate-spin" : ""} />
                {t(requestLabel)}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {pending && requested !== undefined && (
        <p className="pet-follow-saving" role="status">
          {t("savingTarget")} <strong>{requestedName(requested, projects, target, t)}</strong>
        </p>
      )}
      {!observationUnconfirmed && state?.connected === false && target && (
        <p className="pet-follow-desktop-note">{t("savedAwaitingDesktop")}</p>
      )}
      {lastSaved !== undefined && !observationUnconfirmed && (
        <p className="pet-follow-desktop-note" role="status">{t("savedAwaitingStatus")}</p>
      )}
      {state?.targetUnavailable && (
        <Alert><AlertDescription className="text-xs">{t("targetUnavailable")}</AlertDescription></Alert>
      )}
      {writeError && (
        <Alert variant="destructive" data-pet-write-error>
          <AlertDescription className="text-xs">
            <p className="font-medium">{t("saveUnconfirmed")}</p>
            <p>{t("followWriteFailed")}</p>
          </AlertDescription>
        </Alert>
      )}
      {readError && (
        <Alert variant="destructive" data-pet-read-error>
          <AlertDescription className="text-xs">
            <p>{t(lastSaved !== undefined ? "savedAwaitingStatus" : state ? "showingLastTarget" : "readUnavailable")}</p>
          </AlertDescription>
        </Alert>
      )}
      {consumerError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{t("statusUnavailable")}</AlertDescription>
        </Alert>
      )}
      {currentError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{currentError}</AlertDescription>
        </Alert>
      )}

      {hasDiagnostics && (
        <AdvancedDiagnosticsDisclosure summary={writeError || readError || consumerError ? t("technicalDetails") : t("workspaceLocation")}>
          <div className="grid gap-3 text-xs">
            {target && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-[var(--surface-inset)] px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-[11px] text-muted-foreground">{t("workspaceLocation")}</p>
                  <code className="block break-all font-mono text-xs text-foreground">{target.workspace}</code>
                </div>
                <InlineCopyButton
                  text={target.workspace}
                  ariaLabel={t("workspaceLocation")}
                  copiedText={ct("copiedCommand")}
                  failedText={ct("copyFailed")}
                />
              </div>
            )}
            {writeError && (
              <div className="space-y-2">
                <dl className="pet-follow-comparison">
                  <div><dt>{t("lastConfirmed")}</dt><dd>{knownTarget}</dd></div>
                  {requested !== undefined && (
                    <div><dt>{t("requestedTarget")}</dt><dd>{requestedName(requested, projects, target, t)}</dd></div>
                  )}
                </dl>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">
                  {writeError}
                </pre>
              </div>
            )}
            {readError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">
                {readError}
              </pre>
            )}
            {consumerError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">
                {consumerError}
              </pre>
            )}
          </div>
        </AdvancedDiagnosticsDisclosure>
      )}
    </div>
  );
}
