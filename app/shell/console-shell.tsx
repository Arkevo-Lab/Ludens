"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ArrowRight, History } from "lucide-react";
import { RunAnalysis } from "@/features/live/run-analysis";
import { WorkspaceRunEmpty } from "@/features/workspaces/workspace-run-empty";
import { ActivityFeed } from "@/features/live/activity-feed";
import { ShioriWorkbench } from "@/features/live/shiori-cockpit";
import { PerceptionSettingsPanel } from "@/features/capabilities/perception-settings";
import { ConsoleSidebar, type ConsoleView as View } from "@/shell/console-sidebar";
import { WorkspacePicker, workspaceName } from "@/features/workspaces/workspace-picker";
import { RunPicker } from "@/features/workspaces/run-picker";
import { DesktopBridge } from "@/features/pet/desktop-bridge";
import { DocsView } from "@/features/docs/docs-view";
import { CapabilitiesView } from "@/features/capabilities/capabilities-view";
import { SettingsView } from "@/features/workspaces/settings-view";
import { DevPanel } from "@/shell/dev-panel";
import { TimelinePlayer } from "@/features/replay/timeline-player";
import { replayEvidenceFromSearch, replayEvidencePatch } from "@/features/replay/replay-navigation";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { ArchiveBuild } from "@/shell/archive-build";
import { WorkspacesView } from "@/features/workspaces/workspaces-view";
import { Metric, ObservationPanel, seconds, percent, bytes, clockTime } from "@/features/live/run-visuals";
import { useDashboardController } from "@/shell/use-dashboard-controller";

