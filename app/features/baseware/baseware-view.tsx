"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Cpu,
  Edit3,
  Eye,
  Gamepad2,
  Globe,
  HardDrive,
  PackagePlus,
  Play,
  Plus,
  Plug as PlugIcon,
  Radio,
  RefreshCw,
  Server,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  Unplug,
  X,
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
import {
  AdvancedDiagnosticsDisclosure,
  InlineCopyButton,
  SingleLineTruncate,
} from "@/components/ui/settings-primitives";
import { BasewareModalDialog } from "./baseware-modal-dialog";
import { DriverRegisterDialog } from "./driver-register-dialog";
import { MachineEditorDialog } from "./machine-editor-dialog";
import {
  buildDisplayMachines,
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

type MainTab = "devices" | "drivers";
type DriverFilter = "all" | "current" | "registered" | "unregistered";
type PoolFilter = "all" | "current" | "online";

function isPointOutsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX < rect.left
    || clientX > rect.right
    || clientY < rect.top
    || clientY > rect.bottom
  );
}

function driverSourceLabelKey(driver: BasewareDriverOverviewItem): string {
  switch (driver.sourceKind) {
    case "builtin":
      return "driverBuiltinPkg";
    case "file":
      return "driverLocalPkg";
    case "github":
      return "driverGithubPkg";
    case "npm":
      return "driverNpmPkg";
    default:
      if (driver.spec.startsWith("driver:")) return "driverBuiltinPkg";
      if (driver.spec.startsWith("file:")) return "driverLocalPkg";
      if (driver.spec.startsWith("github:") || driver.spec.includes("github.com")) return "driverGithubPkg";
      return "driverNpmPkg";
  }
}

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

  const [activeTab, setActiveTab] = useState<MainTab>("devices");
  const [driverFilter, setDriverFilter] = useState<DriverFilter>("all");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Modal dialog states
  const [driverModalOpen, setDriverModalOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGlobalId, setEditingGlobalId] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState<MachineDraft>(() => createEmptyMachineDraft("primary"));
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<DisplayMachineItem | null>(null);

  const devicesTabId = useId();
  const driversTabId = useId();
  const drawerTitleId = useId();

  const tabRefs = useRef<Record<MainTab, HTMLButtonElement | null>>({
    devices: null,
    drivers: null,
  });
  const drawerDialogRef = useRef<HTMLDialogElement | null>(null);
  const drawerPointerOutsideRef = useRef(false);

  const displayMachines = useMemo(() => buildDisplayMachines(snapshot), [snapshot]);
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
        case "current":
          return machine.workspaceAdditionStatus !== "not-added";
        case "online":
          return machine.isMounted;
        default:
          return true;
      }
    });
  }, [displayMachines, poolFilter]);

  const selectedMachine = useMemo(
    () => displayMachines.find(m => m.id === selectedMachineId) ?? null,
    [displayMachines, selectedMachineId],
  );

  // Close drawer automatically if the inspected machine was deleted
  useEffect(() => {
    if (drawerOpen && !selectedMachine) {
      setDrawerOpen(false);
    }
  }, [drawerOpen, selectedMachine]);

  // Sync native modal <dialog> for the right-side detail drawer
  useEffect(() => {
    const dialog = drawerDialogRef.current;
    if (!dialog) return;
    if (drawerOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [drawerOpen]);

  // Light-dismiss fallback when browser lacks HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialog = drawerDialogRef.current;
    if (!dialog || !drawerOpen) return;
    if (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      drawerPointerOutsideRef.current = isPointOutsideRect(event.clientX, event.clientY, rect);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const startedOutside = drawerPointerOutsideRef.current;
      drawerPointerOutsideRef.current = false;
      if (!startedOutside) return;
      const rect = dialog.getBoundingClientRect();
      if (isPointOutsideRect(event.clientX, event.clientY, rect)) {
        dialog.close();
      }
    };

    dialog.addEventListener("pointerdown", handlePointerDown);
    dialog.addEventListener("pointerup", handlePointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", handlePointerDown);
      dialog.removeEventListener("pointerup", handlePointerUp);
    };
  }, [drawerOpen]);

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

  const openMachineDrawer = (machineId: string) => {
    setSelectedMachineId(machineId);
    setDrawerOpen(true);
  };

  const handleDrawerClose = () => {
    const dialog = drawerDialogRef.current;
    if (dialog && dialog.returnValue) {
      dialog.returnValue = "";
    }
    setDrawerOpen(false);
  };

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

  const selectMainTab = (tab: MainTab) => {
    setActiveTab(tab);
    tabRefs.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const handleMainTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const order: MainTab[] = ["devices", "drivers"];
    const currentIndex = order.indexOf(activeTab);
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
      setActiveTab(nextTab);
      const target = tabRefs.current[nextTab];
      target?.focus();
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const editorTitle = editingGlobalId
    ? `${t("editMachineTitle")}: ${editingGlobalId}`
    : t("newMachineTitle");

  const cliExample = selectedMachine ? formatCliControllerExample(selectedMachine) : "";

  return (
    <div className="space-y-5 p-4 md:p-6" data-baseware-view>
      {/* Compact Header Bar with Single-Row ARIA Tablist */}
      <header className="baseware-header-bar">
        <div className="baseware-header-leading">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-primary" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight">{t("pageTitle")}</h1>
          </div>

          <div className="baseware-tablist" role="tablist" aria-label={t("pageTitle")}>
            <button
              ref={el => { tabRefs.current.devices = el; }}
              id={devicesTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === "devices"}
              tabIndex={activeTab === "devices" ? 0 : -1}
              onClick={() => selectMainTab("devices")}
              onKeyDown={handleMainTabKeyDown}
              className="baseware-tab"
            >
              <Server className="size-3.5" aria-hidden="true" />
              <span>{t("tabDevices")}</span>
            </button>
            <button
              ref={el => { tabRefs.current.drivers = el; }}
              id={driversTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === "drivers"}
              tabIndex={activeTab === "drivers" ? 0 : -1}
              onClick={() => selectMainTab("drivers")}
              onKeyDown={handleMainTabKeyDown}
              className="baseware-tab"
            >
              <HardDrive className="size-3.5" aria-hidden="true" />
              <span>{t("tabDrivers")}</span>
            </button>
          </div>
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
      </header>

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

      {/* Tabpanels: ZERO padding/border/margin on [role="tabpanel"] itself */}
      <div className="baseware-tabpanels">
        {/* TAB 1: Controlled Devices */}
        <div
          role="tabpanel"
          aria-labelledby={devicesTabId}
          hidden={activeTab !== "devices"}
          data-baseware-section="machine-pool"
        >
          <div className="baseware-tabpanel-inner space-y-3">
            <search className="baseware-filter-bar" aria-label={t("poolFilterLabel")}>
              {(
                [
                  { key: "all", label: t("poolFilterAll") },
                  { key: "current", label: t("poolFilterCurrent") },
                  { key: "online", label: t("poolFilterOnline") },
                ] as const
              ).map(item => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={poolFilter === item.key}
                  className="baseware-filter-pill"
                  onClick={() => setPoolFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </search>

            {filteredMachines.length === 0 ? (
              <div className="border-y border-border/75 py-6 text-xs text-muted-foreground">
                {t("emptyPoolFilter")}
              </div>
            ) : (
              <ul role="list" className="settings-rows">
                {filteredMachines.map(machine => {
                  const isUnregistered = machine.registrationStatus === "unregistered";
                  const isBusy = busyMachineId === machine.id;
                  const probe = probeStates[machine.id];
                  const isInspecting = drawerOpen && selectedMachine?.id === machine.id;

                  return (
                    <li
                      key={machine.id}
                      data-baseware-machine={machine.id}
                      className="baseware-list-row"
                    >
                      <div className="baseware-list-row-main">
                        <button
                          type="button"
                          onClick={() => openMachineDrawer(machine.id)}
                          aria-expanded={isInspecting}
                          className="baseware-device-trigger"
                        >
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                            <TransportIcon kind={machine.transport.kind} />
                          </div>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium text-foreground">{machine.name}</span>
                              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                <span
                                  aria-hidden="true"
                                  className={`size-2 rounded-full ${
                                    machine.isMounted ? "bg-emerald-400" : "bg-muted-foreground/40"
                                  }`}
                                />
                                <span>{t(machine.isMounted ? "nodeMountConnected" : "nodeMountStandby")}</span>
                              </span>
                              {machine.workspaceAdditionStatus === "primary" && (
                                <Badge
                                  variant="outline"
                                  className="border-amber-400/45 bg-amber-400/10 text-[10px] text-amber-300"
                                >
                                  {t("deviceInUse")}
                                </Badge>
                              )}
                              {machine.workspaceAdditionStatus === "added" && (
                                <Badge
                                  variant="outline"
                                  className="border-primary/40 bg-primary/10 text-[10px] text-primary"
                                >
                                  {t("nodeAddAdded")}
                                </Badge>
                              )}
                              {isUnregistered && (
                                <Badge
                                  variant="outline"
                                  className="border-border/80 text-[10px] text-muted-foreground"
                                >
                                  {t("deviceWorkspaceLocal")}
                                </Badge>
                              )}
                            </div>
                            <SingleLineTruncate
                              text={`${machine.driver} · ${machine.transport.kind.toUpperCase()} · ${formatTransportSummary(machine.transport)}`}
                              mono
                              className="text-[11px] text-muted-foreground"
                            />
                          </div>
                        </button>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {isUnregistered ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                aria-label={`${t("deviceSaveGlobal")}: ${machine.name}`}
                                data-baseware-promote-machine={machine.id}
                                onClick={() => openEditorForPromote(machine)}
                              >
                                <Sparkles className="size-3" aria-hidden="true" />
                                {t("deviceSaveGlobal")}
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
                                {machine.workspaceAdditionStatus !== "primary" && (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    disabled={isBusy}
                                    aria-label={`${t("deviceSetActive")}: ${machine.name}`}
                                    data-baseware-set-primary={machine.id}
                                    onClick={() => void controlWorkspaceMachine("setPrimary", machine.id)}
                                  >
                                    <Star className="size-3" aria-hidden="true" />
                                    {t("deviceSetActive")}
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

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            aria-expanded={isInspecting}
                            aria-label={`${t("inspectDevice")}: ${machine.name}`}
                            onClick={() => openMachineDrawer(machine.id)}
                          >
                            <Eye className="size-3" aria-hidden="true" />
                            {t("inspectDevice")}
                          </Button>
                        </div>
                      </div>

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
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* TAB 2: Driver Library */}
        <div
          role="tabpanel"
          aria-labelledby={driversTabId}
          hidden={activeTab !== "drivers"}
          data-baseware-section="driver-library"
        >
          <div className="baseware-tabpanel-inner space-y-3">
            <search className="baseware-filter-bar" aria-label={t("driverFilterLabel")}>
              {(
                [
                  { key: "all", label: t("driverFilterAll") },
                  { key: "current", label: t("driverFilterCurrent") },
                  { key: "registered", label: t("driverFilterRegistered") },
                  { key: "unregistered", label: t("driverFilterUnregistered") },
                ] as const
              ).map(item => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={driverFilter === item.key}
                  className="baseware-filter-pill"
                  onClick={() => setDriverFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </search>

            {filteredDrivers.length === 0 ? (
              <div className="border-y border-border/75 py-6 text-xs text-muted-foreground">
                {t("emptyDriverFilter")}
              </div>
            ) : (
              <ul role="list" className="settings-rows">
                {filteredDrivers.map(driver => {
                  const isBusy = busyDriverKey === driver.key || busyDriverKey === driver.id;
                  const summaryLine = driver.description || driver.packageName || "";
                  return (
                    <li
                      key={driver.key}
                      data-baseware-driver={driver.id}
                      className="baseware-list-row settings-copyable"
                    >
                      <div className="baseware-list-row-main">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-sm font-medium text-foreground">{driver.id}</span>
                            {driver.version && (
                              <span className="font-mono text-[11px] text-muted-foreground">v{driver.version}</span>
                            )}
                            <span className="text-[11px] text-muted-foreground">
                              · {t(driverSourceLabelKey(driver))}
                            </span>

                            {driver.usedByCurrentWorkspace ? (
                              <Badge
                                variant="outline"
                                className="border-primary/45 bg-primary/10 text-[10px] text-primary"
                              >
                                {t("driverUsedHere")}
                              </Badge>
                            ) : driver.usedByMachineIds.length > 0 ? (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                {fmt("driverUsedByNodes", { count: driver.usedByMachineIds.length })}
                              </Badge>
                            ) : null}

                            {driver.registrationStatus === "registered" && (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-300"
                              >
                                {t("driverRegRegistered")}
                              </Badge>
                            )}
                          </div>

                          {summaryLine && (
                            <SingleLineTruncate
                              text={summaryLine}
                              className="text-xs text-muted-foreground"
                            />
                          )}

                          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                            <SingleLineTruncate text={driver.spec} mono className="flex-1" />
                            <InlineCopyButton
                              text={driver.spec}
                              ariaLabel={`${t("copySpec")}: ${driver.id}`}
                              copiedText={t("copiedNotice")}
                              failedText={t("copyFailedNotice")}
                              revealOnHover
                            />
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {driver.registrationStatus === "unregistered" && !driver.spec.startsWith("driver:") && (
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              disabled={isBusy}
                              aria-label={`${t("driverSaveGlobal")}: ${driver.id}`}
                              data-baseware-register-driver={driver.id}
                              onClick={() => {
                                void registerDriver(driver.spec, driver.key).then(() => {
                                  setActionNotice(fmt("driverRegisteredNotice", { id: driver.id }));
                                }).catch(() => {});
                              }}
                            >
                              <PackagePlus className="size-3" aria-hidden="true" />
                              {t("driverSaveGlobal")}
                            </Button>
                          )}

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            aria-label={`${t("driverNewDevice")}: ${driver.id}`}
                            onClick={() => openEditorFromDriver(driver)}
                          >
                            {t("driverNewDevice")}
                          </Button>

                          {driver.registrationStatus === "registered" && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                              disabled={isBusy}
                              aria-label={`${t("driverRemoveGlobal")}: ${driver.id}`}
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
                              {t("driverRemoveGlobal")}
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Right-Side Native Modal Detail Drawer */}
      <dialog
        ref={drawerDialogRef}
        aria-labelledby={drawerTitleId}
        onClose={handleDrawerClose}
        className="baseware-drawer"
        data-baseware-section="controllers-catalog"
        data-capability-source="device"
        {...({ closedby: "any" } as Record<string, string>)}
      >
        <div className="baseware-drawer-header">
          <div className="flex min-w-0 items-center gap-2.5">
            {selectedMachine ? (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                <TransportIcon kind={selectedMachine.transport.kind} />
              </div>
            ) : (
              <Server className="size-4 shrink-0 text-primary" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={drawerTitleId} className="truncate text-sm font-semibold text-foreground">
                  {selectedMachine ? selectedMachine.name : t("drawerTitle")}
                </h2>
                {selectedMachine && (
                  <Badge
                    variant="outline"
                    className={
                      selectedMachine.isMounted
                        ? "border-emerald-500/45 bg-emerald-500/15 text-[10px] text-emerald-300"
                        : "text-[10px] text-muted-foreground"
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={`mr-1 inline-block size-1.5 rounded-full ${
                        selectedMachine.isMounted ? "bg-emerald-400" : "bg-muted-foreground/40"
                      }`}
                    />
                    {t(selectedMachine.isMounted ? "nodeMountConnected" : "nodeMountStandby")}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            autoFocus
            className="h-7 shrink-0 px-2"
            onClick={() => drawerDialogRef.current?.close()}
            aria-label={t("closeDialog")}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="baseware-drawer-body space-y-5">
          {selectedMachine && (
            <>
              {/* Quick actions strip */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => void probeMachine(selectedMachine)}
                  disabled={probeStates[selectedMachine.id] === "probing"}
                >
                  <Play className="size-3" aria-hidden="true" />
                  {probeStates[selectedMachine.id] === "probing" ? t("probing") : t("probe")}
                </Button>

                {selectedMachine.registrationStatus === "unregistered" ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => openEditorForPromote(selectedMachine)}
                  >
                    <Sparkles className="size-3" aria-hidden="true" />
                    {t("deviceSaveGlobal")}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => openEditorForMachine(selectedMachine)}
                    >
                      <Edit3 className="size-3" aria-hidden="true" />
                      {t("edit")}
                    </Button>
                    {selectedMachine.registrationStatus !== "builtin" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => setConfirmDeleteTarget(selectedMachine)}
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                        {t("delete")}
                      </Button>
                    )}
                  </>
                )}

                {project && selectedMachine.registrationStatus !== "unregistered" && (
                  <>
                    {selectedMachine.workspaceAdditionStatus === "not-added" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={busyMachineId === selectedMachine.id}
                        onClick={() => void controlWorkspaceMachine("toggleAllowed", selectedMachine.id)}
                      >
                        {t("addToWorkspaceBtn")}
                      </Button>
                    )}
                    {selectedMachine.workspaceAdditionStatus !== "primary" && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={busyMachineId === selectedMachine.id}
                        onClick={() => void controlWorkspaceMachine("setPrimary", selectedMachine.id)}
                      >
                        <Star className="size-3" aria-hidden="true" />
                        {t("deviceSetActive")}
                      </Button>
                    )}
                    {selectedMachine.isMounted ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={busyMachineId === selectedMachine.id}
                        onClick={() => void controlWorkspaceMachine("unmount", selectedMachine.id)}
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
                          className="h-7 px-2.5 text-xs"
                          disabled={busyMachineId === selectedMachine.id}
                          onClick={() => void controlWorkspaceMachine("mount", selectedMachine.id)}
                        >
                          <PlugIcon className="size-3" aria-hidden="true" />
                          {t("coMountBtn")}
                        </Button>
                      )
                    )}
                    {selectedMachine.workspaceAdditionStatus === "added" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        disabled={busyMachineId === selectedMachine.id}
                        onClick={() => void controlWorkspaceMachine("toggleAllowed", selectedMachine.id)}
                      >
                        {t("removeFromWorkspaceBtn")}
                      </Button>
                    )}
                  </>
                )}

                {project && selectedMachine.registrationStatus === "unregistered" && selectedMachine.isMounted && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={busyMachineId === selectedMachine.id}
                    onClick={() => void controlWorkspaceMachine("reconnect", selectedMachine.id)}
                  >
                    <RefreshCw className="size-3" aria-hidden="true" />
                    {t("reconnectBtn")}
                  </Button>
                )}

                <Button asChild variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs">
                  <a
                    href={deviceGuideHref}
                    onClick={event => {
                      if (isPlainNavigationClick(event)) {
                        event.preventDefault();
                        drawerDialogRef.current?.close();
                        onNavigate(deviceGuideHref);
                      }
                    }}
                  >
                    <BookOpen className="size-3.5" aria-hidden="true" />
                    {ct("deviceGuide")}
                  </a>
                </Button>
              </div>

              {(() => {
                const probe = probeStates[selectedMachine.id];
                if (!probe || probe === "probing") return null;
                return (
                  <div
                    className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] ${
                      probe.ok
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-destructive/40 bg-destructive/10 text-destructive"
                    }`}
                  >
                    {probe.ok ? t("probeOk") : t("probeFailed")} ({probe.latencyMs}ms): {probe.detail}
                  </div>
                );
              })()}

              {/* Clean metadata rows */}
              <dl className="settings-rows text-xs">
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="shrink-0 text-muted-foreground">{t("driverLabel")}</dt>
                  <dd className="min-w-0 font-mono text-foreground">{selectedMachine.driver}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="shrink-0 text-muted-foreground">{t("endpointLabel")}</dt>
                  <dd className="min-w-0 font-mono text-foreground">
                    <SingleLineTruncate
                      text={`${selectedMachine.transport.kind.toUpperCase()} · ${formatTransportSummary(selectedMachine.transport)}`}
                      mono
                    />
                  </dd>
                </div>
              </dl>

              {/* Controllers section */}
              <section className="space-y-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <h3 className="font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("controllersSectionTitle")} ({selectedMachineControllers.length})
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
                    title={t("controllersSectionTitle")}
                  />
                )}
              </section>

              {/* Collapsed Advanced Diagnostics Disclosure */}
              <AdvancedDiagnosticsDisclosure summary={t("drawerAdvancedTitle")}>
                <div className="space-y-3 text-xs">
                  <dl className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldId")}</dt>
                      <dd className="min-w-0 font-mono text-[11px] text-foreground">{selectedMachine.id}</dd>
                    </div>

                    {selectedMachine.driverPackage && (
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{t("driverPathLabel")}</dt>
                        <dd className="flex min-w-0 items-center gap-1.5">
                          <SingleLineTruncate
                            text={selectedMachine.driverPackage}
                            mono
                            className="text-[11px] text-foreground"
                          />
                          <InlineCopyButton
                            text={selectedMachine.driverPackage}
                            ariaLabel={`${t("copySpec")}: ${selectedMachine.driverPackage}`}
                            copiedText={t("copiedNotice")}
                            failedText={t("copyFailedNotice")}
                          />
                        </dd>
                      </div>
                    )}

                    <div className="space-y-1">
                      <dt className="text-[11px] text-muted-foreground">{t("cliRoutingLabel")}</dt>
                      <dd className="flex items-center justify-between gap-2 rounded border bg-background/80 px-2.5 py-1.5">
                        <SingleLineTruncate text={cliExample} mono className="text-[11px] text-foreground" />
                        <InlineCopyButton
                          text={cliExample}
                          ariaLabel={t("copyCli")}
                          copiedText={t("copiedNotice")}
                          failedText={t("copyFailedNotice")}
                        />
                      </dd>
                    </div>
                  </dl>

                  <div className="space-y-2 border-t border-border/60 pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t("liveLeaseTitle")}
                      </h4>
                      {daemon?.status && (
                        <Badge variant={daemon.status.connected ? "default" : "outline"} className="text-[10px]">
                          {daemon.status.mode}
                        </Badge>
                      )}
                    </div>
                    <dl className="space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{t("basewareSocketLabel")}</dt>
                        <dd className="min-w-0">
                          <SingleLineTruncate
                            text={daemon?.basewareSocket ?? "—"}
                            mono
                            className="text-[11px] text-foreground"
                          />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{t("basewareJobLabel")}</dt>
                        <dd className="font-mono text-foreground">
                          {daemon?.basewareJob
                            ? `${daemon.basewareJob.state ?? "stopped"}${daemon.basewareJob.pid ? ` (PID ${daemon.basewareJob.pid})` : ""}`
                            : t("notRegistered")}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{t("emulatorJobLabel")}</dt>
                        <dd className="font-mono text-foreground">
                          {daemon?.emulatorJob
                            ? `${daemon.emulatorJob.state ?? "stopped"}${daemon.emulatorJob.pid ? ` (PID ${daemon.emulatorJob.pid})` : ""}`
                            : t("notRegistered")}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-muted-foreground">{t("epochLabel")}</dt>
                        <dd className="font-mono text-foreground">{daemon?.status?.epoch ?? "—"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </AdvancedDiagnosticsDisclosure>
            </>
          )}
        </div>
      </dialog>

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
