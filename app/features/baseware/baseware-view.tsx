"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  Cpu,
  Edit3,
  Gamepad2,
  Globe,
  HardDrive,
  Link2,
  Monitor,
  PackageCheck,
  PackagePlus,
  Play,
  Plus,
  Plug as PlugIcon,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  Unplug,
  XCircle,
} from "lucide-react";
import type { MachineTransportKind } from "@ludens/protocol/machines";
import { BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";
import type { BasewareDriverOverviewItem } from "@/lib/workspaces";
import type { CapabilitiesResult, CapabilityEntry } from "@/lib/capabilities";
import type { Project } from "@/lib/types";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useLocale, useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BasewareModalDialog } from "./baseware-modal-dialog";
import { DriverRegisterDialog } from "./driver-register-dialog";
import { MachineEditorDialog } from "./machine-editor-dialog";
import {
  buildDisplayMachines,
  computeBasewareSummary,
  createEmptyMachineDraft,
  draftFromDriver,
  draftFromImplicitMachine,
  draftFromMachine,
  formatCliControllerExample,
  formatTransportSummary,
  normalizeDaemonForSnapshot,
  resolveControllersForMachine,
  type DisplayMachineItem,
  type MachineDraft,
} from "./baseware-model";
import { useBasewareOverview } from "./use-baseware-overview";

export interface BasewareViewProps {
  project: string;
  workspace: string | null;
  projects: Project[];
  ready: boolean;
  catalogError?: string;
  catalogLoading?: boolean;
  onRetryCatalog(): void;
  onNavigate(href: string): void;
}

type DriverFilter = "all" | "current" | "registered" | "unregistered";
type PoolFilter = "all" | "added" | "mounted" | "unregistered";
type InspectorTab = "controllers" | "daemon";

function TransportIcon({ kind }: { kind: MachineTransportKind }) {
  switch (kind) {
    case "stdio":
      return <Terminal className="size-4 text-primary" aria-hidden="true" />;
    case "bridge":
      return <Gamepad2 className="size-4 text-primary" aria-hidden="true" />;
    case "ssh":
      return <Server className="size-4 text-primary" aria-hidden="true" />;
    case "http":
      return <Globe className="size-4 text-primary" aria-hidden="true" />;
    case "sse":
      return <Radio className="size-4 text-primary" aria-hidden="true" />;
  }
}

