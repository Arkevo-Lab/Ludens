"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Cable,
  CheckCircle2,
  Cpu,
  Eye,
  FlaskConical,
  HardDrive,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Square,
} from "lucide-react";
import type { Project } from "@/lib/types";
import type {
  WorkspaceConfigSummary,
  WorkspaceShioriSnapshot,
  WorkspaceStudioSnapshot,
} from "@/lib/workspaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  AdvancedDiagnosticsDisclosure,
  InlineCopyButton,
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
  SettingsWorkspaceLayout,
  SingleLineTruncate,
  type SettingsCategoryItem,
} from "@/components/ui/settings-primitives";
import { Switch } from "@/components/ui/switch";
import {
  ModelEffortBadge,
  ModelPickerDialog,
  ServiceTierBadge,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
import { useLocale, useTranslations } from "@/lib/locale";
import { useWorkspaceService } from "@/lib/use-workspace-service";
import { PerceptionSettingsPanel } from "@/features/capabilities/perception-settings";
import { ConnectionSettings } from "@/features/workspaces/connection-settings";
import {
  buildDisplayMachines,
  formatTransportSummary,
  type DisplayMachineItem,
} from "@/features/baseware/baseware-model";
import { useBasewareOverview } from "@/features/baseware/use-baseware-overview";
import { LoopLab } from "@/shell/loop-lab";

export type StudioTab = "device" | "model" | "connection" | "perception" | "services" | "simulator";
const STUDIO_TABS: readonly StudioTab[] = ["device", "model", "connection", "perception", "services", "simulator"];

const MODEL_PRESETS: Array<{ id: string; label: string; badgeEn: string; badgeZh: string }> = [
  {
    id: "openai-codex/gpt-6.1-sol",
    label: "openai-codex/gpt-6.1-sol",
    badgeEn: "Stateful WS Delta (Recommended)",
    badgeZh: "有状态 WS 增量（默认推荐）",
  },
  {
    id: "openai/gpt-6.1-sol",
    label: "openai/gpt-6.1-sol",
    badgeEn: "OpenAI Responses",
    badgeZh: "OpenAI Responses",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    label: "anthropic/claude-sonnet-4-6",
    badgeEn: "Anthropic Prefix Cache",
    badgeZh: "Anthropic 前缀缓存",
  },
  {
    id: "opencode-go/deepseek-v4.1-flash",
    label: "opencode-go/deepseek-v4.1-flash",
    badgeEn: "Stateless HTTP (Pair with low compaction + uguu)",
    badgeZh: "无状态 HTTP（建议配低压缩阈值 + uguu 图床）",
  },
];

const COMPACTION_PRESETS: Array<{ tokens: number | null; labelEn: string; labelZh: string; hintEn: string; hintZh: string }> = [
  {
    tokens: null,
    labelEn: "Model Default (Unset)",
    labelZh: "跟随模型默认（不设覆盖）",
    hintEn: "Uses the model's native contextWindow - reserve",
    hintZh: "使用模型原生 contextWindow - reserve（适合有状态 WS）",
  },
  {
    tokens: 24000,
    labelEn: "24,000 tokens (~12–15 screenshots)",
    labelZh: "24,000 tokens（约 12–15 张截图）",
    hintEn: "Best for slow stateless HTTP vision gateways",
    hintZh: "极速档：适合每次重解码历史图片的无状态 HTTP 网关",
  },
  {
    tokens: 48000,
    labelEn: "48,000 tokens (~25–30 screenshots)",
    labelZh: "48,000 tokens（约 25–30 张截图）",
    hintEn: "Balanced horizon for HTTP SSE endpoints",
    hintZh: "均衡档：兼顾短期视觉记忆与无状态 HTTP 响应速度",
  },
  {
    tokens: 96000,
    labelEn: "96,000 tokens (~50+ screenshots)",
    labelZh: "96,000 tokens（约 50+ 张截图）",
    hintEn: "Long horizon for WebSocket delta or fast KV cache",
    hintZh: "长周期档：适合支持 WebSocket 增量的模型",
  },
];

function quoteShellPath(workspace: string): string {
  return `'${workspace.replace(/'/g, "'\\''")}'`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface ActiveDeviceSummary {
  name: string;
  online: boolean;
}

export function WorkspaceStudioView({
  project,
  projects,
  ready,
  catalogError,
  catalogLoading,
  onRetryCatalog,
  initialTab,
  navigate,
}: {
  project: string;
  projects: Project[];
  ready: boolean;
  catalogError?: string;
  catalogLoading?: boolean;
  onRetryCatalog(): void;
  initialTab?: string | null;
  navigate: (patch: Record<string, string | null>) => void;
}) {
  const t = useTranslations("workspaceStudio");
  const { locale } = useLocale();
  const isZh = locale === "zh";
  const resolvedTab: StudioTab =
    initialTab && (STUDIO_TABS as readonly string[]).includes(initialTab)
      ? (initialTab as StudioTab)
      : "device";
  const [tab, setTab] = useState<StudioTab>(resolvedTab);

  useEffect(() => {
    if (initialTab && (STUDIO_TABS as readonly string[]).includes(initialTab)) {
      setTab(initialTab as StudioTab);
    } else if (!initialTab) {
      setTab("device");
    }
  }, [initialTab]);

  const target = projects.find(item => item.id === project);
  const [studio, setStudio] = useState<WorkspaceStudioSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const requestVersion = useRef(0);

  const baseware = useBasewareOverview({
    project: target?.id ?? "",
    workspace: target?.workspace ?? null,
    ready: ready && Boolean(target?.id),
    loadFailedMessage: t("loadFailed"),
    capabilitiesFailedMessage: t("loadFailed"),
  });
  const reloadBaseware = baseware.reloadAll;

  const refreshStudio = useCallback(() => {
    setReloadTick(value => value + 1);
    if (target?.id) {
      void reloadBaseware();
    }
  }, [reloadBaseware, target?.id]);

  useEffect(() => {
    if (!target?.id) {
      setStudio(null);
      return;
    }
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setLoading(true);
    setReadError(null);
    void fetch(`/api/workspaces?studio=${encodeURIComponent(target.id)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error ?? t("loadFailed"));
        return value as WorkspaceStudioSnapshot;
      })
      .then(snapshot => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setStudio(snapshot);
      })
      .catch(error => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setReadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && version === requestVersion.current) setLoading(false);
      });
    return () => controller.abort();
  }, [target?.id, reloadTick, t]);

  const onTabChange = (next: string) => {
    const valid = (STUDIO_TABS as readonly string[]).includes(next) ? (next as StudioTab) : "device";
    setTab(valid);
    navigate({ studioTab: valid === "device" ? null : valid });
  };

  const hostJob = studio?.services.jobs.find(item => item.name === "host");
  const basewareJob = studio?.services.jobs.find(item => item.name === "baseware");
  const workspaceRunning = Boolean(hostJob?.pid || basewareJob?.pid);

  const service = useWorkspaceService({
    workspaceId: target?.id,
    fallbackError: t("operationFailed"),
    onStudioSnapshot: next => setStudio(next),
    onSuccess: () => {
      onRetryCatalog();
      if (target?.id) void reloadBaseware();
    },
  });

  const displayMachines = useMemo(() => buildDisplayMachines(baseware.snapshot), [baseware.snapshot]);
  const primaryMachine = useMemo(
    () => displayMachines.find(item => item.workspaceAdditionStatus === "primary") ?? null,
    [displayMachines],
  );
  const activeDeviceSummary: ActiveDeviceSummary | null = useMemo(() => {
    if (primaryMachine) {
      return {
        name: primaryMachine.name || primaryMachine.id,
        online: primaryMachine.isMounted,
      };
    }
    if (baseware.snapshot?.activeMachine) {
      return {
        name: baseware.snapshot.activeMachine.name || baseware.snapshot.activeMachine.id,
        online: false,
      };
    }
    if (studio?.config?.driver) {
      return {
        name: studio.config.driver,
        online: workspaceRunning,
      };
    }
    return null;
  }, [baseware.snapshot?.activeMachine, primaryMachine, studio?.config?.driver, workspaceRunning]);

  const workspaceDisplayName = target?.name?.trim() || studio?.name?.trim() || target?.id || t("title");

  const categories: SettingsCategoryItem[] = useMemo(
    () => [
      { id: "device", label: t("tabs.device"), icon: <Monitor className="size-4" aria-hidden="true" /> },
      { id: "model", label: t("tabs.model"), icon: <Bot className="size-4" aria-hidden="true" /> },
      { id: "connection", label: t("tabs.connection"), icon: <Cable className="size-4" aria-hidden="true" /> },
      { id: "perception", label: t("tabs.perception"), icon: <Eye className="size-4" aria-hidden="true" /> },
      {
        id: "services",
        label: t("tabs.services"),
        icon: <Server className="size-4" aria-hidden="true" />,
        badge: studio?.shiori.sessions.length ? (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {studio.shiori.sessions.length}
          </Badge>
        ) : undefined,
      },
      { id: "simulator", label: t("tabs.simulator"), icon: <FlaskConical className="size-4" aria-hidden="true" /> },
    ],
    [studio?.shiori.sessions.length, t],
  );

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-5" aria-label={t("title")}>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-lg font-semibold tracking-tight">{workspaceDisplayName}</h1>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={
                  "size-2 rounded-full " +
                  (!target ? "bg-muted-foreground/45" : workspaceRunning ? "bg-emerald-500" : "bg-muted-foreground/50")
                }
                aria-hidden="true"
              />
              <span>
                {!target
                  ? t("runtimeBanner.noWorkspace")
                  : workspaceRunning
                    ? t("runtimeBanner.running")
                    : t("runtimeBanner.stopped")}
              </span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studio && target && (
            !workspaceRunning ? (
              <Button
                type="button"
                size="sm"
                disabled={service.busy}
                onClick={() => void service.startWorkspace()}
                data-studio-header-service="up"
              >
                {service.pendingOperation === "up" ? (
                  <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="size-3.5 fill-current" aria-hidden="true" />
                )}
                {t(service.pendingOperation === "up" ? "startingWorkspace" : "startWorkspace")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={service.busy}
                  onClick={() => void service.reloadWorkspace()}
                  data-studio-header-service="reload"
                >
                  {service.pendingOperation === "reload" ? (
                    <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                  )}
                  {t(service.pendingOperation === "reload" ? "reloadingWorkspace" : "reloadWorkspace")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={service.busy}
                  onClick={() => void service.stopWorkspace()}
                  data-studio-header-service="down"
                >
                  {service.pendingOperation === "down" ? (
                    <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Square className="size-3 fill-current" aria-hidden="true" />
                  )}
                  {t(service.pendingOperation === "down" ? "stoppingWorkspace" : "stopWorkspace")}
                </Button>
              </>
            )
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || !target}
            onClick={refreshStudio}
          >
            <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} aria-hidden="true" />
            {t(loading ? "refreshing" : "refresh")}
          </Button>
        </div>
      </header>

      {service.error && tab !== "services" && (
        <Alert variant="destructive">
          <AlertTitle>{t("operationFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span className="break-words font-mono text-xs">{service.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => navigate({ view: "baseware", project: target?.id ?? null })}
              >
                <HardDrive className="size-3" aria-hidden="true" />
                {t("servicesSection.manageBaseware")}
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={service.clearError}>
                ×
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {readError && (
        <Alert variant="destructive">
          <AlertTitle>{t("loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span className="break-all text-xs">{readError}</span>
            <Button type="button" size="sm" variant="outline" onClick={refreshStudio}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <SettingsWorkspaceLayout
        navLabel={t("title")}
        categories={categories}
        activeCategory={tab}
        onCategoryChange={onTabChange}
        wide={tab === "simulator"}
      >
        {tab === "device" && (
          !target ? (
            <p role="status" className="py-8 text-sm text-muted-foreground">
              {ready ? t("selectWorkspace") : t("loading")}
            </p>
          ) : (
            <WorkspaceTargetDevicePanel
              target={target}
              studio={studio}
              displayMachines={displayMachines}
              snapshot={baseware.snapshot}
              loading={baseware.loading}
              loadError={baseware.loadError}
              actionError={baseware.actionError}
              busyMachineId={baseware.busyMachineId}
              probeStates={baseware.probeStates}
              onRefresh={() => void baseware.reloadAll()}
              onUseDevice={machineId => void baseware.controlWorkspaceMachine("setPrimary", machineId)}
              onProbe={machine => void baseware.probeMachine(machine)}
              onManageInBaseware={() => navigate({ view: "baseware", project: target.id })}
              onOpenModel={() => onTabChange("model")}
            />
          )
        )}

        {tab === "model" && (
          !target ? (
            <p role="status" className="py-8 text-sm text-muted-foreground">
              {ready ? t("selectWorkspace") : t("loading")}
            </p>
          ) : !studio ? (
            <p role="status" className="py-8 text-sm text-muted-foreground">
              {loading ? t("loading") : t("loadFailed")}
            </p>
          ) : (
            <ModelAndBudgetPanel
              studio={studio}
              isZh={isZh}
              workspaceRunning={workspaceRunning}
              activeDeviceSummary={activeDeviceSummary}
              onSaved={next => setStudio(next)}
              onOpenDevice={() => onTabChange("device")}
              onOpenSimulator={() => onTabChange("simulator")}
              onOpenConnection={() => onTabChange("connection")}
            />
          )
        )}

        {tab === "connection" && (
          <ConnectionSettings
            key={target?.id ?? "global"}
            projects={projects}
            initialScope={target?.id ?? "global"}
            onSaved={refreshStudio}
          />
        )}

        {tab === "perception" && (
          <PerceptionSettingsPanel
            project={project}
            projects={projects}
            ready={ready}
            catalogError={catalogError}
            catalogLoading={catalogLoading}
            onRetryCatalog={onRetryCatalog}
          />
        )}

        {tab === "services" && (
          !studio ? (
            <p role="status" className="py-8 text-sm text-muted-foreground">
              {loading ? t("loading") : t("selectWorkspace")}
            </p>
          ) : (
            <ServicesAndShioriPanel
              studio={studio}
              isZh={isZh}
              onRefresh={refreshStudio}
              onOpenBaseware={() => navigate({ view: "baseware", project: target?.id ?? null })}
              onStudioUpdated={next => setStudio(next)}
              onShioriUpdated={shiori =>
                setStudio(current => (current ? { ...current, shiori } : current))
              }
            />
          )
        )}

        {tab === "simulator" && <LoopLab navigate={navigate} />}
      </SettingsWorkspaceLayout>
    </section>
  );
}

function WorkspaceTargetDevicePanel({
  studio,
  displayMachines,
  snapshot,
  loading,
  loadError,
  actionError,
  busyMachineId,
  probeStates,
  onRefresh,
  onUseDevice,
  onProbe,
  onManageInBaseware,
  onOpenModel,
}: {
  target: Project;
  studio: WorkspaceStudioSnapshot | null;
  displayMachines: DisplayMachineItem[];
  snapshot: ReturnType<typeof useBasewareOverview>["snapshot"];
  loading: boolean;
  loadError: string;
  actionError: string;
  busyMachineId: string | null;
  probeStates: ReturnType<typeof useBasewareOverview>["probeStates"];
  onRefresh(): void;
  onUseDevice(machineId: string): void;
  onProbe(machine: DisplayMachineItem): void;
  onManageInBaseware(): void;
  onOpenModel(): void;
}) {
  const t = useTranslations("workspaceStudio");
  const activeMachine = snapshot?.activeMachine ?? null;
  const activeDriver = activeMachine?.driver ?? studio?.config?.driver ?? null;
  const showDriverLaunch = Boolean(activeDriver && activeDriver !== "cua");
  const bridgeTransport = activeMachine?.transport.kind === "bridge" ? activeMachine.transport : null;
  const launchPort = bridgeTransport?.port ?? studio?.config?.port;
  const launchGame = bridgeTransport?.game ?? studio?.config?.game;

  return (
    <div className="grid min-w-0 gap-6">
      {(loadError || actionError) && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{actionError || loadError}</AlertDescription>
        </Alert>
      )}

      <SettingsSection
        title={t("deviceSection.title")}
        description={t("deviceSection.description")}
        actions={
          <>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
              <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} aria-hidden="true" />
              {t(loading ? "refreshing" : "refresh")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onManageInBaseware}>
              <HardDrive className="size-3.5" aria-hidden="true" />
              {t("deviceSection.manageInBaseware")}
            </Button>
          </>
        }
      >
        {loading && displayMachines.length === 0 ? (
          <p role="status" className="py-5 text-sm text-muted-foreground">{t("loading")}</p>
        ) : displayMachines.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">{t("deviceSection.noDevices")}</p>
        ) : (
          displayMachines.map(machine => {
            const isPrimary = machine.workspaceAdditionStatus === "primary";
            const probeState = probeStates[machine.id];
            const probing = probeState === "probing";
            const probeOutcome = probeState && probeState !== "probing" ? probeState : null;
            const humanName = machine.name || machine.id;
            const transportLine = `${machine.driver} · ${machine.transport.kind.toUpperCase()} · ${formatTransportSummary(machine.transport)}`;

            return (
              <SettingsRow
                key={machine.id}
                label={humanName}
                badge={
                  <>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={
                          "size-2 rounded-full " +
                          (machine.isMounted ? "bg-emerald-500" : "bg-muted-foreground/45")
                        }
                        aria-hidden="true"
                      />
                      <span>{t(machine.isMounted ? "deviceSection.online" : "deviceSection.standby")}</span>
                    </span>
                    {machine.isImplicit && (
                      <Badge variant="outline" className="text-[11px]">
                        {t("deviceSection.workspaceDirectTag")}
                      </Badge>
                    )}
                  </>
                }
                description={
                  <span className="flex flex-col gap-0.5">
                    <SingleLineTruncate mono text={transportLine} />
                    {probeOutcome && (
                      <span className={probeOutcome.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                        {probeOutcome.latencyMs}ms · {probeOutcome.detail}
                      </span>
                    )}
                  </span>
                }
                control={
                  <div className="flex flex-wrap items-center gap-2">
                    {isPrimary ? (
                      <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                        {t("deviceSection.currentDevice")}
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={busyMachineId !== null}
                        onClick={() => onUseDevice(machine.id)}
                      >
                        {t("deviceSection.useDevice")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={probing}
                      onClick={() => onProbe(machine)}
                    >
                      <Activity className="size-3.5" aria-hidden="true" />
                      {t(probing ? "deviceSection.probingBtn" : "deviceSection.probeBtn")}
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      {showDriverLaunch && (
        <SettingsSection
          headingLevel={3}
          title={t("deviceSection.driverLaunchTitle")}
          actions={
            studio?.config ? (
              <Button type="button" size="sm" variant="outline" onClick={onOpenModel}>
                {t("tabs.model")}
              </Button>
            ) : undefined
          }
        >
          <SettingsRow
            label={activeDriver ?? ""}
            control={
              <span className="font-mono text-xs text-muted-foreground">
                {launchPort !== undefined ? `${t("modelSection.portLabel")}: ${launchPort}` : "—"}
              </span>
            }
          />
          {launchGame && (
            <SettingsRow
              label={t("modelSection.gameLabel")}
              control={<SingleLineTruncate mono text={launchGame} className="max-w-sm text-xs text-muted-foreground" />}
            />
          )}
        </SettingsSection>
      )}
    </div>
  );
}

export function ModelAndBudgetPanel({
  studio,
  isZh,
  workspaceRunning,
  activeDeviceSummary,
  onSaved,
  onOpenDevice,
  onOpenSimulator,
  onOpenConnection,
}: {
  studio: WorkspaceStudioSnapshot;
  isZh: boolean;
  workspaceRunning?: boolean;
  activeDeviceSummary?: ActiveDeviceSummary | null;
  onSaved(snapshot: WorkspaceStudioSnapshot): void;
  onOpenDevice?: () => void;
  onOpenSimulator(): void;
  onOpenConnection(): void;
}) {
  const t = useTranslations("workspaceStudio");
  const service = useWorkspaceService({
    workspaceId: studio.id,
    fallbackError: t("operationFailed"),
    onStudioSnapshot: next => onSaved(next),
  });
  const modelInputId = useId();
  const secondsInputId = useId();
  const requestsInputId = useId();
  const compactionInputId = useId();
  const diagnosticsId = useId();
  const portInputId = useId();
  const gameInputId = useId();

  const initial: WorkspaceConfigSummary = studio.config ?? {
    driver: "cua",
    model: studio.defaults.model ?? "openai-codex/gpt-6.1-sol",
    serviceTier: studio.defaults.serviceTier,
    effort: studio.defaults.effort,
    seconds: studio.defaults.seconds ?? 1800,
    requests: studio.defaults.requests ?? 1000,
    compactionThreshold: studio.defaults.compactionThreshold,
    dashboard: studio.defaults.dashboard ?? true,
    pet: studio.defaults.pet ?? false,
    diagnostics: "normal",
  };

  const [model, setModel] = useState(initial.model);
  const [serviceTier, setServiceTier] = useState<ModelServiceTier | null>(initial.serviceTier ?? null);
  const [effort, setEffort] = useState<ModelEffort | null>(initial.effort ?? null);
  const [seconds, setSeconds] = useState(String(initial.seconds));
  const [requests, setRequests] = useState(String(initial.requests));
  const [compaction, setCompaction] = useState(
    initial.compactionThreshold !== undefined ? String(initial.compactionThreshold) : "",
  );
  const [diagnostics, setDiagnostics] = useState<"normal" | "full">(initial.diagnostics);
  const [pet, setPet] = useState(initial.pet);
  const [dashboard, setDashboard] = useState(initial.dashboard);
  const [port, setPort] = useState(initial.port !== undefined ? String(initial.port) : "");
  const [game, setGame] = useState(initial.game ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  useEffect(() => {
    const cfg = studio.config;
    if (!cfg) return;
    setModel(cfg.model);
    setServiceTier(cfg.serviceTier ?? null);
    setEffort(cfg.effort ?? null);
    setSeconds(String(cfg.seconds));
    setRequests(String(cfg.requests));
    setCompaction(cfg.compactionThreshold !== undefined ? String(cfg.compactionThreshold) : "");
    setDiagnostics(cfg.diagnostics);
    setPet(cfg.pet);
    setDashboard(cfg.dashboard);
    setPort(cfg.port !== undefined ? String(cfg.port) : "");
    setGame(cfg.game ?? "");
  }, [studio.config]);

  const parsedSeconds = Number(seconds.trim());
  const parsedRequests = Number(requests.trim());
  const parsedCompaction = compaction.trim() === "" ? null : Number(compaction.trim());
  const parsedPort = port.trim() === "" ? null : Number(port.trim());

  const dirty =
    model.trim() !== initial.model ||
    serviceTier !== (initial.serviceTier ?? null) ||
    effort !== (initial.effort ?? null) ||
    seconds.trim() !== String(initial.seconds) ||
    requests.trim() !== String(initial.requests) ||
    (compaction.trim() === "" ? undefined : Number(compaction.trim())) !== initial.compactionThreshold ||
    diagnostics !== initial.diagnostics ||
    pet !== initial.pet ||
    dashboard !== initial.dashboard ||
    (port.trim() === "" ? undefined : Number(port.trim())) !== initial.port ||
    game.trim() !== (initial.game ?? "");

  const resetDraft = () => {
    setModel(initial.model);
    setServiceTier(initial.serviceTier ?? null);
    setEffort(initial.effort ?? null);
    setSeconds(String(initial.seconds));
    setRequests(String(initial.requests));
    setCompaction(initial.compactionThreshold !== undefined ? String(initial.compactionThreshold) : "");
    setDiagnostics(initial.diagnostics);
    setPet(initial.pet);
    setDashboard(initial.dashboard);
    setPort(initial.port !== undefined ? String(initial.port) : "");
    setGame(initial.game ?? "");
    setSaveError(null);
    setSavedNotice(false);
  };

  const saveConfig = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "workspaceStudioConfig",
          id: studio.id,
          patch: {
            model: model.trim(),
            serviceTier,
            effort,
            seconds: parsedSeconds,
            requests: parsedRequests,
            compactionThreshold: parsedCompaction,
            diagnostics,
            pet,
            dashboard,
            ...(initial.driver !== "cua" ? { port: parsedPort, game: game.trim() || null } : {}),
          },
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? t("saveFailed"));
      onSaved(value as WorkspaceStudioSnapshot);
      setSavedNotice(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const isWorkspaceRunning =
    workspaceRunning ??
    Boolean(studio.services.jobs.some(item => (item.name === "host" || item.name === "baseware") && item.pid));

  const deviceName = activeDeviceSummary?.name ?? initial.driver;
  const deviceOnline = activeDeviceSummary?.online ?? isWorkspaceRunning;
  const reloadCmd = `ludens --workspace ${quoteShellPath(studio.workspace)} down --keep-emulator && ludens --workspace ${quoteShellPath(studio.workspace)} up`;

  return (
    <div className="grid min-w-0 gap-6">
      <SettingsSection
        title={t("modelSection.title")}
        description={t("modelSection.description")}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={onOpenConnection}>
            <Cable className="size-3.5" aria-hidden="true" />
            {t("modelSection.configureTransport")}
          </Button>
        }
      >
        <SettingsRow
          label={t("modelSection.activeDeviceLabel")}
          control={
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span
                  className={"size-2 rounded-full " + (deviceOnline ? "bg-emerald-500" : "bg-muted-foreground/45")}
                  aria-hidden="true"
                />
                <span>{deviceName}</span>
                <span className="text-muted-foreground">
                  ({t(deviceOnline ? "deviceSection.online" : "deviceSection.standby")})
                </span>
              </span>
              {onOpenDevice && (
                <Button type="button" variant="outline" size="xs" onClick={onOpenDevice}>
                  {t("modelSection.switchDeviceBtn")}
                </Button>
              )}
            </div>
          }
        />

        <SettingsRow
          stacked
          label={t("modelSection.modelLabel")}
          htmlFor={modelInputId}
          description={t("modelSection.modelHint")}
          control={
            <div className="flex w-full flex-col gap-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id={modelInputId}
                  value={model}
                  onChange={event => {
                    setModel(event.target.value);
                    setServiceTier(null);
                    setEffort(null);
                    setSavedNotice(false);
                  }}
                  placeholder="openai-codex/gpt-6.1-sol"
                  className="font-mono text-sm sm:flex-1"
                  spellCheck={false}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <ModelEffortBadge effort={effort} />
                  <ServiceTierBadge tier={serviceTier} showStandard={Boolean(model.trim())} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={saving}
                    data-browse-models="workspace-studio"
                    onClick={() => setModelPickerOpen(true)}
                  >
                    <Cpu className="size-3.5" aria-hidden="true" />
                    {t("modelSection.browseModels")}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {MODEL_PRESETS.map(preset => {
                  const active = model.trim() === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setModel(preset.id);
                        setServiceTier(null);
                        setEffort(null);
                        setSavedNotice(false);
                      }}
                      className={
                        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors " +
                        (active
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border/80 bg-[var(--surface-inset)] text-muted-foreground hover:text-foreground")
                      }
                    >
                      <span className="font-mono font-medium">{preset.label}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {isZh ? preset.badgeZh : preset.badgeEn}
                      </Badge>
                    </button>
                  );
                })}
              </div>

              <ModelPickerDialog
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
                value={model}
                serviceTier={serviceTier}
                effort={effort}
                projectId={studio.id}
                allowUnauthenticated={true}
                onSelect={(nextModel, nextServiceTier, nextEffort) => {
                  setModel(nextModel);
                  setServiceTier(nextServiceTier);
                  setEffort(nextEffort);
                  setSavedNotice(false);
                }}
              />
            </div>
          }
        />

        <SettingsRow
          className="items-start"
          label={t("modelSection.secondsLabel")}
          htmlFor={secondsInputId}
          description={t("modelSection.secondsHint")}
          control={
            <div className="flex flex-col items-end gap-2">
              <Input
                id={secondsInputId}
                type="number"
                min={1}
                step={60}
                value={seconds}
                onChange={event => {
                  setSeconds(event.target.value);
                  setSavedNotice(false);
                }}
                className="w-36 font-mono tabular-nums"
              />
              <div className="flex flex-wrap justify-end gap-1.5">
                {[900, 1800, 3600, 7200].map(preset => (
                  <Button
                    key={preset}
                    type="button"
                    size="xs"
                    variant={Number(seconds) === preset ? "secondary" : "outline"}
                    onClick={() => {
                      setSeconds(String(preset));
                      setSavedNotice(false);
                    }}
                  >
                    {preset / 60}m ({preset}s)
                  </Button>
                ))}
              </div>
            </div>
          }
        />

        <SettingsRow
          className="items-start"
          label={t("modelSection.requestsLabel")}
          htmlFor={requestsInputId}
          description={t("modelSection.requestsHint")}
          control={
            <div className="flex flex-col items-end gap-2">
              <Input
                id={requestsInputId}
                type="number"
                min={1}
                step={50}
                value={requests}
                onChange={event => {
                  setRequests(event.target.value);
                  setSavedNotice(false);
                }}
                className="w-36 font-mono tabular-nums"
              />
              <div className="flex flex-wrap justify-end gap-1.5">
                {[200, 500, 1000, 2000].map(preset => (
                  <Button
                    key={preset}
                    type="button"
                    size="xs"
                    variant={Number(requests) === preset ? "secondary" : "outline"}
                    onClick={() => {
                      setRequests(String(preset));
                      setSavedNotice(false);
                    }}
                  >
                    {preset} {t("modelSection.requestsUnit")}
                  </Button>
                ))}
              </div>
            </div>
          }
        />

        <SettingsRow
          stacked
          label={t("modelSection.compactionLabel")}
          htmlFor={compactionInputId}
          description={t("modelSection.compactionHint")}
          control={
            <div className="flex w-full flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Input
                  id={compactionInputId}
                  type="number"
                  min={1000}
                  step={4000}
                  value={compaction}
                  onChange={event => {
                    setCompaction(event.target.value);
                    setSavedNotice(false);
                  }}
                  placeholder={t("modelSection.compactionPlaceholder")}
                  className="max-w-xs font-mono tabular-nums"
                />
                <Button type="button" variant="outline" size="sm" onClick={onOpenSimulator}>
                  <FlaskConical className="size-3.5" aria-hidden="true" />
                  {t("modelSection.openLoopSimulator")}
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {COMPACTION_PRESETS.map(preset => {
                  const selected =
                    preset.tokens === null
                      ? compaction.trim() === ""
                      : Number(compaction.trim()) === preset.tokens;
                  return (
                    <button
                      key={String(preset.tokens)}
                      type="button"
                      onClick={() => {
                        setCompaction(preset.tokens === null ? "" : String(preset.tokens));
                        setSavedNotice(false);
                      }}
                      className={
                        "rounded-md border p-2.5 text-left transition-colors " +
                        (selected
                          ? "border-primary/50 bg-primary/10"
                          : "border-border/70 bg-[var(--surface-inset)] hover:border-border")
                      }
                    >
                      <div className="text-xs font-semibold">
                        {isZh ? preset.labelZh : preset.labelEn}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {isZh ? preset.hintZh : preset.hintEn}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          }
        />

        <SettingsRow
          label={t("modelSection.diagnosticsLabel")}
          htmlFor={diagnosticsId}
          description={t("modelSection.diagnosticsHint")}
          control={
            <NativeSelect
              id={diagnosticsId}
              value={diagnostics}
              onChange={event => {
                setDiagnostics(event.target.value === "full" ? "full" : "normal");
                setSavedNotice(false);
              }}
              wrapperClassName="w-full sm:w-64"
              className="w-full"
            >
              <NativeSelectOption value="normal">{t("modelSection.diagnosticsNormal")}</NativeSelectOption>
              <NativeSelectOption value="full">{t("modelSection.diagnosticsFull")}</NativeSelectOption>
            </NativeSelect>
          }
        />

        <SettingsRow
          label={t("modelSection.dashboardSwitch")}
          htmlFor="studio-dashboard-switch"
          description={t("modelSection.dashboardHint")}
          control={
            <Switch
              id="studio-dashboard-switch"
              checked={dashboard}
              onCheckedChange={checked => {
                setDashboard(checked);
                setSavedNotice(false);
              }}
            />
          }
        />

        <SettingsRow
          label={t("modelSection.petSwitch")}
          htmlFor="studio-pet-switch"
          description={t("modelSection.petHint")}
          control={
            <Switch
              id="studio-pet-switch"
              checked={pet}
              onCheckedChange={checked => {
                setPet(checked);
                setSavedNotice(false);
              }}
            />
          }
        />

        {initial.driver !== "cua" && (
          <>
            <SettingsRow
              label={t("modelSection.portLabel")}
              htmlFor={portInputId}
              control={
                <Input
                  id={portInputId}
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={event => {
                    setPort(event.target.value);
                    setSavedNotice(false);
                  }}
                  className="w-36 font-mono tabular-nums"
                />
              }
            />
            <SettingsRow
              label={t("modelSection.gameLabel")}
              htmlFor={gameInputId}
              control={
                <Input
                  id={gameInputId}
                  value={game}
                  onChange={event => {
                    setGame(event.target.value);
                    setSavedNotice(false);
                  }}
                  placeholder={t("modelSection.gamePlaceholder")}
                  className="w-full font-mono sm:w-72"
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {saveError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{saveError}</AlertDescription>
        </Alert>
      )}
      {savedNotice && (
        <Alert className="border-success/35 bg-success/5">
          <CheckCircle2 className="text-success" />
          <AlertTitle>{t("savedTitle")}</AlertTitle>
          <AlertDescription className="text-xs">{t("savedHint")}</AlertDescription>
        </Alert>
      )}

      <SettingsSaveBar
        dirty={dirty}
        saving={saving}
        statusText={dirty ? t("unsavedChanges") : t("syncedWithDisk")}
        discardLabel={t("discard")}
        onDiscard={resetDraft}
        saveLabel={t("saveConfig")}
        savingLabel={t("saving")}
        onSave={() => void saveConfig()}
        secondaryAction={
          isWorkspaceRunning ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={service.busy}
              onClick={() => void service.reloadWorkspace()}
            >
              {service.pendingOperation === "reload" ? (
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-3.5" aria-hidden="true" />
              )}
              {t(service.pendingOperation === "reload" ? "reloadingWorkspace" : "reloadNow")}
            </Button>
          ) : undefined
        }
      />

      <AdvancedDiagnosticsDisclosure summary={t("servicesSection.advancedDiagnostics")}>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>{t("reloadHostTitle")}</p>
          <div className="flex items-center gap-2 rounded-md border border-border/70 bg-[var(--surface-inset)] px-3 py-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] text-foreground">
              {reloadCmd}
            </code>
            <InlineCopyButton
              text={reloadCmd}
              ariaLabel={t("copyReload")}
              copiedText={t("copied")}
            />
          </div>
        </div>
      </AdvancedDiagnosticsDisclosure>
    </div>
  );
}

const SERVICE_ROWS: Array<{ name: "host" | "baseware" | "emulator"; label: string }> = [
  { name: "host", label: "Host" },
  { name: "baseware", label: "Baseware" },
  { name: "emulator", label: "Emulator" },
];

export function ServicesAndShioriPanel({
  studio,
  isZh,
  onRefresh,
  onOpenBaseware,
  onStudioUpdated,
  onShioriUpdated,
}: {
  studio: WorkspaceStudioSnapshot;
  isZh: boolean;
  onRefresh(): void;
  onOpenBaseware(): void;
  onStudioUpdated(next: WorkspaceStudioSnapshot): void;
  onShioriUpdated(shiori: WorkspaceShioriSnapshot): void;
}) {
  const t = useTranslations("workspaceStudio");
  const [memoryDraft, setMemoryDraft] = useState(studio.shiori.memory.content);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const service = useWorkspaceService({
    workspaceId: studio.id,
    fallbackError: t("operationFailed"),
    onStudioSnapshot: next => onStudioUpdated(next),
    onSuccess: () => onRefresh(),
  });

  useEffect(() => {
    setMemoryDraft(studio.shiori.memory.content);
  }, [studio.shiori.memory.content]);

  const serviceOutput = service.lastResult
    ? {
        ok: service.lastResult.ok && service.lastResult.exitCode === 0,
        operation: service.lastResult.operation,
        exitCode: service.lastResult.exitCode,
        stdout: service.lastResult.stdout,
        stderr: service.lastResult.stderr,
      }
    : service.error
      ? {
          ok: false,
          operation: "up" as const,
          exitCode: 1,
          stdout: "",
          stderr: service.error,
        }
      : null;

  const runShioriMutation = async (payload: Record<string, unknown>, successMsg: string) => {
    if (busyAction) return;
    setBusyAction(String(payload.kind));
    setActionError(null);
    setActionSuccess(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "workspaceShiori",
          id: studio.id,
          shiori: payload,
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? t("operationFailed"));
      onShioriUpdated(value as WorkspaceShioriSnapshot);
      setActionSuccess(successMsg);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const quotedWs = quoteShellPath(studio.workspace);
  const upCmd = `ludens --workspace ${quotedWs} up`;
  const reloadCmd = `ludens --workspace ${quotedWs} down --keep-emulator && ludens --workspace ${quotedWs} up`;
  const downCmd = `ludens --workspace ${quotedWs} down`;
  const serviceOps: Array<{
    key: "up" | "reload" | "down";
    runLabel: string;
    label: string;
    icon: typeof Play;
    cmd: string;
  }> = [
    { key: "up", runLabel: t("servicesSection.runUp"), label: t("servicesSection.cmdUp"), icon: Play, cmd: upCmd },
    { key: "reload", runLabel: t("servicesSection.runReload"), label: t("servicesSection.cmdReload"), icon: RotateCcw, cmd: reloadCmd },
    { key: "down", runLabel: t("servicesSection.runDown"), label: t("servicesSection.cmdDown"), icon: Square, cmd: downCmd },
  ];

  const runningText = isZh ? "运行中" : "Running";

  return (
    <div className="grid min-w-0 gap-6">
      <SettingsSection
        title={t("servicesSection.title")}
        description={t("servicesSection.description")}
        actions={
          <>
            {serviceOps.map(item => {
              const Icon = item.icon;
              const isRunningOp = service.pendingOperation === item.key;
              return (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={item.key === "up" ? "default" : item.key === "reload" ? "secondary" : "outline"}
                  disabled={service.busy}
                  onClick={() => void service.runOperation(item.key)}
                  data-studio-service-action={item.key}
                >
                  {isRunningOp ? (
                    <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Icon className="size-3.5" aria-hidden="true" />
                  )}
                  {isRunningOp ? t("servicesSection.runningOp") : item.runLabel}
                </Button>
              );
            })}
            <Button type="button" variant="outline" size="sm" onClick={onOpenBaseware}>
              <HardDrive className="size-3.5" aria-hidden="true" />
              {t("servicesSection.manageBaseware")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t("refresh")}
            </Button>
          </>
        }
      >
        {SERVICE_ROWS.map(entry => {
          const job = studio.services.jobs.find(item => item.name === entry.name);
          const isRunning = Boolean(job?.pid);
          const isStandby = !isRunning && Boolean(job?.registered);
          const statusLabel = isRunning
            ? runningText
            : isStandby
              ? t("deviceSection.standby")
              : t("stopped");

          return (
            <SettingsRow
              key={entry.name}
              label={entry.label}
              control={
                <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                  <span
                    className={
                      "size-2 rounded-full " +
                      (isRunning
                        ? "bg-emerald-500"
                        : isStandby
                          ? "bg-amber-500"
                          : "bg-muted-foreground/45")
                    }
                    aria-hidden="true"
                  />
                  <span>{statusLabel}</span>
                </span>
              }
            />
          );
        })}
      </SettingsSection>

      {serviceOutput && (
        <div
          className={
            "space-y-1.5 rounded-md border p-3 text-xs " +
            (serviceOutput.ok
              ? "border-success/35 bg-success/5 text-foreground"
              : "border-destructive/40 bg-destructive/10 text-destructive")
          }
          data-studio-service-output
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>
              {serviceOutput.ok
                ? t("servicesSection.execSuccess").replace("{operation}", serviceOutput.operation)
                : t("servicesSection.execFailed")
                    .replace("{operation}", serviceOutput.operation)
                    .replace("{code}", String(serviceOutput.exitCode))}
            </span>
            <button
              type="button"
              onClick={() => service.clearResult()}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
          {(serviceOutput.stdout || serviceOutput.stderr) && (
            <pre className="max-h-36 overflow-auto rounded bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {[serviceOutput.stdout, serviceOutput.stderr].filter(Boolean).join("\n")}
            </pre>
          )}
        </div>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{actionError}</AlertDescription>
        </Alert>
      )}
      {actionSuccess && (
        <Alert className="border-success/35 bg-success/5">
          <CheckCircle2 className="text-success" />
          <AlertDescription className="text-xs">{actionSuccess}</AlertDescription>
        </Alert>
      )}

      <SettingsSection
        headingLevel={3}
        title={t("shioriSection.title")}
        description={t("shioriSection.description")}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!!busyAction || !studio.shiori.currentSessionFile}
            onClick={() =>
              void runShioriMutation({ kind: "newSession" }, t("shioriSection.newSessionReady"))
            }
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("shioriSection.startFreshNext")}
          </Button>
        }
      >
        <SettingsRow
          label={t("shioriSection.currentPointer")}
          control={
            <SingleLineTruncate
              mono
              text={studio.shiori.currentSessionFile ?? t("shioriSection.freshOnNextStart")}
              className="max-w-full text-xs text-muted-foreground"
            />
          }
        />

        {studio.shiori.sessions.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">{t("shioriSection.noSessions")}</p>
        ) : (
          studio.shiori.sessions.map(session => (
            <SettingsRow
              key={session.relativePath}
              label={<SingleLineTruncate mono text={session.file} className="max-w-xs text-xs sm:max-w-md" />}
              badge={
                session.isCurrent ? (
                  <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                    {t("shioriSection.activePointer")}
                  </Badge>
                ) : undefined
              }
              description={`${formatBytes(session.sizeBytes)} · ${new Date(session.updatedAt).toLocaleString()}`}
              control={
                !session.isCurrent ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runShioriMutation(
                        { kind: "selectSession", sessionFile: session.relativePath },
                        t("shioriSection.sessionSelected"),
                      )
                    }
                  >
                    {t("shioriSection.resumeThis")}
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        headingLevel={3}
        title={t("memorySection.title")}
        description={t("memorySection.description")}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={!!busyAction || memoryDraft === studio.shiori.memory.content}
            onClick={() =>
              void runShioriMutation(
                { kind: "saveMemory", content: memoryDraft },
                t("memorySection.saved"),
              )
            }
          >
            <Save className="size-3.5" aria-hidden="true" />
            {t("memorySection.save")}
          </Button>
        }
      >
        <SettingsRow
          stacked
          label="MEMORY.md"
          control={
            <textarea
              value={memoryDraft}
              onChange={event => setMemoryDraft(event.target.value)}
              rows={10}
              placeholder={t("memorySection.placeholder")}
              aria-label={t("memorySection.title")}
              className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        />
      </SettingsSection>

      <AdvancedDiagnosticsDisclosure summary={t("servicesSection.advancedDiagnostics")}>
        <div className="space-y-4 text-xs">
          <div className="space-y-2">
            {serviceOps.map(item => (
              <div key={item.key} className="space-y-1">
                <p className="text-muted-foreground">{item.label}</p>
                <div className="flex items-center gap-2 rounded-md border border-border/70 bg-[var(--surface-inset)] px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] text-foreground">
                    {item.cmd}
                  </code>
                  <InlineCopyButton
                    text={item.cmd}
                    ariaLabel={item.label}
                    copiedText={t("copied")}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5 border-t border-border/50 pt-3 font-mono text-[11px] text-muted-foreground">
            <p className="break-all">
              hostSocket: {studio.services.hostSocket} ({studio.services.hostSocketExists ? "exists" : "missing"})
            </p>
            <p className="break-all">memory: {studio.shiori.memory.path}</p>
          </div>

          <div className="space-y-3 border-t border-border/50 pt-3">
            {studio.services.jobs.map(job => (
              <div key={job.name} className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="font-semibold text-foreground">{job.name}</span>
                  <span className="text-muted-foreground">
                    {job.pid ? `PID ${job.pid}` : t("stopped")} · {job.state ?? (job.registered ? "registered" : "unregistered")}
                    {job.lastExitCode !== null ? ` · exit ${job.lastExitCode}` : ""}
                  </span>
                </div>
                <p className="break-all font-mono text-[11px] text-muted-foreground">{job.target}</p>
                {job.logPath && (
                  <p className="break-all font-mono text-[11px] text-muted-foreground">{job.logPath}</p>
                )}
                {job.logTail.length > 0 && (
                  <pre className="max-h-36 overflow-auto rounded bg-background p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {job.logTail.join("\n")}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </AdvancedDiagnosticsDisclosure>
    </div>
  );
}
