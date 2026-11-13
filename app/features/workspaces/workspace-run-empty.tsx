"use client";

import { useId, useRef } from "react";
import { Folder, HardDrive, Play, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { PixelMark } from "@/components/ui/pixel-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useWorkspaceService } from "@/lib/use-workspace-service";
import { workspaceRunLinks, type WorkspaceRunEntry } from "@/lib/workspace-run-entry";
import { workspaceUpCommand } from "@/features/workspaces/workspace-create-model";

export function WorkspaceRunEmpty({
  state,
  project,
  workspaceName,
  workspacePath,
  error,
  retrying,
  onRetry,
  onNavigate,
}: {
  state: Exclude<WorkspaceRunEntry, "ready">;
  project?: string;
  workspaceName?: string;
  workspacePath?: string;
  error: string;
  retrying: boolean;
  onRetry(control: HTMLButtonElement): void;
  onNavigate(url: string): void;
}) {
  const t = useTranslations("workspaceRunEmpty");
  const { locale } = useLocale();
  const headingId = useId();
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const links = workspaceRunLinks(project, locale);
  const loading = state === "loading-catalog";
  const copy = state;
  const isNoRun = state === "no-run";

  const studioHref = project
    ? `/?view=perception&project=${encodeURIComponent(project)}`
    : null;
  const basewareHref = project
    ? `/?view=baseware&project=${encodeURIComponent(project)}`
    : null;

  const service = useWorkspaceService({
    workspaceId: isNoRun ? project : null,
    fallbackError: t("startFailedTitle"),
    onSuccess: () => {
      if (startButtonRef.current) {
        onRetry(startButtonRef.current);
      } else if (project) {
        onNavigate(`/?view=live&project=${encodeURIComponent(project)}`);
      }
    },
  });

  const action = (href: string, label: string, primary = false, icon?: React.ReactNode) => (
    <Button
      asChild
      variant={primary ? "default" : "outline"}
      className="h-auto min-h-9 whitespace-normal py-2"
    >
      <a
        href={href}
        onClick={event => {
          if (!isPlainNavigationClick(event)) return;
          event.preventDefault();
          onNavigate(href);
        }}
      >
        {icon}
        {label}
      </a>
    </Button>
  );

  const starting = service.pendingOperation === "up";

  return (
    <Card aria-labelledby={headingId}>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-4">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-[var(--surface-inset)] text-[var(--gold)]"
          aria-hidden="true"
        >
          {loading || starting ? (
            <PixelMark loading size={16} className="text-foreground" />
          ) : (
            <Folder className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          {workspaceName && (
            <p className="break-words font-mono text-xs text-muted-foreground">
              {workspaceName}
            </p>
          )}
          <div className="space-y-2" role={loading ? "status" : undefined}>
            <h2 id={headingId} className="text-base font-semibold">
              {t(`${copy}.title`)}
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t(`${copy}.description`)}
            </p>
          </div>

          {isNoRun && service.error && (
            <Alert variant="destructive" data-empty-service-error="">
              <AlertTitle className="flex items-center justify-between gap-2">
                <span>{t("startFailedTitle")}</span>
                <button
                  type="button"
                  aria-label={t("dismissError")}
                  onClick={service.clearError}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </AlertTitle>
              <AlertDescription className="space-y-2.5">
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-background/80 p-2 font-mono text-xs text-foreground">
                  {service.error}
                </pre>
                {(basewareHref || studioHref) && (
                  <div className="flex flex-wrap gap-2">
                    {basewareHref &&
                      action(
                        basewareHref,
                        t("checkBaseware"),
                        false,
                        <HardDrive className="size-3.5" aria-hidden="true" />,
                      )}
                    {studioHref &&
                      action(
                        studioHref,
                        t("openStudio"),
                        false,
                        <SlidersHorizontal className="size-3.5" aria-hidden="true" />,
                      )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {state === "catalog-error" && (
            <Alert variant="destructive">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          )}

          {!loading && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {state === "catalog-error" ? (
                <Button
                  type="button"
                  aria-disabled={retrying}
                  className="aria-disabled:opacity-50"
                  onClick={event => {
                    if (!retrying) onRetry(event.currentTarget);
                  }}
                >
                  <RefreshCw className={retrying ? "animate-spin" : undefined} />
                  {t(retrying ? "retrying" : "retry")}
                </Button>
              ) : isNoRun && project ? (
                <>
                  <Button
                    ref={startButtonRef}
                    type="button"
                    disabled={service.busy}
                    onClick={() => void service.startWorkspace()}
                    data-empty-start-workspace=""
                  >
                    {starting ? (
                      <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="size-3.5 fill-current" aria-hidden="true" />
                    )}
                    {t(starting ? "startingWorkspace" : "startWorkspace")}
                  </Button>
                  {studioHref &&
                    action(
                      studioHref,
                      t("openStudio"),
                      false,
                      <SlidersHorizontal className="size-3.5" aria-hidden="true" />,
                    )}
                  {basewareHref &&
                    action(
                      basewareHref,
                      t("checkBaseware"),
                      false,
                      <HardDrive className="size-3.5" aria-hidden="true" />,
                    )}
                  {links.capabilities && action(links.capabilities, t("capabilities"))}
                </>
              ) : isNoRun && links.capabilities ? (
                action(links.capabilities, t("capabilities"), true)
              ) : (
                action(links.workspaces, t("workspaces"), true)
              )}
              {state !== "catalog-error" && action(links.quickstart, t("quickstart"))}
              {isNoRun && action(links.workspaces, t("switchWorkspace"))}
            </div>
          )}

          {isNoRun && workspacePath && (
            <details className="pt-0.5 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium hover:text-foreground">
                {t("cliCommandSummary")}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs text-foreground">
                {workspaceUpCommand(workspacePath)}
              </pre>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
