"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ArrowRight, History } from "lucide-react";
import { RunAnalysis } from "@/features/benchmark/run-analysis";
import { WorkspaceRunEmpty } from "@/features/workspaces/workspace-run-empty";
import { ActivityFeed } from "@/features/live/activity-feed";
import { PerceptionSettingsPanel } from "@/features/capabilities/perception-settings";
import { ConsoleSidebar, type ConsoleView as View } from "@/shell/console-sidebar";
import { WorkspacePicker, workspaceName } from "@/features/workspaces/workspace-picker";
import { RunPicker } from "@/features/workspaces/run-picker";
import { DesktopBridge } from "@/features/pet/desktop-bridge";
import { BenchmarkCases } from "@/features/benchmark/benchmark-cases";
import { DocsView } from "@/features/docs/docs-view";
import { CapabilitiesView } from "@/features/capabilities/capabilities-view";
import { SettingsView } from "@/features/workspaces/settings-view";
import { DevPanel } from "@/shell/dev-panel";
import { TimelinePlayer } from "@/features/replay/timeline-player";
import { replayEvidenceFromSearch, replayEvidencePatch } from "@/features/replay/replay-navigation";
import { ArchiveBuild } from "@/shell/archive-build";
import { WorkspacesView } from "@/features/workspaces/workspaces-view";
import { Metric, ObservationPanel, seconds, percent, bytes, clockTime } from "@/features/live/run-visuals";
import { useDashboardController } from "@/shell/use-dashboard-controller";