function DeviceCapabilityDeclarations({ items, title }: { items: CapabilityEntry[]; title: string }) {
  const ct = useTranslations("capabilitiesView");
  return (
    <div className="capability-declarations">
      <div className="capability-declaration-columns" aria-hidden="true">
        <span>{ct("capabilityCol")}</span>
        <span>{ct("descriptionCol")}</span>
        <span>{ct("controlCol")}</span>
      </div>
      <ul className="capability-declaration-list" role="list" aria-label={title}>
        {items.map(item => (
          <li key={item.id} className="capability-declaration" data-capability-declaration={item.id}>
            <h4 className="capability-declaration-name">
              <code>{item.id}</code>
            </h4>
            <div className="capability-declaration-description">
              <p>{item.description || <span className="text-muted-foreground">{ct("noDescription")}</span>}</p>
            </div>
            <dl className="capability-declaration-control">
              <dt>{ct("controlCol")}</dt>
              <dd>
                <span data-capability-control>
                  {item.requiresControl === null ? "—" : ct(item.requiresControl ? "needsControl" : "noControl")}
                </span>
                {item.readOnly !== null && (
                  <span data-capability-read-only>{ct(item.readOnly ? "readOnlySuffix" : "sideEffectsSuffix")}</span>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BasewareView({
  project,
  workspace,
  ready,
  catalogError,
  catalogLoading,
  onRetryCatalog,
  onNavigate,
}: BasewareViewProps) {
  const t = useTranslations("basewareView");
  const ct = useTranslations("capabilitiesView");
  const { locale } = useLocale();
  const fmt = (key: string, vars: Record<string, string | number>) =>
    t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

  const {
    snapshot,
    loading,
    loadError,
    actionError,
    actionNotice,
    setActionNotice,
    busyDriverKey,
    busyMachineId,
    probeStates,
    capabilities,
    reloadAll,
    registerDriver,
    unregisterDriver,
    probeMachine,
    probeDraftMachine,
    controlWorkspaceMachine,
    upsertMachine,
    deleteMachine,
  } = useBasewareOverview({
    project,
    workspace,
    ready,
    loadFailedMessage: t("loadFailed"),
    capabilitiesFailedMessage: ct("loadFailed"),
  });

  const [driverFilter, setDriverFilter] = useState<DriverFilter>("all");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("controllers");

  // Modal dialog states
  const [driverModalOpen, setDriverModalOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGlobalId, setEditingGlobalId] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState<MachineDraft>(() => createEmptyMachineDraft("primary"));
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<DisplayMachineItem | null>(null);

  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    controllers: null,
    daemon: null,
  });

  const displayMachines = useMemo(() => buildDisplayMachines(snapshot), [snapshot]);
  const summary = useMemo(() => computeBasewareSummary(snapshot), [snapshot]);
  const normalizedDaemon = useMemo(() => normalizeDaemonForSnapshot(snapshot), [snapshot]);
  const existingGlobalIds = useMemo(() => (snapshot?.machines ?? []).map(m => m.id), [snapshot?.machines]);

  const drivers = useMemo(() => snapshot?.drivers ?? [], [snapshot?.drivers]);
  const filteredDrivers = useMemo(() => {
    return drivers.filter(driver => {
      switch (driverFilter) {
        case "current":
          return driver.usedByCurrentWorkspace;
        case "registered":
          return driver.registrationStatus !== "unregistered";
        case "unregistered":
          return driver.registrationStatus === "unregistered";
        default:
          return true;
      }
    });
  }, [drivers, driverFilter]);

  const filteredMachines = useMemo(() => {
    return displayMachines.filter(machine => {
      switch (poolFilter) {
        case "added":
          return machine.workspaceAdditionStatus !== "not-added";
        case "mounted":
          return machine.isMounted;
        case "unregistered":
          return machine.registrationStatus === "unregistered";
        default:
          return true;
      }
    });
  }, [displayMachines, poolFilter]);

  const selectedMachine = useMemo(
    () => displayMachines.find(m => m.id === selectedMachineId) ?? filteredMachines[0] ?? displayMachines[0] ?? null,
    [displayMachines, filteredMachines, selectedMachineId],
  );

  const rawDeviceItems = useMemo(
    () => capabilities.value?.groups.find(group => group.id === "device")?.items ?? [],
    [capabilities.value?.groups],
  );

  const selectedMachineControllers = useMemo(
    () => resolveControllersForMachine(rawDeviceItems, selectedMachine, snapshot),
    [rawDeviceItems, selectedMachine, snapshot],
  );

  const daemon = snapshot?.daemon;
  const deviceGuideHref = useMemo(() => {
    const base = project
      ? `/?workspace=${encodeURIComponent(project)}&view=docs&doc=tutorials/devices.md`
      : "/?view=docs&doc=tutorials/devices.md";
    return `${base}&docLang=${locale}`;
  }, [project, locale]);

  const openNewMachineEditor = () => {
    const firstNonBuiltinDriver = drivers.find(d => d.spec !== BUILTIN_CUA_DRIVER_SPEC);
    setEditingGlobalId(null);
    setEditorDraft(
      firstNonBuiltinDriver
        ? draftFromDriver(firstNonBuiltinDriver, existingGlobalIds)
        : createEmptyMachineDraft(project ? "primary" : "none"),
    );
    setEditorOpen(true);
  };

  const openEditorFromDriver = (driver: BasewareDriverOverviewItem) => {
    setEditingGlobalId(null);
    setEditorDraft(draftFromDriver(driver, existingGlobalIds));
    setEditorOpen(true);
  };

  const openEditorForPromote = (machine: DisplayMachineItem) => {
    setEditingGlobalId(null);
    setEditorDraft(draftFromImplicitMachine(machine, snapshot?.workspaceId ?? null, existingGlobalIds));
    setEditorOpen(true);
  };

  const openEditorForMachine = (machine: DisplayMachineItem) => {
    setEditingGlobalId(machine.id);
    setEditorDraft(draftFromMachine(machine, machine.workspaceAdditionStatus));
    setEditorOpen(true);
  };

  const handleInspectorTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const order: InspectorTab[] = ["controllers", "daemon"];
    const currentIndex = order.indexOf(inspectorTab);
    let nextIndex = -1;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % order.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + order.length) % order.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = order.length - 1;
    }

    if (nextIndex >= 0) {
      event.preventDefault();
      const nextTab = order[nextIndex]!;
      setInspectorTab(nextTab);
      const target = tabRefs.current[nextTab];
      target?.focus();
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const daemonStateLabel = !daemon
    ? t("daemonOffline")
    : daemon.status?.connected
      ? t("daemonConnected")
      : daemon.basewareSocketExists
        ? t("daemonStandby")
        : t("daemonOffline");

  const editorTitle = editingGlobalId
    ? `${t("editMachineTitle")}: ${editingGlobalId}`
    : t("newMachineTitle");

  return (
    <div className="space-y-6 p-4 md:p-6" data-baseware-view>
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cpu className="size-5 text-primary" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void reloadAll()}
            disabled={loading || !ready}
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            {t("refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDriverModalOpen(true)}
            data-baseware-add-driver
          >
            <PackagePlus className="size-3.5" aria-hidden="true" />
            {t("addDriver")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={openNewMachineEditor}
            data-baseware-add-machine
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("addMachine")}
          </Button>
        </div>
      </div>

      {/* Feedback & Errors */}
      {catalogError && (
        <Alert variant="destructive">
          <XCircle className="size-4" aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{catalogError}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetryCatalog} disabled={catalogLoading}>
              {ct("refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {(loadError || actionError) && (
        <Alert variant="destructive">
          <XCircle className="size-4" aria-hidden="true" />
          <AlertDescription className="text-xs">{loadError || actionError}</AlertDescription>
        </Alert>
      )}
      {actionNotice && (
        <Alert>
          <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
          <AlertDescription className="text-xs">{actionNotice}</AlertDescription>
        </Alert>
      )}

      {/* 4-Card Summary Strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-baseware-summary aria-label={t("summaryLabel")}>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardDriversSummary")}</span>
              <PackageCheck className="size-3.5 text-primary" aria-hidden="true" />
            </div>
            <div className="mt-1.5 text-lg font-semibold tabular-nums">{summary.totalDrivers}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {fmt("driversSummaryDetail", {
                registered: summary.registeredDrivers,
                unregistered: summary.unregisteredDrivers,
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardActiveTarget")}</span>
              <Star className="size-3.5 text-amber-400" aria-hidden="true" />
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-sm font-semibold">
              {summary.activeTarget ? (
                <>
                  <TransportIcon kind={summary.activeTarget.transport.kind} />
                  <span className="truncate">{summary.activeTarget.name}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t("unboundTarget")}</span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {summary.activeTarget
                ? `${summary.activeTarget.id} · ${formatTransportSummary(summary.activeTarget.transport)}`
                : "—"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardWorkspacePool")}</span>
              <Link2 className="size-3.5 text-primary" aria-hidden="true" />
            </div>
            <div className="mt-1.5 text-lg font-semibold tabular-nums">
              {project ? summary.addedMachinesCount : "—"}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {project
                ? fmt("workspaceNodesUnit", {
                    mounted: summary.mountedMachinesCount,
                    added: summary.addedMachinesCount,
                  })
                : t("noWorkspaceSelected")}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardDaemonStatus")}</span>
              <Activity className="size-3.5 text-emerald-400" aria-hidden="true" />
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-sm font-semibold">
              <span
                className={`size-2 rounded-full ${
                  daemon?.status?.connected
                    ? "bg-emerald-400"
                    : daemon?.basewareSocketExists
                      ? "bg-amber-400"
                      : "bg-muted-foreground/40"
                }`}
              />
              <span>{daemonStateLabel}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {daemon?.status?.epoch ? `epoch ${daemon.status.epoch}` : t("daemonHint")}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* SECTION 1: Driver Library (Orthogonal Registration vs Usage) */}
      <section className="space-y-3" data-baseware-section="driver-library">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-primary" aria-hidden="true" />
              <h2 className="text-base font-semibold">{t("driverLibraryTitle")}</h2>
            </div>
            <p className="max-w-3xl text-xs text-muted-foreground">{t("driverLibraryDesc")}</p>
          </div>

          <search className="flex flex-wrap items-center gap-1" aria-label={t("driverFilterLabel")}>
            {(
              [
                { key: "all", label: t("driverFilterAll") },
                { key: "current", label: t("driverFilterCurrent") },
                { key: "registered", label: t("driverFilterRegistered") },
                { key: "unregistered", label: t("driverFilterUnregistered") },
              ] as const
            ).map(item => (
              <Button
                key={item.key}
                type="button"
                size="sm"
                variant={driverFilter === item.key ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setDriverFilter(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </search>
        </div>

        {filteredDrivers.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-xs text-muted-foreground">
              {t("emptyDriverFilter")}
            </CardContent>
          </Card>
        ) : (
          <ul role="list" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredDrivers.map(driver => {
              const isBusy = busyDriverKey === driver.key || busyDriverKey === driver.id;
              return (
                <li
                  key={driver.key}
                  data-baseware-driver={driver.id}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-border/80 bg-card p-3.5"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                          <span className="font-mono">{driver.id}</span>
                          {driver.version && (
                            <span className="font-mono text-[11px] font-normal text-muted-foreground">
                              v{driver.version}
                            </span>
                          )}
                        </h3>
                        {driver.packageName && (
                          <p className="truncate font-mono text-[11px] text-muted-foreground" title={driver.packageName}>
                            {driver.packageName}
                          </p>
                        )}
                      </div>

                      {/* Orthogonal Status Pill Pair */}
                      <div className="flex flex-wrap items-center gap-1">
                        {driver.registrationStatus === "builtin" ? (
                          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-[10px] text-sky-300">
                            {t("driverRegBuiltin")}
                          </Badge>
                        ) : driver.registrationStatus === "registered" ? (
                          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-300">
                            {t("driverRegRegistered")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300">
                            {t("driverRegUnregistered")}
                          </Badge>
                        )}

                        {driver.usedByCurrentWorkspace ? (
                          <Badge variant="outline" className="border-primary/45 bg-primary/10 text-[10px] text-primary">
                            {t("driverUsedHere")}
                          </Badge>
                        ) : driver.usedByMachineIds.length > 0 ? (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {fmt("driverUsedByNodes", { count: driver.usedByMachineIds.length })}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {t("driverUnused")}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {driver.description && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{driver.description}</p>
                    )}

                    <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
                      <div className="truncate" title={driver.spec}>
                        {t("driverPathLabel")}: {driver.spec}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {driver.transport && <span>transport: {driver.transport}</span>}
                        {driver.defaultPort !== undefined && <span>port: {driver.defaultPort}</span>}
                        {driver.cacheKey && <span>cache: {driver.cacheKey}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
                    {driver.registrationStatus === "unregistered" && !driver.spec.startsWith("driver:") && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={isBusy}
                        aria-label={`${t("driverRegisterBtn")}: ${driver.id}`}
                        data-baseware-register-driver={driver.id}
                        onClick={() => {
                          void registerDriver(driver.spec, driver.key).then(() => {
                            setActionNotice(fmt("driverRegisteredNotice", { id: driver.id }));
                          }).catch(() => {});
                        }}
                      >
                        <PackagePlus className="size-3" aria-hidden="true" />
                        {t("driverRegisterBtn")}
                      </Button>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      aria-label={`${t("driverCreateNodeBtn")}: ${driver.id}`}
                      onClick={() => openEditorFromDriver(driver)}
                    >
                      {t("driverCreateNodeBtn")}
                    </Button>

                    {driver.registrationStatus === "registered" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={isBusy}
                        aria-label={`${t("driverUnregisterBtn")}: ${driver.id}`}
                        data-baseware-unregister-driver={driver.id}
                        onClick={() => {
                          void unregisterDriver({
                            id: driver.id,
                            spec: driver.spec,
                            key: driver.key,
                          }).then(() => {
                            setActionNotice(fmt("driverUnregisteredNotice", { id: driver.id }));
                          }).catch(() => {});
                        }}
                      >
                        {t("driverUnregisterBtn")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* SECTION 2: Master-Detail Controlled Nodes + Sticky Controller Inspector */}
      <section className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-primary" aria-hidden="true" />
            <h2 className="text-base font-semibold">{t("poolSectionTitle")}</h2>
          </div>
          <p className="max-w-3xl text-xs text-muted-foreground">{t("poolSectionDesc")}</p>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left 7 Cols: Controlled Node List */}
          <div className="min-w-0 space-y-3 lg:col-span-7" data-baseware-section="machine-pool">
            <search className="flex flex-wrap items-center gap-1" aria-label={t("poolFilterLabel")}>
              {(
                [
                  { key: "all", label: t("poolFilterAll") },
                  { key: "added", label: t("poolFilterAdded") },
                  { key: "mounted", label: t("poolFilterMounted") },
                  { key: "unregistered", label: t("poolFilterUnregistered") },
                ] as const
              ).map(item => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={poolFilter === item.key ? "secondary" : "ghost"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setPoolFilter(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </search>

            {filteredMachines.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-xs text-muted-foreground">
                  {t("emptyPoolFilter")}
                </CardContent>
              </Card>
            ) : (
              <ul role="list" className="space-y-2.5">
                {filteredMachines.map(machine => {
                  const isSelected = selectedMachine?.id === machine.id;
                  const isBuiltin = machine.registrationStatus === "builtin";
                  const isUnregistered = machine.registrationStatus === "unregistered";
                  const isBusy = busyMachineId === machine.id;
                  const probe = probeStates[machine.id];

                  return (
                    <li
                      key={machine.id}
                      data-baseware-machine={machine.id}
                      className={
                        "rounded-xl border p-3.5 transition-colors " +
                        (isSelected
                          ? "border-primary bg-primary/[0.04]"
                          : "border-border/80 bg-card hover:border-border")
                      }
                    >
                      <div className="flex flex-col gap-3">
                        {/* Clickable header to select machine */}
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedMachineId(machine.id)}
                            className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                          >
                            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                              <TransportIcon kind={machine.transport.kind} />
                            </div>
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <h3 className="text-sm font-semibold text-foreground">{machine.name}</h3>
                                <span className="font-mono text-xs text-muted-foreground">{machine.id}</span>
                              </div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                {machine.driver} · {machine.transport.kind.toUpperCase()} ·{" "}
                                {formatTransportSummary(machine.transport)}
                              </div>
                              {machine.driverPackage && (
                                <div className="truncate font-mono text-[11px] text-muted-foreground/80" title={machine.driverPackage}>
                                  {machine.driverPackage}
                                </div>
                              )}
                            </div>
                          </button>

                          {/* Orthogonal 3-axis badges */}
                          <div className="flex flex-wrap items-center gap-1">
                            {/* Axis 1: Registration */}
                            {isBuiltin ? (
                              <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-[10px] text-sky-300">
                                <ShieldCheck className="mr-1 size-2.5" aria-hidden="true" />
                                {t("nodeRegBuiltin")}
                              </Badge>
                            ) : isUnregistered ? (
                              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300">
                                {t("nodeRegUnregistered")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-[10px] text-emerald-300">
                                {t("nodeRegRegistered")}
                              </Badge>
                            )}

                            {/* Axis 2: Workspace Addition */}
                            {project && (
                              machine.workspaceAdditionStatus === "primary" ? (
                                <Badge variant="outline" className="border-amber-400/50 bg-amber-400/15 text-[10px] text-amber-300">
                                  {t("nodeAddPrimary")}
                                </Badge>
                              ) : machine.workspaceAdditionStatus === "added" ? (
                                <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] text-primary">
                                  {t("nodeAddAdded")}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  {t("nodeAddNotAdded")}
                                </Badge>
                              )
                            )}

                            {/* Axis 3: Live Daemon Mount */}
                            {machine.isMounted ? (
                              <Badge variant="outline" className="border-emerald-500/45 bg-emerald-500/15 text-[10px] text-emerald-300">
                                <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-400" />
                                {t("nodeMountConnected")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                {t("nodeMountStandby")}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Probe Result Banner */}
                        {probe && probe !== "probing" && (
                          <div
                            className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] ${
                              probe.ok
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                : "border-destructive/40 bg-destructive/10 text-destructive"
                            }`}
                          >
                            {probe.ok ? t("probeOk") : t("probeFailed")} ({probe.latencyMs}ms): {probe.detail}
                          </div>
                        )}

                        {/* Actions Footer */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                          <span className="text-[11px] text-muted-foreground">
                            {fmt("usedByWorkspaces", { count: machine.usedByWorkspaceIds.length })}
                          </span>

                          <div className="flex flex-wrap items-center gap-1.5">
                            {isUnregistered ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  aria-label={`${t("promoteInlineBtn")}: ${machine.name}`}
                                  data-baseware-promote-machine={machine.id}
                                  onClick={() => openEditorForPromote(machine)}
                                >
                                  <Sparkles className="size-3" aria-hidden="true" />
                                  {t("promoteInlineBtn")}
                                </Button>
                                {project && machine.isMounted && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    disabled={isBusy}
                                    aria-label={`${t("reconnectBtn")}: ${machine.name}`}
                                    onClick={() => void controlWorkspaceMachine("reconnect", machine.id)}
                                  >
                                    <RefreshCw className="size-3" aria-hidden="true" />
                                    {t("reconnectBtn")}
                                  </Button>
                                )}
                              </>
                            ) : (
                              project && (
                                <>
                                  {machine.workspaceAdditionStatus === "not-added" && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 px-2.5 text-xs"
                                      disabled={isBusy}
                                      aria-label={`${t("addToWorkspaceBtn")}: ${machine.name}`}
                                      onClick={() => void controlWorkspaceMachine("toggleAllowed", machine.id)}
                                    >
                                      {t("addToWorkspaceBtn")}
                                    </Button>
                                  )}

                                  {machine.workspaceAdditionStatus !== "primary" && (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      className="h-7 px-2.5 text-xs"
                                      disabled={isBusy}
                                      aria-label={`${t("setPrimaryBtn")}: ${machine.name}`}
                                      data-baseware-set-primary={machine.id}
                                      onClick={() => void controlWorkspaceMachine("setPrimary", machine.id)}
                                    >
                                      <Star className="size-3" aria-hidden="true" />
                                      {t("setPrimaryBtn")}
                                    </Button>
                                  )}

                                  {machine.isMounted ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 px-2 text-xs"
                                      disabled={isBusy}
                                      aria-label={`${t("unmountBtn")}: ${machine.name}`}
                                      data-baseware-unmount-btn={machine.id}
                                      onClick={() => void controlWorkspaceMachine("unmount", machine.id)}
                                    >
                                      <Unplug className="size-3" aria-hidden="true" />
                                      {t("unmountBtn")}
                                    </Button>
                                  ) : (
                                    daemon?.basewareSocketExists && (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        disabled={isBusy}
                                        aria-label={`${t("coMountBtn")}: ${machine.name}`}
                                        data-baseware-mount-btn={machine.id}
                                        onClick={() => void controlWorkspaceMachine("mount", machine.id)}
                                      >
                                        <PlugIcon className="size-3" aria-hidden="true" />
                                        {t("coMountBtn")}
                                      </Button>
                                    )
                                  )}

                                  {machine.workspaceAdditionStatus === "added" && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 text-xs text-muted-foreground"
                                      disabled={isBusy}
                                      aria-label={`${t("removeFromWorkspaceBtn")}: ${machine.name}`}
                                      onClick={() => void controlWorkspaceMachine("toggleAllowed", machine.id)}
                                    >
                                      {t("removeFromWorkspaceBtn")}
                                    </Button>
                                  )}
                                </>
                              )
                            )}

                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => void probeMachine(machine)}
                              disabled={probe === "probing"}
                              aria-label={`${t("probe")}: ${machine.name}`}
                              data-baseware-probe-btn={machine.id}
                            >
                              <Play className="size-3" aria-hidden="true" />
                              {probe === "probing" ? t("probing") : t("probe")}
                            </Button>

                            {!isUnregistered && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => openEditorForMachine(machine)}
                                aria-label={`${t("edit")}: ${machine.name}`}
                              >
                                <Edit3 className="size-3.5" aria-hidden="true" />
                              </Button>
                            )}

                            {!isBuiltin && !isUnregistered && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => setConfirmDeleteTarget(machine)}
                                aria-label={`${t("delete")}: ${machine.name}`}
                              >
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Right 5 Cols: Contextual Sticky Machine & Daemon Inspector */}
          <div className="min-w-0 lg:sticky lg:top-[calc(1rem+var(--shell-topbar-height,0px))] lg:col-span-5" data-baseware-section="controllers-catalog">
            <Card className="min-w-0" data-capability-source="device">
              <CardContent className="min-w-0 space-y-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
                  <div className="baseware-tablist min-w-0" role="tablist">
                    <button
                      ref={el => { tabRefs.current.controllers = el; }}
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === "controllers"}
                      tabIndex={inspectorTab === "controllers" ? 0 : -1}
                      onClick={() => setInspectorTab("controllers")}
                      onKeyDown={handleInspectorTabKeyDown}
                      className="baseware-tab"
                    >
                      <Monitor className="size-3.5" aria-hidden="true" />
                      {t("inspectorTabControllers")}
                    </button>
                    <button
                      ref={el => { tabRefs.current.daemon = el; }}
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === "daemon"}
                      tabIndex={inspectorTab === "daemon" ? 0 : -1}
                      onClick={() => setInspectorTab("daemon")}
                      onKeyDown={handleInspectorTabKeyDown}
                      className="baseware-tab"
                    >
                      <Activity className="size-3.5" aria-hidden="true" />
                      {t("inspectorTabDaemon")}
                    </button>
                  </div>

                  <Button asChild variant="ghost" size="sm" className="ml-auto h-7 shrink-0 whitespace-nowrap px-2 text-xs">
                    <a
                      href={deviceGuideHref}
                      onClick={event => {
                        if (isPlainNavigationClick(event)) {
                          event.preventDefault();
                          onNavigate(deviceGuideHref);
                        }
                      }}
                    >
                      <BookOpen className="size-3.5" aria-hidden="true" />
                      {ct("deviceGuide")}
                    </a>
                  </Button>
                </div>

                {inspectorTab === "controllers" ? (
                  <div role="tabpanel">
                    <div className="baseware-tabpanel-inner space-y-4">
                      {selectedMachine ? (
                        <>
                          <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2 font-semibold">
                                <TransportIcon kind={selectedMachine.transport.kind} />
                                <span className="truncate">{selectedMachine.name}</span>
                              </div>
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {selectedMachine.id}
                              </Badge>
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {formatTransportSummary(selectedMachine.transport)}
                            </div>
                            {selectedMachine.driverPackage && (
                              <div className="truncate font-mono text-[11px] text-muted-foreground" title={selectedMachine.driverPackage}>
                                pkg: {selectedMachine.driverPackage}
                              </div>
                            )}
                            <div className="rounded border bg-background/80 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
                                {t("cliRoutingLabel")}
                              </div>
                              <code className="text-foreground">
                                {formatCliControllerExample(selectedMachine)}
                              </code>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <h3 className="font-semibold uppercase tracking-wider text-muted-foreground">
                                {ct("groupTitles.device")} ({selectedMachineControllers.length})
                              </h3>
                              {capsDriversLabel(capabilities.value)}
                            </div>

                            {capabilities.error ? (
                              <Alert variant="destructive">
                                <XCircle className="size-4" aria-hidden="true" />
                                <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <span>{capabilities.error}</span>
                                  <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={capabilities.retry}>
                                    {ct("refresh")}
                                  </Button>
                                </AlertDescription>
                              </Alert>
                            ) : !capabilities.value ? (
                              <p className="text-xs text-muted-foreground">{ct("loadingDesc")}</p>
                            ) : capabilities.value.sources.device.status === "error" ? (
                              <p className="text-xs text-destructive">{ct("sourceFailure")}</p>
                            ) : selectedMachineControllers.length === 0 ? (
                              normalizedDaemon.mountedById.size > 0 && !selectedMachine.isMounted ? (
                                <div className="space-y-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                                  <p>{fmt("unmountedPrompt", { id: selectedMachine.id })}</p>
                                  {project && !selectedMachine.isImplicit && (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      className="h-7 text-xs"
                                      disabled={busyMachineId === selectedMachine.id}
                                      onClick={() => void controlWorkspaceMachine("mount", selectedMachine.id)}
                                    >
                                      <PlugIcon className="size-3" aria-hidden="true" />
                                      {t("mountNowBtn")}
                                    </Button>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground">{ct("sourceEmpty.device")}</p>
                              )
                            ) : (
                              <DeviceCapabilityDeclarations
                                items={selectedMachineControllers}
                                title={ct("groupTitles.device")}
                              />
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("emptyPoolFilter")}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div role="tabpanel">
                    <div className="baseware-tabpanel-inner space-y-4">
                      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {t("liveLeaseTitle")}
                          </h3>
                          {daemon?.status && (
                            <Badge variant={daemon.status.connected ? "default" : "outline"} className="text-[11px]">
                              {daemon.status.mode}
                            </Badge>
                          )}
                        </div>
                        <dl className="grid grid-cols-1 gap-2 text-xs">
                          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
                            <dt className="text-muted-foreground">{t("basewareSocketLabel")}</dt>
                            <dd className="truncate font-mono text-[11px]" title={daemon?.basewareSocket ?? ""}>
                              {daemon?.basewareSocket ?? "—"}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
                            <dt className="text-muted-foreground">{t("basewareJobLabel")}</dt>
                            <dd className="font-mono text-[11px]">
                              {daemon?.basewareJob
                                ? `${daemon.basewareJob.state ?? "stopped"}${daemon.basewareJob.pid ? ` (PID ${daemon.basewareJob.pid})` : ""}`
                                : t("notRegistered")}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
                            <dt className="text-muted-foreground">{t("emulatorJobLabel")}</dt>
                            <dd className="font-mono text-[11px]">
                              {daemon?.emulatorJob
                                ? `${daemon.emulatorJob.state ?? "stopped"}${daemon.emulatorJob.pid ? ` (PID ${daemon.emulatorJob.pid})` : ""}`
                                : t("notRegistered")}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <dt className="text-muted-foreground">{t("epochLabel")}</dt>
                            <dd className="font-mono text-[11px]">
                              {daemon?.status?.epoch ?? "—"}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Dialog 1: Register Driver Package */}
      <DriverRegisterDialog
        open={driverModalOpen}
        onClose={() => setDriverModalOpen(false)}
        onRegister={async spec => {
          const saved = await registerDriver(spec);
          setActionNotice(fmt("driverRegisteredNotice", { id: saved.id }));
        }}
      />

      {/* Dialog 2: Create / Edit / Promote Machine */}
      <MachineEditorDialog
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setEditingGlobalId(null);
        }}
        title={editorTitle}
        initialDraft={editorDraft}
        editingGlobalId={editingGlobalId}
        hasWorkspace={Boolean(project)}
        drivers={drivers}
        existingMachineIds={existingGlobalIds}
        onSave={upsertMachine}
        onProbe={probeDraftMachine}
      />

      {/* Dialog 3: Delete Machine Confirmation (no backdrop dismiss; autofocus Cancel) */}
      <BasewareModalDialog
        open={Boolean(confirmDeleteTarget)}
        onClose={() => setConfirmDeleteTarget(null)}
        title={t("confirmDeleteTitle")}
        closeLabel={t("closeDialog")}
        closedBy="closerequest"
        size="sm"
      >
        {confirmDeleteTarget && (
          <div className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {fmt("confirmDeleteBody", {
                name: confirmDeleteTarget.name,
                id: confirmDeleteTarget.id,
              })}
            </p>
            <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                autoFocus
                onClick={() => setConfirmDeleteTarget(null)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busyMachineId === confirmDeleteTarget.id}
                onClick={() => {
                  const target = confirmDeleteTarget;
                  setConfirmDeleteTarget(null);
                  void deleteMachine(target.id).catch(() => {});
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t("confirmDeleteBtn")}
              </Button>
            </div>
          </div>
        )}
      </BasewareModalDialog>
    </div>
  );
}

function capsDriversLabel(caps: CapabilitiesResult | undefined) {
  const drivers = caps?.deviceSnapshot?.drivers;
  if (!drivers || drivers.length === 0) return null;
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {drivers.map(d => `${d.id}${d.version ? ` (${d.version})` : ""}`).join(", ")}
    </span>
  );
}
