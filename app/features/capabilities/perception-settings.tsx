"use client";

import { useId } from "react";
import { RefreshCw } from "lucide-react";
import type { Project } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdvancedDiagnosticsDisclosure,
  InlineCopyButton,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/ui/settings-primitives";
import { useTranslations } from "@/lib/locale";
import { useRetryFocus } from "@/components/use-retry-focus";
import { usePerceptionSession } from "@/features/capabilities/use-perception-session";
import { PerceptionField } from "@/features/capabilities/perception-field";
import { PerceptionRuntimeStatus } from "@/features/capabilities/perception-runtime-status";
import { PERCEPTION_KEYS, perceptionPatch, perceptionReloadCommand } from "@/features/capabilities/perception-draft";

export function PerceptionSettingsPanel({ project, projects, ready, catalogError, catalogLoading, onRetryCatalog }: {
  project: string; projects: Project[]; ready: boolean; catalogError?: string; catalogLoading?: boolean; onRetryCatalog(): void;
}) {
  const t = useTranslations("perceptionSettings");
  const target = projects.find(item => item.id === project);
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);

  return (
    <section ref={catalogFocus.target} className="grid min-w-0 gap-6" tabIndex={-1} aria-label={t("title")}>
      {catalogError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <p>{t("catalogFailed")}</p>
              <AdvancedDiagnosticsDisclosure summary={t("errorDetails")}>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{catalogError}</pre>
              </AdvancedDiagnosticsDisclosure>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={catalogLoading}
              className="aria-disabled:opacity-50"
              onClick={event => {
                if (!catalogLoading) {
                  catalogFocus.remember(event.currentTarget);
                  onRetryCatalog();
                }
              }}
            >
              {t(catalogLoading ? "retrying" : "retryCatalog")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {target?.workspace ? (
        <WorkspacePerceptionSettings
          key={JSON.stringify([target.id, target.workspace])}
          project={target.id}
          workspace={target.workspace}
        />
      ) : !ready ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">{t("loadingWorkspaces")}</p>
      ) : !catalogError ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">{t("selectWorkspace")}</p>
      ) : null}
    </section>
  );
}

function WorkspacePerceptionSettings({ project, workspace }: { project: string; workspace: string }) {
  const t = useTranslations("perceptionSettings");
  const { state, session } = usePerceptionSession(project, workspace);
  const inheritanceNoteId = useId();
  const pending = state.writeState === "saving";
  const dirty = Object.keys(state.draft).length > 0;
  const { invalid } = perceptionPatch(state.draft);
  const saveBlocked = !session || !state.settings || !!invalid.length || state.writeState === "unconfirmed";
  const saveDisabled = saveBlocked || pending || !dirty;
  const command = perceptionReloadCommand(workspace);
  const saveStatus =
    state.writeState === "unconfirmed"
      ? "writeUnconfirmed"
      : state.writeState === "saving"
        ? "saving"
        : state.writeState === "matched"
          ? "savedValuesMatched"
          : state.writeState === "review"
            ? "reviewAfterRead"
            : state.writeState === "saved"
              ? "savedToWorkspace"
              : !state.settings
                ? "savedUnknown"
                : state.reading
                  ? "readingCached"
                  : "savedValuesLoaded";

  return (
    <div className="grid min-w-0 gap-6" data-perception-editor>
      {state.readError && (
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <p>{t("loadFailed")}</p>
            {state.settings && <p className="text-xs">{t("showingCached")}</p>}
            <AdvancedDiagnosticsDisclosure summary={t("errorDetails")}>
              <pre className="whitespace-pre-wrap break-all font-mono text-xs">{state.readError}</pre>
            </AdvancedDiagnosticsDisclosure>
          </AlertDescription>
        </Alert>
      )}
      {state.writeState === "unconfirmed" && (
        <Alert>
          <AlertDescription className="space-y-2">
            <p>{t("unconfirmedRecovery")}</p>
            {state.writeError && (
              <AdvancedDiagnosticsDisclosure summary={t("errorDetails")}>
                <pre className="whitespace-pre-wrap break-all font-mono text-xs">{state.writeError}</pre>
              </AdvancedDiagnosticsDisclosure>
            )}
          </AlertDescription>
        </Alert>
      )}

      <SettingsSection
        title={t("title")}
        description={
          <span>
            {t("editorDescription")}{" "}
            <span role="status" className="text-foreground/80">
              {t(saveStatus)}
            </span>
          </span>
        }
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={!session || pending || state.reading}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!pending && !state.reading) void session?.refresh();
            }}
          >
            <RefreshCw className={"size-3.5" + (state.reading ? " animate-spin" : "")} aria-hidden="true" />
            {t(state.reading ? "retrying" : state.readError || state.writeState === "unconfirmed" ? "retryRead" : "refresh")}
          </Button>
        }
      >
        {!state.settings ? (
          <p role="status" className="py-5 text-sm text-muted-foreground">
            {t(state.readError ? "loadFailed" : "loading")}
          </p>
        ) : (
          PERCEPTION_KEYS.map(name => (
            <PerceptionField
              key={name}
              name={name}
              saved={state.settings![name]}
              draft={state.draft[name]}
              pending={pending}
              inheritanceNoteId={inheritanceNoteId}
              onEdit={(mode, raw) => session?.edit(name, mode, raw)}
            />
          ))
        )}
      </SettingsSection>

      {state.settings && (
        <p id={inheritanceNoteId} data-perception-inheritance-note className="text-xs leading-relaxed text-muted-foreground">
          {t("inheritanceRule")}
        </p>
      )}

      <div data-perception-draft-bar className="space-y-2">
        {invalid.length > 0 && (
          <p className="text-xs text-destructive" role="alert">
            {t("fixInvalidBeforeSave")}
          </p>
        )}
        <SettingsSaveBar
          dirty={dirty}
          saving={pending}
          disabled={saveBlocked}
          statusText={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{t(dirty ? "unsavedChanges" : "noDraft")}</span>
              {dirty && (
                <Badge variant="outline">
                  {Object.keys(state.draft).length} {t("changedFields")}
                </Badge>
              )}
              <span className="text-muted-foreground">
                · {t(state.persistence === "session" ? "draftKeptInTab" : "draftMemoryOnly")}
              </span>
            </span>
          }
          discardLabel={t("discardDraft")}
          onDiscard={() => {
            if (dirty && !pending) session?.discard();
          }}
          saveLabel={t("save")}
          savingLabel={t("saving")}
          onSave={() => {
            if (!saveDisabled) void session?.save();
          }}
        />
      </div>

      <PerceptionRuntimeStatus
        project={project}
        workspace={workspace}
        settings={pending || state.reading || state.readError || state.writeState === "unconfirmed" ? null : state.settings}
        revision={state.settingsRevision}
        saving={pending}
      />

      <AdvancedDiagnosticsDisclosure summary={t("applyTitle")}>
        <div className="space-y-2.5 text-xs text-muted-foreground">
          <p>{t("applyDescription")}</p>
          <div className="flex items-center gap-2 rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-foreground" data-perception-command>
              {command}
            </code>
            <InlineCopyButton
              text={command}
              ariaLabel={t("copyCommand")}
              copiedText={t("copiedCommand")}
              failedText={t("copyFailed")}
            />
          </div>
          <p>{t("applyDoesNotSave")}</p>
          <p>{t("readOnlyRefreshHint")}</p>
        </div>
      </AdvancedDiagnosticsDisclosure>
    </div>
  );
}