export default function ConsoleShell() {
  const {t, dt, lt, search, query, view, runControls, projects, catalogReady, catalogError, catalogLoading, project, latest, run, selection, entry, scopeKey, beforeCall, requestedCall, selectedImage, key, error, analysis, analysingRun, data, cycles, activity, call, pet, refresh, panel, setPanel, stopping, auto, status, observedStatus, staleStatus, phase, context, contextTitles, latestRequested, returningLatest, latestScopeChanged, latestFailed, archiveRevision, archiveReady, preparing, pageRange, hasTelemetry, s, verifiedCreationDriver, navigateUrl, navigate, createWithDriver, closeCreateIntent, toggleRefresh, returnToLatest, viewLink, pinned, selectCall, onReplayOverview, retryCatalog, retryingRun, retryRun, stop, runContent, catalogFocus, returnButton, setPausedSelection, setSnapshotRevision, refreshCatalog} = useDashboardController();
  const waitSummary = [
    s?.medianHttpHeadersMs != null ? dt("waitHttp") + " " + seconds(s.medianHttpHeadersMs) : "",
    s?.medianWsWaitMs != null ? dt("waitWs") + " " + seconds(s.medianWsWaitMs) : "",
  ].filter(Boolean).join(" · ");
  const metrics = data ? (
    <section className={view === "live" ? "metrics live-metrics" : "metrics"} aria-label={dt("roundSummary")}>
      <Metric label={dt("metric.completed")} value={String(s!.completed)} detail={dt("metric.totalPrefix") + data.paging.totalCalls + dt("requestsUnit")} />
      {view === "live" ? <Metric label={dt("metric.actions")} value={String(s!.actions)} detail={s!.explicitObserves + dt("metric.observes")} />
        : <Metric label={dt("metric.p95")} value={seconds(s!.p95Ms)} detail={dt("metric.nearestRank")} />}
      <Metric label={dt("metric.median")} value={seconds(s!.medianMs)} detail={waitSummary || dt("metric.noWait")} />
      <Metric label={dt("metric.cache")} value={percent(s!.cacheHit)} detail={dt("metric.afterFirst") + percent(s!.warmCacheHit)} />
    </section>
  ) : null;
  const workspaceScopedView = view === "live" || view === "replay" || view === "perf" || view === "caps" || view === "perception";
  return (
    <div className="console-shell">
      <DesktopBridge onNavigate={navigateUrl} />
      <ConsoleSidebar view={view} viewLink={viewLink} onNavigate={navigateUrl} />
      <div className="console-main">
        <header className={"context-bar" + (view === "live" ? " live-context-bar" : "")}>
          <div className="context-workspace">
            {workspaceScopedView ? (
              <>
                <WorkspacePicker projects={projects} value={selection.project} loading={!catalogReady} error={catalogError}
                  onChange={id => navigate({ project: id, workspace: null, run: null, epoch: null,
                    beforeCall: null, call: null, block: null, image: null, at: null, ...replayEvidencePatch(null) })} />
                <div className="breadcrumb"><i>/</i><strong>{t(`nav.${view}`)}</strong></div>
              </>
            ) : (
              <div className="breadcrumb">
                <span>{t(view === "dev" ? "navSectionDev" : "navSectionGlobal")}</span>
                <i>/</i>
                <strong>{t(`nav.${view}`)}</strong>
              </div>
            )}
          </div>
          <div className="context-controls">
            {!workspaceScopedView && project && (
              <Button asChild size="sm" variant="outline" className="text-muted-foreground">
                <a href={viewLink("live")} onClick={event => {
                  if (!isPlainNavigationClick(event)) return;
                  event.preventDefault();
                  navigateUrl(viewLink("live"));
                }}>
                  {workspaceName(project)} · {t("nav.live")} <ArrowRight className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
            )}
            {runControls && (
              <>
                <RunPicker runs={project?.runs ?? []} latest={latest}
                  value={!refresh && !selection.run ? run : selection.run}
                  onChange={value =>
                    !value && view === "live" ? returnToLatest() : navigate({
                      run: value,
                      epoch: null,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null, ...replayEvidencePatch(null),
                    })
                  }
                />
                <NativeSelect
                  aria-label={dt("epochLabel")}
                  className="max-w-48 text-xs"
                  disabled={!run}
                  value={!refresh && !selection.epoch ? data?.selectedEpoch ?? "" : selection.epoch}
                  onChange={(e) => {
                    setPausedSelection(null);
                    if (!e.target.value && !selection.epoch) setSnapshotRevision(value => value + 1);
                    navigate({
                      project: selection.project,
                      run,
                      epoch: e.target.value,
                      beforeCall: null,
                      call: null,
                      block: null,
                      image: null,
                      at: null, ...replayEvidencePatch(null),
                    });
                  }}
                >
                  <NativeSelectOption value="">
                    {dt("latestEpoch")}
                    {cycles.length ? " · #" + cycles.length : ""}
                  </NativeSelectOption>
                  {view === "replay" && <NativeSelectOption value="all">{dt("allEpochs")}</NativeSelectOption>}
                  {[...cycles].reverse().map((c, i) => (
                    <NativeSelectOption key={c.epoch} value={c.epoch}>
                      #{cycles.length - i} · {clockTime(c.startedAt)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </>
            )}
            {run && (view === "live" || view === "perf") && <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-muted-foreground"
              aria-pressed={refresh}
              title={lt("refreshHint")}
              onClick={toggleRefresh}
            >
              <i className="status-dot" />
              {lt(refresh ? "autoRefreshOn" : "autoRefreshOff")}
            </Button>}
          </div>
        </header>
        <main ref={element => { runContent.current = element; catalogFocus.target.current = element; }}
          tabIndex={runControls ? -1 : undefined} aria-label={runControls ? t(`views.${view}.title`) : undefined}
          className={"page-content outline-none focus-visible:ring-2 focus-visible:ring-ring" + (view === "live" ? " live-page" : "")}>
          {view !== "workspaces" && view !== "docs" && view !== "perception" && view !== "caps" && view !== "live" && (view !== "replay" || entry !== "ready") && <div className={"page-heading" + (view === "settings" ? " mx-auto w-full max-w-5xl" : "")}>
            <div>
              <h1>{t(`views.${view}.title`)}</h1>
              <p>{t(`views.${view}.description`)}</p>
            </div>
            {data && view === "perf" && (
              <Button
                type="button"
                variant="outline"
                disabled={!data?.controlAllowed || !auto || stopping}
                title={data?.controlReason ?? dt("noRun")}
                onClick={stop}
              >
                {stopping ? dt("handingOver") : dt("handover")}
              </Button>
            )}
          </div>}
          {runControls && run && <ArchiveBuild key={selection.project + "/" + run}
            project={selection.project} run={run} onReady={archiveReady} />}
          {runControls && entry !== "catalog-error" && (catalogError || (view !== "replay" && error && !(analysingRun && data))) && (
            <Alert variant="destructive" className="mb-5"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 break-words">{catalogError || error}
              {data && (
                <small>{dt("keepLast")} · {clockTime(data.updatedAt)}</small>
              )}</span>
              <div className="flex flex-wrap gap-2">
                {catalogError && <Button type="button" size="sm" variant="outline" aria-disabled={catalogLoading}
                  className="aria-disabled:opacity-50" onClick={event => retryCatalog(event.currentTarget)}>
                  {t(catalogLoading ? "workspaceRunEmpty.retrying" : "workspaceRunEmpty.retry")}
                </Button>}
                {(view === "live" || analysingRun) && error && <Button type="button" size="sm" variant="outline" aria-disabled={retryingRun}
                  className="aria-disabled:opacity-50" onClick={event => retryRun(event.currentTarget)}>
                  {lt(retryingRun ? "readingRun" : "retryRun")}
                </Button>}
              </div>
            </AlertDescription></Alert>
          )}
          {view === "live" && entry === "ready" && (context || latestRequested) && <section
            className={"live-context-banner "
              + ((context?.kind ?? "latest") === "latest" ? "border-border bg-card" : "border-primary/40 bg-primary/5")}
            aria-labelledby="live-context-title"
          >
            <History className="live-context-icon size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="live-context-copy">
              <h2 id="live-context-title" className="text-sm font-semibold" aria-live="polite">
                {returningLatest ? lt("returning") : lt(contextTitles[(context?.kind ?? "latest")])}
              </h2>
              {data && <p className="live-context-checked">{lt("lastChecked")} {clockTime(data.updatedAt)}</p>}
              <p className={(latestScopeChanged || latestFailed ? "live-context-error" : "live-context-description")}>
                {latestScopeChanged ? lt("scopeChanged") : latestFailed ? lt("refreshFailed") : lt("detail")}
              </p>
            </div>
            <Button ref={returnButton} type="button" size="sm" variant={(context?.kind ?? "latest") === "latest" ? "outline" : "default"}
              className="shrink-0" onClick={returnToLatest} disabled={returningLatest || !latest}>
              {lt("returnLatest")} <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </section>}
          {view === "workspaces" ? (
            <WorkspacesView onChanged={refreshCatalog} onOpen={id => navigateUrl("/?" + new URLSearchParams({ view: "live", project: id }))}
              catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              createIntent={query.get("create") === "1" ? { driverPackage: query.get("driverPackage") ?? "",
                driver: verifiedCreationDriver?.spec === query.get("driverPackage") ? verifiedCreationDriver : undefined } : null}
              onCloseCreateIntent={closeCreateIntent} />
          ) : view === "settings" ? (
            <SettingsView follow={pet} projects={projects} />
          ) : view === "dev" ? (
            <DevPanel navigate={navigate} />
          ) : view === "perception" ? (
            <PerceptionSettingsPanel project={selection.project} projects={projects}
              ready={catalogReady} catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : view === "docs" ? (
            <DocsView search={search} navigate={navigate} />
          ) : view === "caps" ? (
            <CapabilitiesView project={selection.project} ready={catalogReady} catalogError={catalogError}
              workspace={project?.workspace ?? null} onNavigate={navigateUrl}
              catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : runControls && entry !== "ready" ? (
            <WorkspaceRunEmpty state={entry} project={project?.id} workspaceName={workspaceName(project)}
              workspacePath={project?.workspace ?? undefined}
              error={catalogError} retrying={catalogLoading} onRetry={retryCatalog} onNavigate={navigateUrl} />
          ) : view === "replay" ? (
            <TimelinePlayer key={scopeKey} project={selection.project} run={run} epoch={selection.epoch || "latest"}
              onOverview={onReplayOverview} archiveRevision={archiveRevision}
              position={query.get("at")} evidence={replayEvidenceFromSearch(search)}
              onPosition={(at, evidence = null) => navigate({ project: selection.project, run, at: String(at), ...replayEvidencePatch(evidence) })}
              onEvidence={evidence => navigate(replayEvidencePatch(evidence))} />
          ) : !data ? (
            <section className="surface empty-state main-empty">
              <span className="empty-symbol">◫</span>
              <h2>
                {error ? dt("empty.readFailed")
                  : preparing?.key === key ? dt("empty.archiving") : dt("empty.loadingRun")}
              </h2>
              <p>
                {error ? view === "live" ? lt("readFailureHint") : dt("emptyHint.checkService")
                      : preparing?.key === key
                        ? `${dt("archive.read")} ${bytes(preparing.progress.bytes)} / ${bytes(preparing.progress.totalBytes)}${preparing.progress.projection ? ` · ${dt("archive.organizedPrefix")}${preparing.progress.projection.position.toLocaleString()} / ${preparing.progress.projection.total.toLocaleString()}${dt("archive.organizedSuffix")}` : ""}${dt("archive.replayNote")}`
                        : dt("emptyHint.loadingObs")}
              </p>
            </section>
          ) : (
            <>
              {view === "live" ? (
                <ShioriWorkbench
                  project={selection.project}
                  workspace={project?.workspace ?? data.manifest.workspace ?? null}
                  workspaceTitle={workspaceName(project)}
                  data={data}
                  feed={activity}
                  isLiveRun={Boolean(!selection.run || selection.run === latest?.id) && !selection.epoch}
                  phaseLabel={!staleStatus ? phase?.label : null}
                  phaseElapsedMs={!staleStatus ? phase?.elapsedMs : null}
                  selectedBlock={query.get("block") ?? undefined}
                  onSelectBlock={(block) =>
                    navigate({
                      ...pinned,
                      block: block.id,
                      call: block.trace?.modelCallId ?? null,
                      image: null,
                    })
                  }
                  onUpdated={() => {
                    setSnapshotRevision(n => n + 1);
                    activity.latest();
                  }}
                  onOpenPerf={() => navigate({ view: "perf" })}
                  onOpenCaps={() => navigate({ view: "caps" })}
                  onOpenReplay={() => navigate({ view: "replay" })}
                  onReturnLatest={returnToLatest}
                  observationSlot={
                    <ObservationPanel
                      priority
                      data={data}
                      call={call}
                      selectedImage={selectedImage}
                      onImage={(id) => navigate({ ...pinned, image: id })}
                    />
                  }
                />
              ) : (
                <>
                  <div className="run-status">
                    <span className={"status-dot " + (auto && !staleStatus ? "online" : "")} />
                    <strong>{status}</strong>
                    {phase?.elapsedMs != null && !staleStatus && (
                      <span>{dt("elapsed")} {seconds(phase.elapsedMs)}</span>
                    )}
                    <i />
                    <span>{data.manifest.model ?? dt("deviceOnly")}</span>
                    <span className="run-time">
                      {Math.floor(s!.elapsedSeconds / 60)}{dt("min")}{" "}
                      {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} <b> / </b>{dt("budget")}{" "}
                      {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}
                    </span>
                  </div>
                  <RunAnalysis
                    data={data}
                    detailData={analysis.detail}
                    call={call}
                    requestedCall={requestedCall}
                    pending={!analysis.detail}
                    error={error}
                    retrying={retryingRun}
                    metrics={metrics}
                    pageRange={pageRange}
                    panel={panel}
                    onPanel={setPanel}
                    onSelect={selectCall}
                    onInspect={() => navigate({ ...pinned, view: "live", call: call?.id ?? null })}
                    onRetry={retryRun}
                    onFollowLatest={() => navigate({ beforeCall: null, call: null, image: null, block: null })}
                    onLoadMore={() => navigate({ ...pinned, beforeCall: String(data.paging.beforeCall), call: null, image: null, block: null })}
                  />
                  <section className="surface telemetry-summary">
                    <div>
                      <h2>{dt("telemetry.title")}</h2>
                      <p>{dt("telemetry.hint")}</p>
                    </div>
                    <div className="source-chips">
                      {data.telemetry.sources.map((source) => (
                        <span key={source.component}>
                          <i className={"source-dot " + source.component} />
                          {source.component}
                          <b>{source.count.toLocaleString()}</b>
                        </span>
                      ))}
                    </div>
                    <div className="telemetry-counts">
                      <span>
                        {dt("telemetry.nativeLoops")}{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.shiori.nativeLoops.length
                            : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.capCalls")}{" "}
                        <b>
                          {hasTelemetry
                            ? data.telemetry.capabilities.stats.started
                            : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.devOps")}{" "}
                        <b>
                          {hasTelemetry ? data.telemetry.devices.started : "—"}
                        </b>
                      </span>
                      <span>
                        {dt("telemetry.errors")} <b>{s!.errors}</b>
                      </span>
                      <span>
                        {dt("telemetry.compactions")} <b>{s!.compactions}</b>
                      </span>
                    </div>
                  </section>
                  <details className="run-provenance">
                    <summary>{dt("provenance.title")}</summary>
                    <dl className="fact-grid">
                      <div>
                        <dt>Shiori</dt>
                        <dd>
                          {data.manifest.shiori?.implementation ?? dt("provenance.unrecorded")}{" "}
                          {data.manifest.shiori?.implementationVersion}
                        </dd>
                      </div>
                      <div>
                        <dt>{dt("provenance.compactThresh")}</dt>
                        <dd>
                          {data.manifest.compactionThreshold?.toLocaleString() ??
                            dt("provenance.default")}
                        </dd>
                      </div>
                      <div>
                        <dt>Workspace</dt>
                        <dd>{data.manifest.workspace}</dd>
                      </div>
                      <div>
                        <dt>Run</dt>
                        <dd>{data.run}</dd>
                      </div>
                      <div>
                        <dt>Epoch</dt>
                        <dd>
                          {data.selectedEpoch ?? dt("provenance.notTaken")}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      {dt("provenance.notePrefix")}{pageRange}{dt("provenance.noteSuffix")}
                    </p>
                  </details>
                </>
              )}
              {view !== "live" && (
                <footer className="page-footer">
                  <span>ⓘ {dt("footer.perf")}</span>
                  <span>{dt("updatedAt")} {clockTime(data.updatedAt)}</span>
                </footer>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );

}