"use client";
import { useRef, useState, type CSSProperties, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { MenuIcon, PanelLeft, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PixelMark } from "@/components/ui/pixel-mark";
import { RunAnalysis } from "@/features/live/run-analysis";
import { WorkspaceRunEmpty } from "@/features/workspaces/workspace-run-empty";
import { ShioriWorkbench } from "@/features/live/shiori-cockpit";
import { EventPoolOverviewPanel } from "@/features/live/event-pool-panel";
import { WorkspaceStudioView } from "@/features/workspaces/workspace-studio-view";
import { ConsoleSidebar } from "@/shell/console-sidebar";
import { DesktopQuickSwitcher } from "@/shell/desktop-quick-switcher";
import { DesktopTitlebar } from "@/shell/desktop-titlebar";
import { formatDesktopShortcut, useDesktopWindow } from "@/shell/use-desktop-window";
import { WorkspacePicker, workspaceName } from "@/features/workspaces/workspace-picker";
import { RunPicker } from "@/features/workspaces/run-picker";
import { DesktopBridge } from "@/features/pet/desktop-bridge";
import { DocsView } from "@/features/docs/docs-view";
import { CapabilitiesView } from "@/features/capabilities/capabilities-view";
import { BasewareView } from "@/features/baseware/baseware-view";
import { SettingsView } from "@/features/workspaces/settings-view";
import { DevPanel } from "@/shell/dev-panel";
import { TimelinePlayer } from "@/features/replay/timeline-player";
import { replayEvidenceFromSearch, replayEvidencePatch } from "@/features/replay/replay-navigation";
import { ArchiveBuild } from "@/shell/archive-build";
import { WorkspacesView } from "@/features/workspaces/workspaces-view";
import { Metric, ObservationPanel, seconds, compactDuration, percent, bytes, clockTime } from "@/features/live/run-visuals";
import { useTranslations } from "@/lib/locale";
import { useDashboardController } from "@/shell/use-dashboard-controller";

type ShellHeaderSlots = {
  runPicker?: ReactNode;
  handoverSlot?: ReactNode;
  mobileNavSlot?: ReactNode;
};

const SlottedShioriWorkbench = ShioriWorkbench as ComponentType<
  ComponentProps<typeof ShioriWorkbench> & Pick<ShellHeaderSlots, "runPicker" | "mobileNavSlot">
>;
const SlottedTimelinePlayer = TimelinePlayer as ComponentType<
  ComponentProps<typeof TimelinePlayer> & Pick<ShellHeaderSlots, "runPicker" | "mobileNavSlot">
>;
const SlottedRunAnalysis = RunAnalysis as ComponentType<
  ComponentProps<typeof RunAnalysis> & ShellHeaderSlots
>;

export default function ConsoleShell() {
  const {t, dt, lt, search, query, view, runControls, projects, catalogReady, catalogError, catalogLoading, project, latest, run, selection, entry, scopeKey, beforeCall, requestedCall, selectedImage, key, error, analysis, analysingRun, data, cycles, activity, call, pet, refresh, panel, setPanel, stopping, auto, status, staleStatus, phase, archiveRevision, archiveReady, preparing, pageRange, hasTelemetry, s, verifiedCreationDriver, navigateUrl, navigate, closeCreateIntent, returnToLatest, viewLink, pinned, selectCall, onReplayOverview, retryCatalog, retryingRun, retryRun, stop, runContent, catalogFocus, setSnapshotRevision, refreshRun, refreshCatalog, liveJumpTarget, activeLiveSegment, setActiveLiveSegment, jumpToLiveSegment, clearLiveJumpTarget} = useDashboardController();
  const st = useTranslations("consoleSidebar");
  const ct = useTranslations("desktopChrome");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const desktop = useDesktopWindow({
    search,
    onNavigate: navigateUrl,
    mobileNavOpen,
    onMobileNavOpenChange: setMobileNavOpen,
  });
  const openReplayAtFrame = (frame: { run?: string; at?: number; record: string; sequence: number }) => {
    navigate({
      view: "replay",
      project: selection.project,
      run: frame.run || run,
      epoch: selection.epoch || null,
      at: frame.at != null && Number.isFinite(frame.at) ? String(Math.round(frame.at)) : null,
      call: null,
      beforeCall: null,
      block: null,
      image: null,
      ...replayEvidencePatch({ kind: "frame", record: frame.record, sequence: frame.sequence }),
    });
  };
  const waitSummary = [
    s?.medianHttpHeadersMs != null ? dt("waitHttp") + " " + seconds(s.medianHttpHeadersMs) : "",
    s?.medianWsWaitMs != null ? dt("waitWs") + " " + seconds(s.medianWsWaitMs) : "",
  ].filter(Boolean).join(" · ");
  const eff = data?.telemetry.efficiency;
  const clampedAutonomyRatio = eff?.autonomyActionRatio != null ? Math.min(1, eff.autonomyActionRatio) : null;
  const sampler = data?.telemetry.perception.sampler;
  const metrics = data ? (
    <section className={view === "live" ? "metrics live-metrics" : "metrics perf-metrics"} aria-label={dt("roundSummary")}>
      <Metric label={dt("metric.completed")} value={String(s!.completed)} detail={dt("metric.totalPrefix") + data.paging.totalCalls + dt("requestsUnit")} />
      {view === "live" ? <Metric label={dt("metric.actions")} value={String(s!.actions)} detail={s!.explicitObserves + dt("metric.observes")} />
        : <Metric label={dt("metric.p95")} value={seconds(s!.p95Ms)} detail={dt("metric.nearestRank")} />}
      <Metric label={dt("metric.median")} value={seconds(s!.medianMs)} detail={waitSummary || dt("metric.noWait")} />
      <Metric label={dt("metric.cache")} value={percent(s!.cacheHit)} detail={dt("metric.afterFirst") + percent(s!.warmCacheHit)} />
      {view === "perf" && (
        <>
          <Metric
            label={dt("metric.decodeSpeed")}
            value={eff?.medianOutputTokensPerSecond != null ? `${eff.medianOutputTokensPerSecond.toFixed(1)} tok/s` : "—"}
            detail={dt("metric.decodeMedian") + " " + seconds(eff?.medianDecodeMs)}
          />
          <Metric
            label={dt("metric.dutyCycle")}
            value={percent(eff?.modelTimeRatio)}
            detail={dt("metric.deviceDuty") + " " + percent(eff?.deviceActionDutyCycle)}
          />
          <Metric
            label={dt("metric.samplerHz")}
            value={sampler?.latestRealizedHz != null ? `${sampler.latestRealizedHz.toFixed(1)} Hz` : "—"}
            detail={dt("metric.samplerUtil") + " " + percent(sampler?.latestUtilization) + (sampler?.windows ? ` · ${sampler.windows}w` : "")}
          />
          <Metric
            label={dt("metric.autonomy")}
            value={percent(clampedAutonomyRatio)}
            detail={dt("metric.pythonDuty") + " " + percent(eff?.localPythonTimeRatio) + ` · ${data.telemetry.capabilities.localPython.started} calls`}
          />
        </>
      )}
    </section>
  ) : null;
  const workspaceScopedView = view === "live" || view === "replay" || view === "perf" || view === "caps" || view === "perception" || view === "baseware";
  const workspaceSlot = (
    <WorkspacePicker
      variant="sidebar"
      muted={!workspaceScopedView}
      projects={projects}
      value={selection.project}
      loading={!catalogReady}
      error={catalogError}
      onChange={id => {
        setMobileNavOpen(false);
        navigate({
          project: id,
          workspace: null,
          run: null,
          epoch: null,
          beforeCall: null,
          call: null,
          block: null,
          image: null,
          at: null,
          ...replayEvidencePatch(null),
        });
      }}
    />
  );
  const contextualRunPicker = runControls ? (
    <RunPicker
      variant="compact"
      runs={project?.runs ?? []}
      latest={latest}
      cycles={view === "live" ? cycles : undefined}
      quickJump={view === "live"}
      value={view === "live" ? (activeLiveSegment || liveJumpTarget?.value || "") : selection.run}
      onChange={value => {
        if (view === "live") {
          jumpToLiveSegment(value);
          return;
        }
        if (!value) {
          setSnapshotRevision(rev => rev + 1);
        }
        navigate({
          run: value || null,
          epoch: null,
          beforeCall: null,
          call: null,
          block: null,
          image: null,
          at: null,
          ...replayEvidencePatch(null),
        });
      }}
    />
  ) : null;
  const expandSidebarTitle = ct("toggleSidebarHint")
    .replace("{action}", ct("expandSidebar"))
    .replace("{shortcut}", formatDesktopShortcut(desktop.platform, "B"));
  const quickSwitcherTitle = ct("quickSwitcherHint").replace(
    "{shortcut}",
    formatDesktopShortcut(desktop.platform, "K"),
  );
  const mobileNavButton = (
    <>
      {!desktop.active && (
        <Button
          ref={mobileNavTriggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mobile-nav-trigger min-[681px]:hidden"
          aria-expanded={mobileNavOpen}
          aria-label={st(mobileNavOpen ? "menuClose" : "menuOpen")}
          title={st(mobileNavOpen ? "menuClose" : "menuOpen")}
          onClick={() => setMobileNavOpen(open => !open)}
        >
          <MenuIcon className="size-4" aria-hidden="true" />
        </Button>
      )}
      {!desktop.active && desktop.sidebarCollapsed && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="web-sidebar-expand-trigger max-[680px]:hidden"
          aria-label={ct("expandSidebar")}
          title={expandSidebarTitle}
          onClick={desktop.toggleSidebar}
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </Button>
      )}
    </>
  );
  const perfHandoverSlot = data && (auto || stopping) ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 shrink-0 px-2.5 text-xs"
      disabled={!data.controlAllowed || !auto || stopping}
      title={data.controlReason ?? dt("noRun")}
      onClick={stop}
    >
      {stopping ? dt("handingOver") : dt("handover")}
    </Button>
  ) : null;
  const hasWorkbenchHeader =
    (view === "replay" && entry === "ready") ||
    ((view === "live" || view === "perf") && entry === "ready" && Boolean(data));
  const hasContextualBarPicker = Boolean(runControls && entry === "ready" && contextualRunPicker);
  const activeWorkspaceLabel = workspaceScopedView ? workspaceName(project) : "";
  return (
    <div
      className="desktop-shell-root"
      data-desktop-chrome={desktop.active ? "true" : undefined}
      data-desktop-platform={desktop.active ? desktop.platform : undefined}
      style={{ "--shell-topbar-height": `${desktop.layout.topbarHeightPx}px` } as CSSProperties}
    >
      <DesktopTitlebar
        active={desktop.active}
        platform={desktop.platform}
        captionStyle={desktop.captionStyle}
        titlebarHeight={desktop.titlebarHeight}
        maximized={desktop.maximized}
        fullScreen={desktop.fullScreen}
        focused={desktop.focused}
        isPreview={desktop.isPreview}
        hasNativeMacTrafficLights={desktop.hasNativeMacTrafficLights}
        sidebarCollapsed={desktop.sidebarCollapsed}
        mobileNavOpen={mobileNavOpen}
        workspaceTitle={activeWorkspaceLabel || undefined}
        viewTitle={t(`nav.${view}`)}
        canGoBack={desktop.canGoBack}
        canGoForward={desktop.canGoForward}
        companionAvailable={desktop.companionAvailable}
        companionVisible={desktop.companionVisible}
        onToggleSidebar={desktop.toggleSidebar}
        onGoBack={() => void desktop.goBack()}
        onGoForward={() => void desktop.goForward()}
        onOpenQuickSwitcher={() => desktop.setQuickSwitcherOpen(true)}
        onReload={() => void desktop.reload()}
        onToggleCompanion={() => void desktop.toggleCompanion()}
        onMinimize={() => void desktop.minimize()}
        onToggleMaximize={() => void desktop.toggleMaximize()}
        onTogglePreviewFullScreen={desktop.togglePreviewFullScreen}
        onClose={() => void desktop.close()}
        onTitlebarDoubleClick={() => void desktop.handleTitlebarDoubleClick()}
        onSelectPreviewPlatform={desktop.setPreviewPlatform}
      />
      <div
        className="console-shell"
        data-sidebar-collapsed={desktop.sidebarCollapsed ? "true" : undefined}
        data-desktop-chrome={desktop.active ? "true" : undefined}
      >
        <DesktopBridge onNavigate={navigateUrl} />
        <ConsoleSidebar
          view={view}
          viewLink={viewLink}
          onNavigate={navigateUrl}
          workspaceSlot={workspaceSlot}
          mobileOpen={mobileNavOpen}
          onMobileOpenChange={setMobileNavOpen}
          mobileTriggerRef={mobileNavTriggerRef}
          collapsed={desktop.sidebarCollapsed}
          onToggleCollapse={desktop.toggleSidebar}
          collapseShortcut={formatDesktopShortcut(desktop.platform, "B")}
          desktopChrome={desktop.active}
        />
        <div className="console-main">
          {!hasWorkbenchHeader && (!desktop.active || hasContextualBarPicker) && (
            <header className="mobile-shell-bar">
              {!desktop.active && (
                <Button
                  ref={mobileNavTriggerRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="mobile-nav-trigger min-[681px]:hidden"
                  aria-expanded={mobileNavOpen}
                  aria-label={st(mobileNavOpen ? "menuClose" : "menuOpen")}
                  title={st(mobileNavOpen ? "menuClose" : "menuOpen")}
                  onClick={() => setMobileNavOpen(open => !open)}
                >
                  <MenuIcon className="size-4" aria-hidden="true" />
                </Button>
              )}
              {!desktop.active && (
                <span className="mobile-shell-brand">
                  <PixelMark />
                  <strong>{t(`nav.${view}`)}</strong>
                </span>
              )}
              {hasContextualBarPicker ? (
                <div className="mobile-shell-actions">{contextualRunPicker}</div>
              ) : null}
            </header>
          )}
          {!hasWorkbenchHeader && !desktop.active && desktop.sidebarCollapsed && (
            <header className="web-collapsed-shell-bar max-[680px]:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={ct("expandSidebar")}
                title={expandSidebarTitle}
                onClick={desktop.toggleSidebar}
              >
                <PanelLeft className="size-4" aria-hidden="true" />
              </Button>
              <span className="web-collapsed-brand">
                <PixelMark size={16} />
                <span>Ludens</span>
                <span className="desktop-breadcrumb-sep" aria-hidden="true">/</span>
                <strong>{t(`nav.${view}`)}</strong>
              </span>
              <div className="ml-auto flex items-center gap-2">
                {hasContextualBarPicker ? contextualRunPicker : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={ct("quickSwitcher")}
                  title={quickSwitcherTitle}
                  onClick={() => desktop.setQuickSwitcherOpen(true)}
                >
                  <Search className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </header>
          )}
        <main ref={element => { runContent.current = element; catalogFocus.target.current = element; }}
          tabIndex={runControls ? -1 : undefined} aria-label={runControls ? t(`views.${view}.title`) : undefined}
          className={"page-content outline-none focus-visible:ring-2 focus-visible:ring-ring" + (view === "live" ? " live-page" : view === "replay" && entry === "ready" ? " replay-page" : view === "perf" ? " perf-page" : "")}>
          {view === "dev" && <div className="page-heading">
            <div>
              <h1>{t(`views.${view}.title`)}</h1>
              <p>{t(`views.${view}.description`)}</p>
            </div>
          </div>}
          {runControls && run && <ArchiveBuild key={selection.project + "/" + run}
            project={selection.project} run={run} onReady={archiveReady} />}
          {runControls && entry !== "catalog-error" && (catalogError || (view !== "replay" && error && !(analysingRun && data))) && (
            <Alert variant="destructive" className="mb-5"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 break-words">{catalogError || error}
              {data && (
                <small>{dt("keepLast")} · {clockTime(data.updatedAt)}</small>
              )}</span>
              <div className="flex flex-wrap items-center gap-2">
                {!data && entry === "ready" && contextualRunPicker}
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
          {view === "workspaces" ? (
            <WorkspacesView onChanged={refreshCatalog} onOpen={id => navigateUrl("/?" + new URLSearchParams({ view: "live", project: id }))}
              onConfigure={id => navigateUrl("/?" + new URLSearchParams({ view: "perception", project: id }))}
              catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              createIntent={query.get("create") === "1" ? { driverPackage: query.get("driverPackage") ?? "",
                driver: verifiedCreationDriver?.spec === query.get("driverPackage") ? verifiedCreationDriver : undefined } : null}
              onCloseCreateIntent={closeCreateIntent} />
          ) : view === "settings" ? (
            <SettingsView follow={pet} projects={projects} />
          ) : view === "dev" ? (
            <DevPanel navigate={navigate} />
          ) : view === "perception" ? (
            <WorkspaceStudioView project={selection.project} projects={projects}
              ready={catalogReady} catalogError={catalogError} catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog}
              initialTab={query.get("studioTab")} navigate={navigate} />
          ) : view === "docs" ? (
            <DocsView search={search} navigate={navigate} />
          ) : view === "caps" ? (
            <CapabilitiesView project={selection.project} ready={catalogReady} catalogError={catalogError}
              workspace={project?.workspace ?? null} onNavigate={navigateUrl}
              catalogLoading={catalogLoading} onRetryCatalog={refreshCatalog} />
          ) : view === "baseware" ? (
            <BasewareView project={selection.project} workspace={project?.workspace ?? null} projects={projects}
              ready={catalogReady} catalogError={catalogError} catalogLoading={catalogLoading}
              onRetryCatalog={refreshCatalog} onNavigate={navigateUrl} />
          ) : runControls && entry !== "ready" ? (
            <WorkspaceRunEmpty state={entry} project={project?.id} workspaceName={workspaceName(project)}
              workspacePath={project?.workspace ?? undefined}
              error={catalogError} retrying={catalogLoading} onRetry={retryCatalog} onNavigate={navigateUrl} />
          ) : view === "replay" ? (
            <SlottedTimelinePlayer key={scopeKey} project={selection.project} run={run} epoch={selection.epoch || "all"}
              runPicker={contextualRunPicker} mobileNavSlot={mobileNavButton}
              onOverview={onReplayOverview} archiveRevision={archiveRevision}
              position={query.get("at")} evidence={replayEvidenceFromSearch(search)}
              onPosition={(at, nextEvidence = null, options) => {
                const prevEvidence = replayEvidenceFromSearch(search);
                const sameEvidence = JSON.stringify(prevEvidence) === JSON.stringify(nextEvidence);
                navigate(
                  {
                    project: selection.project,
                    ...(selection.run ? { run: selection.run } : {}),
                    ...(selection.epoch ? { epoch: selection.epoch } : {}),
                    at: String(at),
                    ...replayEvidencePatch(nextEvidence),
                  },
                  { replace: options?.replace ?? sameEvidence },
                );
              }}
              onEvidence={nextEvidence => navigate(replayEvidencePatch(nextEvidence))} />
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
                <SlottedShioriWorkbench
                  project={selection.project}
                  workspace={project?.workspace ?? data.manifest.workspace ?? null}
                  workspaceTitle={workspaceName(project)}
                  runs={project?.runs ?? []}
                  runPicker={contextualRunPicker}
                  mobileNavSlot={mobileNavButton}
                  renderEventPoolPanel={props => <EventPoolOverviewPanel {...props} />}
                  jumpTarget={liveJumpTarget}
                  onClearJumpTarget={clearLiveJumpTarget}
                  onActiveSegmentChange={setActiveLiveSegment}
                  data={data}
                  feed={activity}
                  refresh={refresh}
                  isLiveRun={true}
                  phaseLabel={!staleStatus ? phase?.label : null}
                  phaseElapsedMs={!staleStatus ? phase?.elapsedMs : null}
                  selectedBlock={query.get("block") ?? undefined}
                  requestedCall={requestedCall || undefined}
                  selectedImage={selectedImage}
                  onUpdated={() => {
                    refreshRun();
                  }}
                  onOpenPerf={() => navigate({ view: "perf" })}
                  onOpenCaps={() => navigate({ view: "caps" })}
                  onOpenReplay={() => navigate({ view: "replay" })}
                  onOpenReplayAt={openReplayAtFrame}
                  onReturnLatest={returnToLatest}
                  renderObservation={({ data: overrideData, call: overrideCall, selectedImage: overrideImage, onSelectImage }) => {
                    const targetData = overrideData ?? data;
                    const obsById = new Map(targetData.observations.map(o => [o.id, o]));
                    const hasRecordedVisual = (candidate?: typeof call) =>
                      Boolean(
                        candidate?.inputObservations.some(id => {
                          const item = obsById.get(id);
                          return item && item.mediaStorage !== "unrecorded";
                        }),
                      );
                    const latestRunCall = targetData.calls.at(-1);
                    const defaultCall = targetData === data ? call : latestRunCall;
                    const explicitSelection = Boolean(overrideCall || (targetData === data && requestedCall));
                    const effectiveCall = explicitSelection
                      ? (overrideCall ?? defaultCall)
                      : hasRecordedVisual(defaultCall)
                        ? defaultCall
                        : [...targetData.calls].reverse().find(hasRecordedVisual) ??
                          [...targetData.calls].reverse().find(c => c.inputObservations.length > 0) ??
                          defaultCall;
                    const effectiveImage =
                      overrideImage ??
                      (targetData === data ? selectedImage : undefined) ??
                      (!effectiveCall?.inputObservations.length
                        ? [...targetData.observations].reverse().find(o => o.mediaStorage !== "unrecorded")?.id ??
                          targetData.observations.at(-1)?.id
                        : undefined);
                    return (
                      <ObservationPanel
                        priority
                        data={targetData}
                        call={effectiveCall}
                        latestCall={!explicitSelection ? latestRunCall : undefined}
                        selectedImage={effectiveImage}
                        onImage={onSelectImage}
                        onOpenReplayAt={openReplayAtFrame}
                      />
                    );
                  }}
                  observationSlot={
                    <ObservationPanel
                      priority
                      data={data}
                      call={(() => {
                        const obsById = new Map(data.observations.map(o => [o.id, o]));
                        const hasRecordedVisual = (candidate?: typeof call) =>
                          Boolean(
                            candidate?.inputObservations.some(id => {
                              const item = obsById.get(id);
                              return item && item.mediaStorage !== "unrecorded";
                            }),
                          );
                        if (requestedCall) return call;
                        if (hasRecordedVisual(call)) return call;
                        return (
                          [...data.calls].reverse().find(hasRecordedVisual) ??
                          [...data.calls].reverse().find(c => c.inputObservations.length > 0) ??
                          call
                        );
                      })()}
                      latestCall={!requestedCall ? data.calls.at(-1) : undefined}
                      selectedImage={
                        selectedImage ??
                        (!call?.inputObservations.length
                          ? [...data.observations].reverse().find(o => o.mediaStorage !== "unrecorded")?.id ??
                            data.observations.at(-1)?.id
                          : undefined)
                      }
                      onImage={(id) => navigate({ ...pinned, image: id })}
                      onOpenReplayAt={openReplayAtFrame}
                    />
                  }
                />
              ) : (
                <>
                  <SlottedRunAnalysis
                    data={data}
                    detailData={analysis.detail}
                    call={call}
                    requestedCall={requestedCall}
                    pending={!analysis.detail}
                    error={error}
                    retrying={retryingRun}
                    metrics={metrics}
                    runPicker={contextualRunPicker}
                    handoverSlot={perfHandoverSlot}
                    mobileNavSlot={mobileNavButton}
                    statusSlot={
                      <div className="run-status perf-run-status">
                        <span className={"status-dot " + (auto && !staleStatus ? "online" : "")} />
                        <strong>{status}</strong>
                        {phase?.elapsedMs != null && !staleStatus && (
                          <span>{dt("elapsed")} {seconds(phase.elapsedMs)}</span>
                        )}
                        <i />
                        <span className="perf-status-model">
                          {(data.live as { model?: string | null } | null)?.model ??
                            data.manifest.model ??
                            dt("deviceOnly")}
                        </span>
                        <span className="run-time">
                          {Math.floor(s!.elapsedSeconds / 60)}{dt("min")}{" "}
                          {Math.floor(s!.elapsedSeconds % 60)}{dt("sec")} <b> / </b>
                          {data.manifest.seconds != null && data.manifest.seconds > 0
                            ? `${dt("budget")} ${Math.floor(data.manifest.seconds / 60)}${dt("minLong")}`
                            : "∞"}
                        </span>
                      </div>
                    }
                    activeTab={query.get("perfTab") === "requests" ? "requests" : "overview"}
                    onTabChange={nextTab => navigate({ perfTab: nextTab === "overview" ? null : nextTab })}
                    onSelectChartCall={callId => navigate({ ...pinned, call: callId, perfTab: "requests", image: null, block: null })}
                    pageRange={pageRange}
                    panel={panel}
                    onPanel={setPanel}
                    onSelect={selectCall}
                    onInspect={() =>
                      navigate({
                        view: "live",
                        project: selection.project,
                        ...(selection.run ? { run: selection.run } : {}),
                        ...(selection.epoch ? { epoch: selection.epoch } : {}),
                        call: call?.id ?? null,
                        beforeCall: null,
                        block: null,
                        image: null,
                      })
                    }
                    onRetry={retryRun}
                    onFollowLatest={() => navigate({ beforeCall: null, call: null, image: null, block: null })}
                    onLoadMore={() => navigate({ ...pinned, beforeCall: String(data.paging.beforeCall), call: null, image: null, block: null })}
                    telemetrySlot={
                      <>
                        <section className="surface telemetry-summary">
                          <div className="telemetry-header">
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
                          </div>
                          <div className="telemetry-grid">
                            <article className="telemetry-card">
                              <h3>{dt("telemetry.efficiencyTitle")}</h3>
                              <dl className="telemetry-kv">
                                <div>
                                  <dt>{dt("telemetry.modelShare")}</dt>
                                  <dd>
                                    <strong>{percent(eff?.modelTimeRatio)}</strong>
                                    <span className="telemetry-bar"><i style={{ width: `${Math.min(100, Math.max(0, (eff?.modelTimeRatio ?? 0) * 100))}%`, background: "var(--gold)" }} /></span>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.deviceDuty")}</dt>
                                  <dd>
                                    <strong>{percent(eff?.deviceActionDutyCycle)}</strong>
                                    <span className="telemetry-bar"><i style={{ width: `${Math.min(100, Math.max(0, (eff?.deviceActionDutyCycle ?? 0) * 100))}%`, background: "var(--sage)" }} /></span>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.pythonShare")}</dt>
                                  <dd>
                                    <strong>{percent(eff?.localPythonTimeRatio)}</strong>
                                    <span className="telemetry-bar"><i style={{ width: `${Math.min(100, Math.max(0, (eff?.localPythonTimeRatio ?? 0) * 100))}%`, background: "var(--blue)" }} /></span>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.autonomyRatio")}</dt>
                                  <dd><strong>{percent(clampedAutonomyRatio)}</strong></dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.pythonRpcs")}</dt>
                                  <dd><strong>{(eff?.localPythonRpcCalls ?? 0).toLocaleString()}</strong></dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.outputTokens")}</dt>
                                  <dd><strong>{(eff?.totalOutputTokens ?? 0).toLocaleString()}</strong></dd>
                                </div>
                              </dl>
                            </article>
                            <article className="telemetry-card">
                              <h3>{dt("telemetry.samplerTitle")}</h3>
                              <dl className="telemetry-kv">
                                <div>
                                  <dt>{dt("telemetry.samplerRate")}</dt>
                                  <dd>
                                    <strong>{sampler?.latestRealizedHz != null ? `${sampler.latestRealizedHz.toFixed(2)} Hz` : "—"}</strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.samplerUtil")}</dt>
                                  <dd>
                                    <strong>{percent(sampler?.latestUtilization)}</strong>
                                    <span className="telemetry-bar"><i style={{ width: `${Math.min(100, Math.max(0, (sampler?.latestUtilization ?? 0) * 100))}%`, background: "var(--sage)" }} /></span>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.samplerWindows")}</dt>
                                  <dd><strong>{(sampler?.windows ?? 0).toLocaleString()}</strong></dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.samplerSamples")}</dt>
                                  <dd>
                                    <strong>
                                      {(sampler?.completedSamples ?? 0).toLocaleString()} / {(sampler?.attemptedSamples ?? 0).toLocaleString()}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.samplerStarved")}</dt>
                                  <dd><strong>{(sampler?.sleepStarvedTicks ?? 0).toLocaleString()}</strong></dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.samplerHotBytes")}</dt>
                                  <dd><strong>{bytes(sampler?.peakHotBytes)}</strong></dd>
                                </div>
                              </dl>
                            </article>
                            <article className="telemetry-card">
                              <h3>{dt("telemetry.subsystemsTitle")}</h3>
                              <dl className="telemetry-kv">
                                <div>
                                  <dt>{dt("telemetry.shioriLoops")} <small>({data.telemetry.shiori.stats.started})</small></dt>
                                  <dd>
                                    <strong>
                                      {compactDuration(data.telemetry.shiori.stats.durationMs.median)} / {compactDuration(data.telemetry.shiori.stats.durationMs.p95)}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.capabilities")} <small>({data.telemetry.capabilities.stats.started})</small></dt>
                                  <dd>
                                    <strong>
                                      {compactDuration(data.telemetry.capabilities.stats.durationMs.median)} / {compactDuration(data.telemetry.capabilities.stats.durationMs.p95)}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.localPython")} <small>({data.telemetry.capabilities.localPython.started})</small></dt>
                                  <dd>
                                    <strong>
                                      {compactDuration(data.telemetry.capabilities.localPython.durationMs.median)} / {compactDuration(data.telemetry.capabilities.localPython.durationMs.p95)}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.deviceExecs")} <small>({data.telemetry.devices.started})</small></dt>
                                  <dd>
                                    <strong>
                                      {compactDuration(data.telemetry.devices.durationMs.median)} / {compactDuration(data.telemetry.devices.durationMs.p95)}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.perceptionReads")} <small>({data.telemetry.perception.started})</small></dt>
                                  <dd>
                                    <strong>
                                      {compactDuration(data.telemetry.perception.durationMs.median)} / {compactDuration(data.telemetry.perception.durationMs.p95)}
                                    </strong>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{dt("telemetry.perceptionStartup")}</dt>
                                  <dd><strong>{compactDuration(sampler?.startupDurationMs)}</strong></dd>
                                </div>
                              </dl>
                            </article>
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
                    }
                  />
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
      <DesktopQuickSwitcher
        open={desktop.quickSwitcherOpen}
        onOpenChange={desktop.setQuickSwitcherOpen}
        platform={desktop.platform}
        projects={projects}
        currentProject={selection.project}
        currentView={view}
        viewLink={viewLink}
        onNavigate={url => {
          setMobileNavOpen(false);
          navigateUrl(url);
        }}
        onSelectWorkspace={id => {
          setMobileNavOpen(false);
          navigate({
            view: "live",
            project: id,
            workspace: null,
            run: null,
            epoch: null,
            beforeCall: null,
            call: null,
            block: null,
            image: null,
            at: null,
            ...replayEvidencePatch(null),
          });
        }}
        sidebarCollapsed={desktop.sidebarCollapsed}
        onToggleSidebar={desktop.toggleSidebar}
        canGoBack={desktop.canGoBack}
        canGoForward={desktop.canGoForward}
        onGoBack={() => void desktop.goBack()}
        onGoForward={() => void desktop.goForward()}
        onReload={() => void desktop.reload()}
        companionAvailable={desktop.companionAvailable}
        companionVisible={desktop.companionVisible}
        onToggleCompanion={() => void desktop.toggleCompanion()}
      />
    </div>
  );

}