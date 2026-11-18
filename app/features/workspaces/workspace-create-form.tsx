"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BoxesIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CpuIcon,
  FolderIcon,
  FolderOpenIcon,
  MonitorIcon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelMark } from "@/components/ui/pixel-mark";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ModelPickerDialog, shortModelLabel } from "@/components/model-picker-dialog";
import { useTranslations } from "@/lib/locale";
import { useNativePathPicker } from "@/lib/use-native-path-picker";
import type { DiscoveredDriver } from "@/lib/drivers";
import type {
  BasewareDriverOverviewItem,
  BasewareMachineRuntimeStatus,
  CreateWorkspaceInput,
} from "@/lib/workspaces";
import type { WorkspaceDefaults, WorkspaceRegistration } from "@ludens/protocol/ludens";
import { BUILTIN_CUA_DRIVER, BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";
import { BUILTIN_LOCAL_DESKTOP_MACHINE } from "@ludens/protocol/machines";
import {
  isSelectedModelAuthenticated,
  resolveCreationModelDefaults,
  useWorkspaceCreationCatalog,
} from "@/features/workspaces/use-workspace-creation-catalog";
import {
  effectiveTargetMode,
  findExistingWorkspaceConflict,
  initialWorkspaceSetup,
  switchWorkspaceTargetMode,
  workspaceCreateInput,
  workspaceDriverCapabilities,
  workspaceLocation,
  type WorkspaceCreationIntent,
  type WorkspaceSetupIssue,
  type WorkspaceTargetMode,
} from "@/features/workspaces/workspace-create-model";

const COMMON_ROM_EXTENSIONS = [
  "gba",
  "gbc",
  "gb",
  "nds",
  "sfc",
  "smc",
  "nes",
  "n64",
  "z64",
  "iso",
  "cue",
  "chd",
  "nsp",
  "xci",
  "rom",
  "bin",
  "zip",
];

function formatMachineTransportSummary(machine: BasewareMachineRuntimeStatus): string {
  const t = machine.transport;
  switch (t.kind) {
    case "bridge":
      return `bridge · ${t.host ?? "127.0.0.1"}:${t.port}`;
    case "stdio":
      return `stdio · ${t.command ?? "cua-driver"}`;
    case "ssh":
      return `ssh · ${t.user ? `${t.user}@` : ""}${t.host}`;
    case "http":
    case "sse":
      return `${t.kind} · ${t.url}`;
  }
}

export function WorkspaceCreateForm({
  defaultRoot,
  globalDefaults,
  existingWorkspaces,
  initialIntent,
  pending,
  pendingStep = null,
  error,
  launchRecovery = null,
  onSubmit,
  onRetryLaunch,
  onEnterExistingWorkspace,
  onConfigureWorkspace,
  onCancel,
}: {
  defaultRoot: string;
  globalDefaults?: WorkspaceDefaults;
  existingWorkspaces?: readonly (WorkspaceRegistration & { available?: boolean })[];
  initialIntent?: WorkspaceCreationIntent | null;
  pending: boolean;
  pendingStep?: "creating" | "launching" | null;
  error: string;
  launchRecovery?: { entry: WorkspaceRegistration; error: string } | null;
  onSubmit(input: CreateWorkspaceInput, launchAfterCreate: boolean): void;
  onRetryLaunch?(entry: WorkspaceRegistration): void;
  onEnterExistingWorkspace?(id: string): void;
  onConfigureWorkspace?(id: string): void;
  onCancel(): void;
}) {
  const t = useTranslations("workspaceSetup");
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const request = useRef<AbortController | null>(null);
  const submitModeRef = useRef<"create-only" | "create-and-launch">("create-and-launch");

  const catalog = useWorkspaceCreationCatalog({ enabled: true });
  const nativePicker = useNativePathPicker();

  const availableMachines = useMemo<BasewareMachineRuntimeStatus[]>(() => {
    if (catalog.machines.length > 0) return catalog.machines;
    return [{ ...BUILTIN_LOCAL_DESKTOP_MACHINE, usedByWorkspaceIds: [] }];
  }, [catalog.machines]);

  const availableDrivers = useMemo<BasewareDriverOverviewItem[]>(() => {
    if (catalog.drivers.length > 0) return catalog.drivers;
    return [
      {
        key: BUILTIN_CUA_DRIVER_SPEC,
        id: BUILTIN_CUA_DRIVER.id,
        spec: BUILTIN_CUA_DRIVER_SPEC,
        sourceKind: "builtin",
        registrationStatus: "builtin",
        available: true,
        name: BUILTIN_CUA_DRIVER.name,
        version: BUILTIN_CUA_DRIVER.version,
        description: BUILTIN_CUA_DRIVER.description,
        transport: "stdio",
        needsGame: false,
        launchHint: BUILTIN_CUA_DRIVER.launchHint,
        usedByMachineIds: ["local-desktop"],
        usedByWorkspaceIds: [],
        usedByCurrentWorkspace: false,
        updatedAt: BUILTIN_CUA_DRIVER.updatedAt,
      },
    ];
  }, [catalog.drivers]);

  const [draft, setDraft] = useState(() => {
    const initial = initialWorkspaceSetup(initialIntent).draft;
    if (!initial.targetMode) {
      return {
        ...initial,
        targetMode: "machine" as const,
        machineId: initial.machineId || BUILTIN_LOCAL_DESKTOP_MACHINE.id,
        driverId: "cua",
      };
    }
    return initial;
  });
  const [driver, setDriver] = useState<DiscoveredDriver | null>(
    () => initialWorkspaceSetup(initialIntent).driver,
  );
  const [selectedDriverKey, setSelectedDriverKey] = useState<string>(BUILTIN_CUA_DRIVER_SPEC);
  const [probingCatalogDriver, setProbingCatalogDriver] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [issue, setIssue] = useState<WorkspaceSetupIssue | null>(null);
  const [showCustomLocation, setShowCustomLocation] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelManuallyChosenRef = useRef(false);

  // Sync initial model defaults from global config + live authenticated catalog until user overrides
  const resolvedModelDefaults = useMemo(
    () => resolveCreationModelDefaults(globalDefaults, catalog.modelsCatalog),
    [globalDefaults, catalog.modelsCatalog],
  );

  useEffect(() => {
    if (modelManuallyChosenRef.current) return;
    setDraft(prev => ({
      ...prev,
      model: resolvedModelDefaults.model,
      serviceTier: resolvedModelDefaults.serviceTier,
      effort: resolvedModelDefaults.effort,
    }));
  }, [
    resolvedModelDefaults.model,
    resolvedModelDefaults.serviceTier,
    resolvedModelDefaults.effort,
  ]);

  useEffect(() => () => {
    const active = request.current;
    request.current = null;
    active?.abort();
  }, []);

  const mode = effectiveTargetMode(draft);
  const selectedCatalogDriver = useMemo(
    () =>
      mode === "driver"
        ? availableDrivers.find(item => item.key === selectedDriverKey) ?? availableDrivers[0] ?? null
        : null,
    [mode, availableDrivers, selectedDriverKey],
  );

  // When selecting an installed/cached non-builtin driver in Mode 2, auto-probe its manifest once for accurate `launchCommand` / `defaultPort`
  useEffect(() => {
    if (mode !== "driver" || !selectedCatalogDriver || selectedCatalogDriver.spec === BUILTIN_CUA_DRIVER_SPEC) {
      setProbingCatalogDriver(false);
      return;
    }
    const spec = selectedCatalogDriver.spec;
    if (catalog.discoveredCache[spec]) {
      setDriver(catalog.discoveredCache[spec]!);
      setProbingCatalogDriver(false);
      return;
    }
    let cancelled = false;
    setProbingCatalogDriver(true);
    void catalog
      .discoverSpec(spec)
      .then(probed => {
        if (!cancelled) setDriver(probed);
      })
      .catch(() => {
        // Non-fatal: fallback metadata from catalog item still works
      })
      .finally(() => {
        if (!cancelled) setProbingCatalogDriver(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, selectedCatalogDriver, catalog]);

  const location = workspaceLocation(defaultRoot, draft);
  const existingConflict = useMemo(
    () => findExistingWorkspaceConflict(existingWorkspaces, defaultRoot, draft),
    [existingWorkspaces, defaultRoot, draft],
  );

  const effectiveEnvForCaps =
    mode === "machine"
      ? (availableMachines.find(m => m.id === draft.machineId)?.transport.kind === "stdio" ? "desktop" : "community")
      : mode === "driver"
        ? (selectedCatalogDriver?.spec === BUILTIN_CUA_DRIVER_SPEC || selectedCatalogDriver?.transport === "stdio"
            ? "desktop"
            : "community")
        : "community";

  const activeDiscoveredForCaps =
    mode === "driver"
      ? (selectedCatalogDriver && selectedCatalogDriver.spec !== BUILTIN_CUA_DRIVER_SPEC
          ? catalog.discoveredCache[selectedCatalogDriver.spec] ?? null
          : null)
      : mode === "package"
        ? driver
        : null;

  const capabilities = workspaceDriverCapabilities(
    effectiveEnvForCaps,
    activeDiscoveredForCaps,
    mode === "driver" ? selectedCatalogDriver : null,
  );
  const packageVerified =
    mode === "package" && !!driver && driver.spec === draft.driverPackage.trim();

  const locationPreview = !location.path
    ? t("invalidDirectory")
    : !location.custom && !draft.name.trim()
      ? `${location.path.replace(/\/$/, "")}/${t("folderPlaceholder")}`
      : location.path;

  const activeModel = draft.model?.trim() || resolvedModelDefaults.model;
  const modelAuthState = isSelectedModelAuthenticated(activeModel, catalog.modelsCatalog);

  const resetDiscovery = () => {
    const active = request.current;
    request.current = null;
    active?.abort();
    setDriver(null);
    setDiscovering(false);
    setDiscoveryError("");
    setIssue(null);
  };

  const selectTargetMode = (nextMode: WorkspaceTargetMode) => {
    if (mode === nextMode) return;
    resetDiscovery();
    const defaultMachine = availableMachines[0] ?? null;
    const defaultDriver =
      availableDrivers.find(item => item.key === selectedDriverKey) ?? availableDrivers[0] ?? null;
    setDraft(prev =>
      switchWorkspaceTargetMode(prev, nextMode, {
        defaultMachine,
        defaultDriver,
      }),
    );
  };

  const discoverSpecNow = async (explicitSpec?: string) => {
    const spec = (explicitSpec ?? draft.driverPackage).trim();
    if (!spec || pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDiscovering(true);
    setDiscoveryError("");
    setDriver(null);
    setIssue(null);
    try {
      const value = await catalog.discoverSpec(spec, controller.signal);
      if (!controller.signal.aborted) {
        setDriver(value);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setDiscoveryError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setDiscovering(false);
      }
    }
  };

  const handleBrowseCustomFolder = async () => {
    const picked = await nativePicker.pickPath({
      mode: "directory",
      title: t("customDirectory"),
      defaultPath: draft.targetDirectory.trim() || defaultRoot,
    });
    if (!picked) return;
    setShowCustomLocation(true);
    setIssue(null);
    setDraft(prev => ({ ...prev, targetDirectory: picked }));
  };

  const handleBrowseGameFile = async () => {
    const picked = await nativePicker.pickPath({
      mode: "file",
      title: t("gamePath"),
      defaultPath: draft.game.trim() || defaultRoot,
      extensions: COMMON_ROM_EXTENSIONS,
      filterName: "ROM / Target Executable",
    });
    if (!picked) return;
    setIssue(null);
    setDraft(prev => ({ ...prev, game: picked }));
  };

  const handleBrowseLocalPackage = async () => {
    const picked = await nativePicker.pickPath({
      mode: "directory",
      title: t("packageAddress"),
      defaultPath: defaultRoot,
    });
    if (!picked) return;
    const fileSpec = `file:${picked}`;
    resetDiscovery();
    setDraft(prev => ({
      ...prev,
      driverPackage: fileSpec,
      registerDriver: prev.registerDriver ?? true,
      game: "",
      port: undefined,
      cuaCommand: "",
    }));
    void discoverSpecNow(fileSpec);
  };

  const executeSubmit = (launchAfterCreate: boolean) => {
    if (pending || discovering) return;
    const result = workspaceCreateInput(defaultRoot, draft, activeDiscoveredForCaps, {
      machines: availableMachines,
      catalogDriver: mode === "driver" ? selectedCatalogDriver : null,
    });
    if (!result.ok) {
      setIssue(result.issue);
      if (result.issue.field === "targetDirectory") {
        setShowCustomLocation(true);
      }
      requestAnimationFrame(() => {
        const el = form.current?.elements.namedItem(result.issue.field) as HTMLElement | null;
        el?.focus();
      });
      return;
    }
    setIssue(null);
    onSubmit(result.input, launchAfterCreate);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    executeSubmit(submitModeRef.current === "create-and-launch");
  };

  const changeField = (
    field: "name" | "targetDirectory" | "game" | "port" | "cuaCommand",
    value: string,
  ) => {
    setIssue(null);
    setDraft(prev => ({ ...prev, [field]: value }));
  };

  // Post-create recovery view when workspace files succeeded in Phase 1, while service `up` needs attention in Phase 2
  if (launchRecovery) {
    return (
      <div className="grid min-w-0 gap-4" data-testid="workspace-launch-recovery">
        <div className="rounded-lg border border-success/35 bg-success/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-foreground">
                {t("launchRecoveryTitle").replace("{name}", launchRecovery.entry.name)}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("launchRecoverySubtitle")}
              </p>
              <p className="break-all pt-1 font-mono text-[11px] text-muted-foreground">
                {launchRecovery.entry.workspace}
              </p>
            </div>
          </div>
        </div>

        <Alert variant="destructive">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertDescription>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
              {launchRecovery.error}
            </pre>
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {onConfigureWorkspace ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onConfigureWorkspace(launchRecovery.entry.id)}
            >
              <Settings2Icon className="size-4" aria-hidden="true" />
              {t("openStudioAfterCreate")}
            </Button>
          ) : null}
          {onEnterExistingWorkspace ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onEnterExistingWorkspace(launchRecovery.entry.id)}
            >
              {t("enterLiveStandbyBtn")}
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
          {onRetryLaunch ? (
            <Button
              type="button"
              disabled={pending}
              onClick={() => onRetryLaunch(launchRecovery.entry)}
            >
              {pending ? (
                <RefreshCwIcon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <PlayIcon className="size-4 fill-current" aria-hidden="true" />
              )}
              {t(pending ? "retryingLaunchBtn" : "retryLaunchBtn")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const modeHint =
    mode === "machine"
      ? t("modeMachineHint")
      : mode === "driver"
        ? t("modeDriverHint")
        : t("modePackageHint");

  const statusText = pending
    ? pendingStep === "launching"
      ? t("stepLaunching")
      : t("stepCreating")
    : t("createHint");

  const submitDisabled =
    pending
    || discovering
    || (mode === "package" && (!packageVerified || (capabilities.missingPort && !draft.port?.trim())));

  return (
    <>
      <form
        ref={form}
        onSubmit={submit}
        noValidate
        className="grid min-w-0 gap-5"
        aria-busy={pending || discovering}
      >
        <fieldset disabled={pending} className="grid min-w-0 gap-5">
          {/* 1. Project Name & Storage Location */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${id}-name`}>{t("folderName")}</Label>
              {!showCustomLocation && !location.custom ? (
                <div className="flex items-center gap-1.5">
                  {nativePicker.supported ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={nativePicker.picking}
                      onClick={() => void handleBrowseCustomFolder()}
                    >
                      <FolderOpenIcon className="size-3.5" aria-hidden="true" />
                      {t("browseFolder")}
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => setShowCustomLocation(true)}
                  >
                    {t("customizeLocation")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => {
                    setShowCustomLocation(false);
                    changeField("targetDirectory", "");
                  }}
                >
                  {t("resetDefaultLocation")}
                </button>
              )}
            </div>

            <Input
              id={`${id}-name`}
              name="name"
              autoFocus
              value={location.custom ? location.name : draft.name}
              readOnly={location.custom}
              aria-readonly={location.custom}
              required
              maxLength={120}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("namePlaceholder")}
              aria-invalid={issue?.field === "name"}
              aria-describedby={
                location.custom
                  ? `${id}-name-hint`
                  : issue?.field === "name"
                    ? `${id}-name-error`
                    : undefined
              }
              onChange={event => changeField("name", event.target.value)}
            />
            {location.custom ? (
              <p id={`${id}-name-hint`} className="text-xs leading-relaxed text-muted-foreground">
                {t("nameFromDirectory")}
              </p>
            ) : null}
            {issue?.field === "name" ? (
              <p id={`${id}-name-error`} role="alert" className="text-xs text-destructive">
                {t(issue.message)}
              </p>
            ) : null}

            {(showCustomLocation || location.custom) ? (
              <div className="mt-1 grid gap-2 rounded-md border bg-muted/20 p-3">
                <Label htmlFor={`${id}-directory`} className="text-xs">
                  {t("customDirectory")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-directory`}
                    name="targetDirectory"
                    value={draft.targetDirectory}
                    maxLength={2000}
                    placeholder={t("directoryPlaceholder")}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={issue?.field === "targetDirectory"}
                    aria-describedby={`${id}-directory-hint${issue?.field === "targetDirectory" ? ` ${id}-directory-error` : ""}`}
                    onChange={event => changeField("targetDirectory", event.target.value)}
                  />
                  {nativePicker.supported ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={nativePicker.picking}
                      onClick={() => void handleBrowseCustomFolder()}
                    >
                      <FolderOpenIcon className="size-4" aria-hidden="true" />
                      {t("browseFolder")}
                    </Button>
                  ) : null}
                </div>
                <p id={`${id}-directory-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {t("directoryHint")}
                </p>
                {issue?.field === "targetDirectory" ? (
                  <p id={`${id}-directory-error`} role="alert" className="text-xs text-destructive">
                    {t(issue.message)}
                  </p>
                ) : null}
              </div>
            ) : (
              <div
                className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground"
                aria-label={t("workspaceLocation")}
              >
                <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <output className="min-w-0 truncate font-mono text-[11px]">{locationPreview}</output>
              </div>
            )}

            {existingConflict ? (
              <Alert className="mt-1 border-primary/35 bg-primary/5 py-2.5">
                <AlertTitle className="text-xs font-medium">
                  {t("duplicateWarningTitle").replace("{name}", existingConflict.name)}
                </AlertTitle>
                <AlertDescription className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>{t("duplicateWarningHint")}</span>
                  {onEnterExistingWorkspace && existingConflict.available !== false ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onEnterExistingWorkspace(existingConflict.id)}
                    >
                      {t("openExistingNow")}
                      <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          {/* 2. 3-Mode Target Environment Selector */}
          <div className="grid gap-2.5">
            <Label id={`${id}-target-mode`}>{t("connectTo")}</Label>
            <RadioGroup
              value={mode}
              onValueChange={val => selectTargetMode(val as WorkspaceTargetMode)}
              disabled={pending}
              aria-labelledby={`${id}-target-mode`}
              aria-describedby={`${id}-target-mode-hint`}
              className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
            >
              {(
                [
                  {
                    value: "machine" as const,
                    icon: CpuIcon,
                    title: t("modeMachine"),
                    subtitle: t("modeMachineSubtitle"),
                  },
                  {
                    value: "driver" as const,
                    icon: BoxesIcon,
                    title: t("modeDriver"),
                    subtitle: t("modeDriverSubtitle"),
                  },
                  {
                    value: "package" as const,
                    icon: PlugIcon,
                    title: t("modePackage"),
                    subtitle: t("modePackageSubtitle"),
                  },
                ] as const
              ).map(option => {
                const Icon = option.icon;
                const active = mode === option.value;
                return (
                  <Label
                    key={option.value}
                    htmlFor={`${id}-mode-${option.value}`}
                    data-target-mode={option.value}
                    className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring/60 ${
                      active
                        ? "border-[var(--gold)] bg-[var(--surface-inset)]"
                        : "border-border hover:bg-muted/50"
                    } ${pending ? "pointer-events-none opacity-50" : ""}`}
                  >
                    <RadioGroupItem
                      id={`${id}-mode-${option.value}`}
                      value={option.value}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1 leading-snug">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate">{option.title}</span>
                      </span>
                      <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                        {option.subtitle}
                      </span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
            <p id={`${id}-target-mode-hint`} className="text-xs leading-relaxed text-muted-foreground">
              {modeHint}
            </p>

            {/* Mode 1 Panel: Registered Baseware Machine Pool Cards */}
            {mode === "machine" ? (
              <div className="grid max-h-52 gap-2 overflow-y-auto rounded-lg border bg-muted/15 p-2.5">
                {availableMachines.map(machine => {
                  const selected = (draft.machineId || availableMachines[0]?.id) === machine.id;
                  const isDesktop = machine.driver === "cua";
                  return (
                    <button
                      key={machine.id}
                      type="button"
                      data-machine-card={machine.id}
                      aria-pressed={selected}
                      onClick={() => {
                        setIssue(null);
                        setDraft(prev => ({
                          ...prev,
                          machineId: machine.id,
                          driverId: machine.driver,
                          driverPackage: machine.driverPackage ?? "",
                        }));
                      }}
                      className={`flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selected
                          ? "border-[var(--gold)] bg-[var(--surface-inset)]"
                          : "border-border/70 bg-background/60 hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded border bg-background text-muted-foreground">
                          {isDesktop ? (
                            <MonitorIcon className="size-3.5" aria-hidden="true" />
                          ) : (
                            <CpuIcon className="size-3.5 text-[var(--gold)]" aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground">{machine.name}</span>
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {machine.driver}
                            </Badge>
                            {machine.builtin ? (
                              <Badge variant="secondary" className="text-[10px]">
                                {t("machineBuiltinBadge")}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {formatMachineTransportSummary(machine)}
                          </p>
                          {machine.description ? (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              {machine.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {machine.usedByWorkspaceIds.length > 0 ? (
                          <span className="hidden text-[11px] text-muted-foreground sm:inline">
                            {t("machineUsedCount").replace("{count}", String(machine.usedByWorkspaceIds.length))}
                          </span>
                        ) : null}
                        <span
                          aria-hidden="true"
                          className={`grid size-4 place-items-center rounded-full border ${
                            selected
                              ? "border-[var(--gold)] bg-[var(--gold)] text-background"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {selected ? <CheckIcon className="size-2.5 stroke-[3]" /> : null}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* Mode 2 Panel: Installed / Cached Driver Catalog + Inline ROM & Port */}
            {mode === "driver" ? (
              <div className="grid gap-3 rounded-lg border bg-muted/15 p-3">
                <div className="grid max-h-44 gap-2 overflow-y-auto">
                  {availableDrivers.map(drv => {
                    const selected = (selectedCatalogDriver?.key ?? BUILTIN_CUA_DRIVER_SPEC) === drv.key;
                    const badgeLabel =
                      drv.registrationStatus === "builtin"
                        ? t("driverBuiltinBadge")
                        : drv.registrationStatus === "registered"
                          ? t("driverRegisteredBadge")
                          : t("driverCachedBadge");
                    return (
                      <button
                        key={drv.key}
                        type="button"
                        data-driver-card={drv.id}
                        aria-pressed={selected}
                        onClick={() => {
                          setSelectedDriverKey(drv.key);
                          setIssue(null);
                          const isCua = drv.spec === BUILTIN_CUA_DRIVER_SPEC;
                          setDraft(prev => ({
                            ...prev,
                            environment: isCua ? "desktop" : "community",
                            driverId: drv.id,
                            driverPackage: isCua ? "" : drv.spec,
                            game: "",
                            port: undefined,
                          }));
                        }}
                        className={`flex w-full items-start justify-between gap-3 rounded-md border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected
                            ? "border-[var(--gold)] bg-[var(--surface-inset)]"
                            : "border-border/70 bg-background/60 hover:bg-muted/40"
                        }`}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground">
                              {drv.name || drv.id}
                            </span>
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {drv.id}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px]">
                              {badgeLabel}
                            </Badge>
                            {drv.version && drv.version !== "builtin" ? (
                              <span className="font-mono text-[11px] text-muted-foreground">
                                v{drv.version}
                              </span>
                            ) : null}
                          </div>
                          {drv.description ? (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              {drv.description}
                            </p>
                          ) : drv.spec !== BUILTIN_CUA_DRIVER_SPEC ? (
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {drv.spec}
                            </p>
                          ) : null}
                        </div>
                        <span
                          aria-hidden="true"
                          className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
                            selected
                              ? "border-[var(--gold)] bg-[var(--gold)] text-background"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {selected ? <CheckIcon className="size-2.5 stroke-[3]" /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {probingCatalogDriver ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                    <PixelMark loading size={14} />
                    {t("probingDriver")}
                  </p>
                ) : null}

                {(activeDiscoveredForCaps?.launchHint || selectedCatalogDriver?.launchHint) ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {activeDiscoveredForCaps?.launchHint ?? selectedCatalogDriver?.launchHint}
                  </p>
                ) : null}

                {!capabilities.stdio ? (
                  <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
                    {capabilities.supportsGame ? (
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor={`${id}-driver-game`} className="text-xs">
                          {t("gamePath")}
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id={`${id}-driver-game`}
                            name="game"
                            value={draft.game}
                            maxLength={2000}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            placeholder={t("gamePlaceholder")}
                            onChange={event => changeField("game", event.target.value)}
                          />
                          {nativePicker.supported ? (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={nativePicker.picking}
                              onClick={() => void handleBrowseGameFile()}
                            >
                              <FolderOpenIcon className="size-4" aria-hidden="true" />
                              {t("browseFile")}
                            </Button>
                          ) : null}
                        </div>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {t("gameHint")}
                        </p>
                      </div>
                    ) : null}

                    <div className={`grid gap-1.5 ${capabilities.supportsGame ? "" : "sm:col-span-3"}`}>
                      <Label htmlFor={`${id}-driver-port`} className="text-xs">
                        {t("bridgePortLabel")}
                      </Label>
                      <Input
                        id={`${id}-driver-port`}
                        name="port"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        value={draft.port ?? ""}
                        placeholder={
                          capabilities.defaultPort !== undefined
                            ? t("bridgePortPlaceholder").replace("{port}", String(capabilities.defaultPort))
                            : t("bridgePortRequiredPlaceholder")
                        }
                        aria-invalid={issue?.field === "port"}
                        aria-describedby={issue?.field === "port" ? `${id}-port-error` : undefined}
                        onChange={event => changeField("port", event.target.value)}
                      />
                      {issue?.field === "port" ? (
                        <p id={`${id}-port-error`} role="alert" className="text-xs text-destructive">
                          {t(issue.message)}
                        </p>
                      ) : (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {t("bridgePortHint")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Mode 3 Panel: Import New Driver Package */}
            {mode === "package" ? (
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3.5">
                <Label htmlFor={`${id}-package`}>{t("packageAddress")}</Label>
                <div className="flex flex-col gap-2 min-[480px]:flex-row">
                  <Input
                    id={`${id}-package`}
                    name="driverPackage"
                    value={draft.driverPackage}
                    required
                    maxLength={500}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={t("packagePlaceholder")}
                    aria-invalid={!!discoveryError || issue?.field === "driverPackage"}
                    aria-describedby={`${id}-package-hint${
                      discoveryError || issue?.field === "driverPackage" ? ` ${id}-package-error` : ""
                    }`}
                    onChange={event => {
                      const driverPackage = event.target.value;
                      resetDiscovery();
                      setDraft(prev => ({
                        ...prev,
                        driverPackage,
                        game: "",
                        port: undefined,
                        cuaCommand: "",
                      }));
                    }}
                  />
                  {nativePicker.supported ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending || discovering || nativePicker.picking}
                      onClick={() => void handleBrowseLocalPackage()}
                    >
                      <FolderOpenIcon className="size-4" aria-hidden="true" />
                      {t("browsePackageDir")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    aria-disabled={pending || discovering || !draft.driverPackage.trim()}
                    className="aria-disabled:opacity-50"
                    onClick={() => void discoverSpecNow()}
                  >
                    {discovering ? <PixelMark loading size={16} /> : null}
                    {t(discovering ? "verifying" : "verifyPackage")}
                  </Button>
                </div>
                <p id={`${id}-package-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {t("packageHint")}
                </p>
                {discoveryError || issue?.field === "driverPackage" ? (
                  <p
                    id={`${id}-package-error`}
                    role="alert"
                    className="break-words text-xs text-destructive"
                  >
                    {discoveryError || (issue ? t(issue.message) : "")}
                  </p>
                ) : null}

                {packageVerified && driver ? (
                  <div className="grid gap-3 border-t pt-3" role="status">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <CheckIcon className="size-4 text-success" aria-hidden="true" />
                      <span>{t("driverVerified")}</span>
                      <Badge variant="outline">{driver.id}</Badge>
                      <span className="text-xs text-muted-foreground">{driver.version}</span>
                    </div>
                    {driver.launchHint ? (
                      <p className="break-words text-xs leading-relaxed text-muted-foreground">
                        {driver.launchHint}
                      </p>
                    ) : null}

                    {!capabilities.stdio ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        {capabilities.supportsGame ? (
                          <div className="grid gap-1.5 sm:col-span-2">
                            <Label htmlFor={`${id}-pkg-game`} className="text-xs">
                              {t("gamePath")}
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                id={`${id}-pkg-game`}
                                name="game"
                                value={draft.game}
                                maxLength={2000}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder={t("gamePlaceholder")}
                                onChange={event => changeField("game", event.target.value)}
                              />
                              {nativePicker.supported ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={nativePicker.picking}
                                  onClick={() => void handleBrowseGameFile()}
                                >
                                  <FolderOpenIcon className="size-4" aria-hidden="true" />
                                  {t("browseFile")}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        <div className={`grid gap-1.5 ${capabilities.supportsGame ? "" : "sm:col-span-3"}`}>
                          <Label htmlFor={`${id}-pkg-port`} className="text-xs">
                            {t("bridgePortLabel")}
                          </Label>
                          <Input
                            id={`${id}-pkg-port`}
                            name="port"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            value={draft.port ?? ""}
                            placeholder={
                              capabilities.defaultPort !== undefined
                                ? t("bridgePortPlaceholder").replace("{port}", String(capabilities.defaultPort))
                                : t("bridgePortRequiredPlaceholder")
                            }
                            aria-invalid={issue?.field === "port"}
                            onChange={event => changeField("port", event.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="flex items-center gap-2 pt-0.5">
                      <input
                        id={`${id}-register-driver`}
                        type="checkbox"
                        checked={draft.registerDriver ?? true}
                        onChange={event =>
                          setDraft(prev => ({ ...prev, registerDriver: event.target.checked }))
                        }
                        className="size-4 rounded border-border accent-[var(--gold)]"
                      />
                      <Label
                        htmlFor={`${id}-register-driver`}
                        className="cursor-pointer text-xs font-normal text-foreground"
                      >
                        {t("registerDriverCheckbox")}
                      </Label>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("verifyFirstHint")}</p>
                )}
              </div>
            ) : null}
          </div>

          {/* 3. Model & Readiness Summary Row */}
          <div className="grid gap-2">
            <Label>{t("modelSectionLabel")}</Label>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3.5 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <SparklesIcon className="size-4 shrink-0 text-[var(--gold)]" aria-hidden="true" />
                <span className="truncate font-mono text-xs font-medium text-foreground">
                  {shortModelLabel(activeModel, activeModel)}
                </span>
                {draft.effort ? (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {draft.effort}
                  </Badge>
                ) : null}
                {draft.serviceTier ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {draft.serviceTier}
                  </Badge>
                ) : null}
                {modelAuthState === true ? (
                  <Badge
                    variant="outline"
                    className="border-success/30 bg-success/10 text-[10px] text-success"
                  >
                    <CheckIcon className="mr-0.5 size-2.5" aria-hidden="true" />
                    {t("modelAuthReady")}
                  </Badge>
                ) : modelAuthState === false ? (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {t("modelAuthMissing")}
                  </Badge>
                ) : null}
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => setModelPickerOpen(true)}
              >
                {t("changeModel")}
              </Button>
            </div>
          </div>

          {/* 4. Optional stdio command override (only shown for non-machine stdio targets) */}
          {mode !== "machine" && capabilities.stdio ? (
            <details
              open={advanced}
              onToggle={event => setAdvanced(event.currentTarget.open)}
              className="settings-disclosure group min-w-0 rounded-lg border"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-2.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon
                  className="size-3.5 shrink-0 transition-transform duration-200 ease-[var(--ease-out-expo)] motion-reduce:transition-none group-open:rotate-90"
                  aria-hidden="true"
                />
                {t("advanced")}
              </summary>
              <div className="grid gap-2 border-t p-3.5">
                <Label htmlFor={`${id}-command`} className="text-xs">
                  {t("executable")}
                </Label>
                <Input
                  id={`${id}-command`}
                  name="cuaCommand"
                  value={draft.cuaCommand}
                  maxLength={2000}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="cua-driver"
                  aria-describedby={`${id}-command-hint`}
                  onChange={event => changeField("cuaCommand", event.target.value)}
                />
                <p id={`${id}-command-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {t("executableHint")}
                </p>
              </div>
            </details>
          ) : null}
        </fieldset>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3 border-t bg-card px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <p
            className="text-xs leading-relaxed text-muted-foreground"
            role={pending ? "status" : undefined}
          >
            {statusText}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                const active = request.current;
                request.current = null;
                active?.abort();
                onCancel();
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitDisabled}
              onClick={() => {
                submitModeRef.current = "create-only";
                executeSubmit(false);
              }}
            >
              {pending && submitModeRef.current === "create-only" ? (
                <PixelMark loading size={16} />
              ) : null}
              {t("createOnly")}
            </Button>
            <Button
              type="submit"
              disabled={submitDisabled}
              onClick={() => {
                submitModeRef.current = "create-and-launch";
              }}
            >
              {pending && submitModeRef.current === "create-and-launch" ? (
                <PixelMark loading size={16} />
              ) : (
                <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
              )}
              {t(
                pending && submitModeRef.current === "create-and-launch"
                  ? pendingStep === "launching"
                    ? "stepLaunching"
                    : "creating"
                  : "createAndLaunch",
              )}
            </Button>
          </div>
        </div>
      </form>

      <ModelPickerDialog
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        value={activeModel}
        serviceTier={draft.serviceTier ?? null}
        effort={draft.effort ?? null}
        allowUnauthenticated={true}
        catalogOverride={catalog.modelsCatalog ?? undefined}
        onSelect={(nextModel, nextServiceTier, nextEffort) => {
          modelManuallyChosenRef.current = true;
          setDraft(prev => ({
            ...prev,
            model: nextModel,
            serviceTier: nextServiceTier,
            effort: nextEffort,
          }));
        }}
      />
    </>
  );
}