export default function ConsoleShell() {
  const {t, dt, lt, search, query, view, benchmarkCases, runControls, projects, catalogReady, catalogError, catalogLoading, project, latest, run, selection, entry, scopeKey, beforeCall, requestedCall, selectedImage, key, error, analysis, analysingRun, data, cycles, activity, call, pet, refresh, panel, setPanel, stopping, auto, status, observedStatus, staleStatus, phase, context, contextTitles, latestRequested, returningLatest, latestScopeChanged, latestFailed, archiveRevision, archiveReady, preparing, pageRange, hasTelemetry, s, verifiedCreationDriver, navigateUrl, navigate, createWithDriver, closeCreateIntent, toggleRefresh, returnToLatest, viewLink, pinned, selectCall, onReplayOverview, retryCatalog, retryingRun, retryRun, stop, runContent, catalogFocus, returnButton, setPausedSelection, setSnapshotRevision, refreshCatalog} = useDashboardController();
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
  return (
    <div className="console-shell">
      <DesktopBridge onNavigate={navigateUrl} />
      <ConsoleSidebar projects={projects} view={view} viewLink={viewLink} onNavigate={navigateUrl} pet={pet}
        petProject={benchmarkCases || view === "docs" || view === "settings" || view === "workspaces" ? undefined : project}
        onPetSettings={() => navigate({ view: "settings" })} />
      <div className="console-main">
        <header className={"context-bar" + (view === "live" ? " live-context-bar" : "")}>
          <div className="context-workspace">
            <WorkspacePicker projects={projects} value={selection.project} loading={!catalogReady} error={catalogError}
              onChange={id => navigate({ project: id, workspace: null, run: null, epoch: null,
                beforeCall: null, call: null, block: null, image: null, at: null, ...replayEvidencePatch(null),
                case: null, caseDigest: null, result: null, baseline: null, verification: null,
                baselineVerification: null, report: null, baselineReport: null,
                verificationCursor: null, evidenceCursor: null, benchCursor: null })} />
            <div className="breadcrumb"><i>/</i><strong>{t(`nav.${view}`)}</strong></div>
          </div>
          <div className="context-controls">
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
                    {data?.manifest.kind === "benchmark" && !cycles.length
                      ? dt("fullBenchRun")
                      : dt("latestEpoch")}
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
            {(run || benchmarkCases) && (view === "live" || view === "benchmark") && <Button
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
          {view !== "workspaces" && view !== "docs" && view !== "perception" && view !== "caps" && (view !== "replay" || entry !== "ready") && <div className={"page-heading" + (view === "live" ? " live-page-heading" : view === "settings" ? " mx-auto w-full max-w-5xl" : "")}>
            <div>
              <h1>{benchmarkCases ? t("benchmark.casesTitle") : t(`views.${view}.title`)}</h1>
              <p>
                {benchmarkCases ? t("benchmark.casesDescription") : t(`views.${view}.description`)}
              </p>
            </div>
            {data && (view === "live" || (view === "benchmark" && !benchmarkCases)) && (
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
          {view === "benchmark" && (
            <nav className="mb-5 flex gap-2 border-b pb-3" aria-label={dt("benchNavLabel")}>
              {[
                ["analysis", dt("benchAnalysis")],
                ["cases", dt("benchCases")],
              ].map(([tab, title]) => (
                <Button
                  type="button"
                  size="sm"
                  key={tab}
                  aria-pressed={benchmarkCases === (tab === "cases")}
                  variant={benchmarkCases === (tab === "cases") ? "secondary" : "ghost"}
                  onClick={() =>
                    navigate({ bench: tab === "cases" ? "cases" : null })
                  }
                >
                  {title}
                </Button>
              ))}
            </nav>
          )}
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
            <WorkspacesView onChanged={refreshCatalog} onOpen={id => navigateUrl("/?" + new URLSearchParams({ view: "caps", project: id }))}
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
              workspace={project?.workspace ?? null} onCreateWithDriver={createWithDriver} onNavigate={navigateUrl}
              catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : runControls && entry !== "ready" ? (
            <WorkspaceRunEmpty state={entry} project={project?.id} workspaceName={workspaceName(project)}
              benchmarkRun={project?.runs.find(r => r.kind === "benchmark" || r.benchmark)?.id}
              error={catalogError} retrying={catalogLoading} onRetry={retryCatalog} onNavigate={navigateUrl} />
          ) : view === "replay" ? (
            <TimelinePlayer key={scopeKey} project={selection.project} run={run} epoch={selection.epoch || "latest"}
              onOverview={onReplayOverview} archiveRevision={archiveRevision}
              position={query.get("at")} evidence={replayEvidenceFromSearch(search)}
              onPosition={(at, evidence = null) => navigate({ project: selection.project, run, at: String(at), ...replayEvidencePatch(evidence) })}
              onEvidence={evidence => navigate(replayEvidencePatch(evidence))} />
          ) : benchmarkCases ? (
            <BenchmarkCases
              workspace={selection.project}
              workspacePath={project?.workspace ?? null}
              ready={catalogReady}
              workspaceAvailable={project?.available !== false}
              catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              search={search}
              refresh={refresh}
              navigate={navigate}
              onNavigate={navigateUrl}
            />
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
              <div className={"run-status" + (view === "live" ? " live-host-status" : "")}>
                <span className={"status-dot " + (auto && !staleStatus ? "online" : "")} />
                <strong>{view === "live" ? <>{staleStatus && `${lt("hostSnapshot")}: `}{observedStatus}</> : status}</strong>
                {view === "live" && phase?.label && !staleStatus && <span>{phase.label}</span>}
                {phase?.elapsedMs != null && !staleStatus && (
                  <span>{dt("elapsed")} {seconds(phase.elapsedMs)}</span>
                )}
                {view !== "live" && <><i />
                <span>{data.manifest.model ?? dt("deviceOnly")}</span>
                <span className="run-time">
                  {Math.floor(s!.elapsedSeconds / 60)}{dt("min")}{" "}
                  {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} <b> / </b>{dt("budget")}{" "}
                  {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}
                </span></>}
              </div>
              {view === "live" ? (
                <>
                <div className="live-grid">
                  <div className="live-observation">
                    <ObservationPanel
                      priority
                      data={data}
                      call={call}
                      selectedImage={selectedImage}
                      onImage={(id) => navigate({ ...pinned, image: id })}
                    />
                  </div>
                  <ActivityFeed
                    key={scopeKey + "/" + data.selectedEpoch}
                    feed={activity}
                    expectedEpoch={data.selectedEpoch}
                    selectedBlock={query.get("block") ?? undefined}
                    onSelect={(block) =>
                      navigate({
                        ...pinned,
                        block: block.id,
                        call: block.trace?.modelCallId ?? null,
                        image: null,
                      })
                    }
                  />
                </div>
                <details className="surface live-run-details">
                  <summary><span>{lt("runDetails")}</span><span className="live-run-summary">{s!.completed} {dt("requestsUnit")} · {seconds(s!.medianMs)}</span></summary>
                  <div className="live-run-details-content">
                    <p className="live-run-context-help">{lt("detail")}</p>
                    <dl className="live-run-facts">
                      <div><dt>{lt("model")}</dt><dd>{data.manifest.model ?? dt("deviceOnly")}</dd></div>
                      <div><dt>{dt("elapsed")}</dt><dd>{Math.floor(s!.elapsedSeconds / 60)}{dt("min")} {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} / {dt("budget")} {Math.floor(data.manifest.seconds / 60)}{dt("minLong")}</dd></div>
                      <div><dt>{lt("drivers")}</dt><dd>{data.manifest.drivers.map(driver => driver.id).join(" · ") || "—"}</dd></div>
                    </dl>
                    {metrics}
                    <Button type="button" variant="ghost" size="xs"
                      className="h-auto justify-start whitespace-normal text-left text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => navigate({ view: "benchmark" })}>
                      {dt("checkPerf")} ↗
                    </Button>
                  </div>
                </details>
                </>
              ) : (
                <>
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
                          {data.selectedEpoch ??
                            (data.manifest.benchmark
                              ? dt("provenance.fullRun")
                              : dt("provenance.notTaken"))}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      {dt("provenance.notePrefix")}{pageRange}{dt("provenance.noteSuffix")}
                    </p>
                  </details>
                </>
              )}
              <footer className="page-footer">
                <span>
                  ⓘ{" "}
                  {view === "live"
                    ? dt("footer.live")
                    : dt("footer.bench")}
                </span>
                <span>{dt("updatedAt")} {clockTime(data.updatedAt)}</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );

}