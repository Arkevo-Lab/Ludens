"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  Bot,
  Cable,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Eye,
  FileText,
  FlaskConical,
  HardDrive,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Sparkles,
  Square,
  Terminal,
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModelPickerDialog } from "@/components/model-picker-dialog";
import { useLocale, useTranslations } from "@/lib/locale";
import { PerceptionSettingsPanel } from "@/features/capabilities/perception-settings";
import { ConnectionSettings } from "@/features/workspaces/connection-settings";
import { LoopLab } from "@/shell/loop-lab";

export type StudioTab = "model" | "connection" | "services" | "perception" | "simulator";
const STUDIO_TABS: readonly StudioTab[] = ["model", "connection", "services", "perception", "simulator"];

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
    hintEn: "Uses OMP's native contextWindow - reserve",
    hintZh: "使用 OMP 原生 contextWindow - reserve（适合有状态 WS）",
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
      : "model";
  const [tab, setTab] = useState<StudioTab>(resolvedTab);
  useEffect(() => {
    if (initialTab && (STUDIO_TABS as readonly string[]).includes(initialTab)) {
      setTab(initialTab as StudioTab);
    }
  }, [initialTab]);

  const target = projects.find(item => item.id === project);
  const [studio, setStudio] = useState<WorkspaceStudioSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const requestVersion = useRef(0);

  const refreshStudio = useCallback(() => {
    setReloadTick(value => value + 1);
  }, []);

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
    const valid = (STUDIO_TABS as readonly string[]).includes(next) ? (next as StudioTab) : "model";
    setTab(valid);
    navigate({ studioTab: valid === "model" ? null : valid });
  };

  const hostJob = studio?.services.jobs.find(item => item.name === "host");
  const basewareJob = studio?.services.jobs.find(item => item.name === "baseware");
  const emulatorJob = studio?.services.jobs.find(item => item.name === "emulator");

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-5" aria-label={t("title")}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            {studio?.config && (
              <>
                <Badge variant="outline" className="border-primary/35 bg-primary/10 font-mono text-xs text-primary">
                  {studio.config.driver}
                </Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  {studio.config.model}
                </Badge>
              </>
            )}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("subtitle")}</p>
          {target?.workspace && (
            <p className="break-all font-mono text-xs text-muted-foreground">{target.workspace}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studio && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/80 bg-[var(--surface-inset)] px-2.5 py-1.5 text-xs">
              <span
                className={
                  "size-2 rounded-full " +
                  (hostJob?.pid ? "bg-success" : "bg-muted-foreground/50")
                }
              />
              <span className="font-medium">Host</span>
              <span className="font-mono text-muted-foreground">
                {hostJob?.pid ? `PID ${hostJob.pid}` : t("stopped")}
              </span>
              <span className="text-muted-foreground">·</span>
              <span
                className={
                  "size-2 rounded-full " +
                  (basewareJob?.pid ? "bg-success" : "bg-muted-foreground/50")
                }
              />
              <span className="font-medium">Baseware</span>
              <span className="font-mono text-muted-foreground">
                {basewareJob?.pid ? `PID ${basewareJob.pid}` : t("stopped")}
              </span>
              {emulatorJob?.registered && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-medium">Emulator</span>
                  <span className="font-mono text-muted-foreground">
                    {emulatorJob.pid ? `PID ${emulatorJob.pid}` : t("stopped")}
                  </span>
                </>
              )}
            </div>
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

      <Tabs value={tab} onValueChange={onTabChange} className="w-full space-y-5">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 bg-[var(--surface-inset)] p-1.5">
          <TabsTrigger value="model" className="gap-1.5 px-3 py-2 text-xs sm:text-sm">
            <Bot className="size-4" aria-hidden="true" />
            {t("tabs.model")}
          </TabsTrigger>
          <TabsTrigger value="connection" className="gap-1.5 px-3 py-2 text-xs sm:text-sm">
            <Cable className="size-4" aria-hidden="true" />
            {t("tabs.connection")}
          </TabsTrigger>
          <TabsTrigger value="services" className="gap-1.5 px-3 py-2 text-xs sm:text-sm">
            <Server className="size-4" aria-hidden="true" />
            {t("tabs.services")}
            {studio?.shiori.sessions.length ? (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                {studio.shiori.sessions.length}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="perception" className="gap-1.5 px-3 py-2 text-xs sm:text-sm">
            <Eye className="size-4" aria-hidden="true" />
            {t("tabs.perception")}
          </TabsTrigger>
          <TabsTrigger value="simulator" className="gap-1.5 px-3 py-2 text-xs sm:text-sm">
            <FlaskConical className="size-4" aria-hidden="true" />
            {t("tabs.simulator")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="model" className="space-y-5">
          {!target ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {ready ? t("selectWorkspace") : t("loading")}
              </CardContent>
            </Card>
          ) : !studio ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {loading ? t("loading") : t("loadFailed")}
              </CardContent>
            </Card>
          ) : (
            <ModelAndBudgetPanel
              studio={studio}
              isZh={isZh}
              onSaved={next => setStudio(next)}
              onOpenSimulator={() => onTabChange("simulator")}
              onOpenConnection={() => onTabChange("connection")}
            />
          )}
        </TabsContent>

        <TabsContent value="connection" className="space-y-5">
          <ConnectionSettings
            projects={projects}
            initialScope={target?.id ?? "global"}
            onSaved={refreshStudio}
          />
        </TabsContent>

        <TabsContent value="services" className="space-y-5">
          {!studio ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {loading ? t("loading") : t("selectWorkspace")}
              </CardContent>
            </Card>
          ) : (
            <ServicesAndShioriPanel
              studio={studio}
              isZh={isZh}
              onRefresh={refreshStudio}
              onOpenBaseware={() => navigate({ view: "baseware" })}
              onStudioUpdated={next => setStudio(next)}
              onShioriUpdated={shiori =>
                setStudio(current => (current ? { ...current, shiori } : current))
              }
            />
          )}
        </TabsContent>

        <TabsContent value="perception" className="space-y-5">
          <PerceptionSettingsPanel
            project={project}
            projects={projects}
            ready={ready}
            catalogError={catalogError}
            catalogLoading={catalogLoading}
            onRetryCatalog={onRetryCatalog}
          />
        </TabsContent>

        <TabsContent value="simulator" className="space-y-5">
          <LoopLab navigate={navigate} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function ModelAndBudgetPanel({
  studio,
  isZh,
  onSaved,
  onOpenSimulator,
  onOpenConnection,
}: {
  studio: WorkspaceStudioSnapshot;
  isZh: boolean;
  onSaved(snapshot: WorkspaceStudioSnapshot): void;
  onOpenSimulator(): void;
  onOpenConnection(): void;
}) {
  const t = useTranslations("workspaceStudio");
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
    seconds: studio.defaults.seconds ?? 1800,
    requests: studio.defaults.requests ?? 1000,
    compactionThreshold: studio.defaults.compactionThreshold,
    dashboard: studio.defaults.dashboard ?? true,
    pet: studio.defaults.pet ?? false,
    diagnostics: "normal",
  };

  const [model, setModel] = useState(initial.model);
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
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  useEffect(() => {
    const cfg = studio.config;
    if (!cfg) return;
    setModel(cfg.model);
    setSeconds(String(cfg.seconds));
    setRequests(String(cfg.requests));
    setCompaction(cfg.compactionThreshold !== undefined ? String(cfg.compactionThreshold) : "");
    setDiagnostics(cfg.diagnostics);
    setPet(cfg.pet);
    setDashboard(cfg.dashboard);
    setPort(cfg.port !== undefined ? String(cfg.port) : "");
    setGame(cfg.game ?? "");
  }, [studio.config]);

  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const parsedSeconds = Number(seconds.trim());
  const parsedRequests = Number(requests.trim());
  const parsedCompaction = compaction.trim() === "" ? null : Number(compaction.trim());
  const parsedPort = port.trim() === "" ? null : Number(port.trim());

  const dirty =
    model.trim() !== initial.model ||
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

  const reloadCmd = `ludens --workspace ${quoteShellPath(studio.workspace)} down --keep-emulator && ludens --workspace ${quoteShellPath(studio.workspace)} up`;
  const copyReload = async () => {
    try {
      await navigator.clipboard.writeText(reloadCmd);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="size-4 text-[var(--gold)]" aria-hidden="true" />
                {t("modelSection.title")}
              </CardTitle>
              <CardDescription>{t("modelSection.description")}</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onOpenConnection}>
              <Cable className="size-3.5" aria-hidden="true" />
              {t("modelSection.configureTransport")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2.5">
            <Label htmlFor={modelInputId}>{t("modelSection.modelLabel")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={modelInputId}
                value={model}
                onChange={event => {
                  setModel(event.target.value);
                  setSavedNotice(false);
                }}
                placeholder="openai-codex/gpt-6.1-sol"
                className="font-mono text-sm sm:flex-1"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={saving}
                data-browse-models="workspace-studio"
                onClick={() => setModelPickerOpen(true)}
              >
                <Cpu className="size-3.5" aria-hidden="true" />
                {t("modelSection.browseModels")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("modelSection.modelHint")}</p>
            <ModelPickerDialog
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              value={model}
              projectId={studio.id}
              allowUnauthenticated={true}
              onSelect={nextModel => {
                setModel(nextModel);
                setSavedNotice(false);
              }}
            />
            <div className="flex flex-wrap gap-2 pt-1">
              {MODEL_PRESETS.map(preset => {
                const active = model.trim() === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setModel(preset.id);
                      setSavedNotice(false);
                    }}
                    className={
                      "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors " +
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
          </div>

          <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={secondsInputId}>{t("modelSection.secondsLabel")}</Label>
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
                className="font-mono"
              />
              <div className="flex flex-wrap gap-1.5">
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
              <p className="text-xs text-muted-foreground">{t("modelSection.secondsHint")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={requestsInputId}>{t("modelSection.requestsLabel")}</Label>
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
                className="font-mono"
              />
              <div className="flex flex-wrap gap-1.5">
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
              <p className="text-xs text-muted-foreground">{t("modelSection.requestsHint")}</p>
            </div>
          </div>

          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <Label htmlFor={compactionInputId} className="flex items-center gap-2">
                  <Sparkles className="size-3.5 text-[var(--gold)]" aria-hidden="true" />
                  {t("modelSection.compactionLabel")}
                </Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("modelSection.compactionHint")}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onOpenSimulator}>
                <FlaskConical className="size-3.5" aria-hidden="true" />
                {t("modelSection.openLoopSimulator")}
              </Button>
            </div>
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
              className="max-w-sm font-mono"
            />
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

          <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={diagnosticsId}>{t("modelSection.diagnosticsLabel")}</Label>
              <NativeSelect
                id={diagnosticsId}
                value={diagnostics}
                onChange={event => {
                  setDiagnostics(event.target.value === "full" ? "full" : "normal");
                  setSavedNotice(false);
                }}
                wrapperClassName="w-full"
                className="w-full"
              >
                <NativeSelectOption value="normal">{t("modelSection.diagnosticsNormal")}</NativeSelectOption>
                <NativeSelectOption value="full">{t("modelSection.diagnosticsFull")}</NativeSelectOption>
              </NativeSelect>
              <p className="text-[11px] text-muted-foreground">{t("modelSection.diagnosticsHint")}</p>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-[var(--surface-inset)] p-3">
              <div className="space-y-0.5">
                <Label htmlFor="studio-dashboard-switch" className="text-xs font-semibold">
                  {t("modelSection.dashboardSwitch")}
                </Label>
                <p className="text-[11px] text-muted-foreground">{t("modelSection.dashboardHint")}</p>
              </div>
              <Switch
                id="studio-dashboard-switch"
                checked={dashboard}
                onCheckedChange={checked => {
                  setDashboard(checked);
                  setSavedNotice(false);
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-[var(--surface-inset)] p-3">
              <div className="space-y-0.5">
                <Label htmlFor="studio-pet-switch" className="text-xs font-semibold">
                  {t("modelSection.petSwitch")}
                </Label>
                <p className="text-[11px] text-muted-foreground">{t("modelSection.petHint")}</p>
              </div>
              <Switch
                id="studio-pet-switch"
                checked={pet}
                onCheckedChange={checked => {
                  setPet(checked);
                  setSavedNotice(false);
                }}
              />
            </div>
          </div>

          {initial.driver !== "cua" && (
            <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={portInputId}>{t("modelSection.portLabel")}</Label>
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
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={gameInputId}>{t("modelSection.gameLabel")}</Label>
                <Input
                  id={gameInputId}
                  value={game}
                  onChange={event => {
                    setGame(event.target.value);
                    setSavedNotice(false);
                  }}
                  placeholder={t("modelSection.gamePlaceholder")}
                  className="font-mono"
                />
              </div>
            </div>
          )}

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

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-xs text-muted-foreground">
              {dirty ? t("unsavedChanges") : t("syncedWithDisk")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!dirty || saving}
                onClick={resetDraft}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {t("discard")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void saveConfig()}
              >
                <Save className="size-3.5" aria-hidden="true" />
                {t(saving ? "saving" : "saveConfig")}
              </Button>
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">{t("reloadHostTitle")}</span>
              <Button type="button" variant="outline" size="xs" onClick={() => void copyReload()}>
                {copied === "done" ? <Check className="size-3" /> : <Copy className="size-3" />}
                {t(copied === "done" ? "copied" : "copyReload")}
              </Button>
            </div>
            <code className="block select-all break-all font-mono text-[11px] text-muted-foreground">
              {reloadCmd}
            </code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ServicesAndShioriPanel({
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
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [busyServiceOp, setBusyServiceOp] = useState<"up" | "reload" | "down" | null>(null);
  const [serviceOutput, setServiceOutput] = useState<{
    ok: boolean;
    operation: "up" | "reload" | "down";
    exitCode: number;
    stdout: string;
    stderr: string;
  } | null>(null);

  useEffect(() => {
    setMemoryDraft(studio.shiori.memory.content);
  }, [studio.shiori.memory.content]);

  const runServiceControl = async (operation: "up" | "reload" | "down") => {
    if (busyServiceOp) return;
    setBusyServiceOp(operation);
    setServiceOutput(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "workspaceServiceControl",
          id: studio.id,
          service: { operation },
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? t("operationFailed"));
      if (value?.studio) onStudioUpdated(value.studio as WorkspaceStudioSnapshot);
      setServiceOutput({
        ok: Boolean(value?.ok),
        operation,
        exitCode: typeof value?.exitCode === "number" ? value.exitCode : 0,
        stdout: typeof value?.stdout === "string" ? value.stdout : "",
        stderr: typeof value?.stderr === "string" ? value.stderr : "",
      });
    } catch (error) {
      setServiceOutput({
        ok: false,
        operation,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyServiceOp(null);
    }
  };

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

  const copyCommand = async (key: string, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(key);
      setTimeout(() => setCopiedCmd(current => (current === key ? null : current)), 2200);
    } catch {
      // ignore clipboard errors
    }
  };

  const quotedWs = quoteShellPath(studio.workspace);
  const upCmd = `ludens --workspace ${quotedWs} up`;
  const reloadCmd = `ludens --workspace ${quotedWs} down --keep-emulator && ludens --workspace ${quotedWs} up`;
  const downCmd = `ludens --workspace ${quotedWs} down`;

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="size-4 text-[var(--gold)]" aria-hidden="true" />
                {t("servicesSection.title")}
              </CardTitle>
              <CardDescription>{t("servicesSection.description")}</CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onOpenBaseware}>
                <HardDrive className="size-3.5" aria-hidden="true" />
                {isZh ? "管理受控节点 (Baseware)" : "Manage Machines (Baseware)"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t("refresh")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {studio.services.jobs.map(job => (
              <div
                key={job.name}
                className="flex flex-col justify-between gap-2.5 rounded-md border border-border/80 bg-[var(--surface-inset)] p-3.5"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{job.name}</span>
                    <Badge
                      variant="outline"
                      className={
                        job.pid
                          ? "border-success/35 bg-success/10 text-success"
                          : "text-muted-foreground"
                      }
                    >
                      {job.pid ? `PID ${job.pid}` : t("stopped")}
                    </Badge>
                  </div>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    {job.target}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                  <span>
                    {t("servicesSection.state")}: {job.state ?? (job.registered ? "registered" : "unregistered")}
                  </span>
                  {job.lastExitCode !== null && (
                    <span>exit: {job.lastExitCode}</span>
                  )}
                </div>
                {job.logTail.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                      {t("servicesSection.viewLogs")} ({job.logTail.length})
                    </summary>
                    <pre className="mt-1.5 max-h-36 overflow-auto rounded bg-background p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {job.logTail.join("\n")}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>

          <div className="grid gap-2.5 border-t border-border/60 pt-4 sm:grid-cols-3">
            {(
              [
                {
                  key: "up" as const,
                  label: t("servicesSection.cmdUp"),
                  runLabel: isZh ? "立即启动" : "Run Up",
                  icon: Play,
                  cmd: upCmd,
                },
                {
                  key: "reload" as const,
                  label: t("servicesSection.cmdReload"),
                  runLabel: isZh ? "立即重载" : "Reload",
                  icon: RotateCcw,
                  cmd: reloadCmd,
                },
                {
                  key: "down" as const,
                  label: t("servicesSection.cmdDown"),
                  runLabel: isZh ? "立即停止" : "Stop",
                  icon: Square,
                  cmd: downCmd,
                },
              ]
            ).map(item => {
              const Icon = item.icon;
              const isRunningOp = busyServiceOp === item.key;
              return (
                <div
                  key={item.key}
                  className="flex flex-col justify-between gap-2 rounded-md border border-border/70 bg-background/50 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <Terminal className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      {item.label}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        variant={item.key === "up" ? "default" : "secondary"}
                        disabled={busyServiceOp !== null}
                        onClick={() => void runServiceControl(item.key)}
                        data-studio-service-action={item.key}
                      >
                        {isRunningOp ? (
                          <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Icon className="size-3" aria-hidden="true" />
                        )}
                        {isRunningOp ? (isZh ? "执行中…" : "Running…") : item.runLabel}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => void copyCommand(item.key, item.cmd)}
                      >
                        {copiedCmd === item.key ? <Check className="size-3" /> : <Copy className="size-3" />}
                        {t(copiedCmd === item.key ? "copied" : "copy")}
                      </Button>
                    </div>
                  </div>
                  <code className="block select-all break-all font-mono text-[11px] text-muted-foreground">
                    {item.cmd}
                  </code>
                </div>
              );
            })}
          </div>

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
                    ? isZh
                      ? `已执行 ludens ${serviceOutput.operation} (exit 0)`
                      : `Executed ludens ${serviceOutput.operation} (exit 0)`
                    : isZh
                      ? `执行 ludens ${serviceOutput.operation} 失败 (exit ${serviceOutput.exitCode})`
                      : `Failed ludens ${serviceOutput.operation} (exit ${serviceOutput.exitCode})`}
                </span>
                <button
                  type="button"
                  onClick={() => setServiceOutput(null)}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4 text-[var(--gold)]" aria-hidden="true" />
                {t("shioriSection.title")}
              </CardTitle>
              <CardDescription>{t("shioriSection.description")}</CardDescription>
            </div>
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
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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

          <div className="rounded-md border border-border/70 bg-[var(--surface-inset)] p-3 text-xs">
            <span className="font-medium">{t("shioriSection.currentPointer")}: </span>
            <code className="break-all font-mono text-muted-foreground">
              {studio.shiori.currentSessionFile ?? t("shioriSection.freshOnNextStart")}
            </code>
          </div>

          {studio.shiori.sessions.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t("shioriSection.noSessions")}
            </p>
          ) : (
            <ul className="grid gap-2">
              {studio.shiori.sessions.map(session => (
                <li
                  key={session.relativePath}
                  className={
                    "flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-xs " +
                    (session.isCurrent
                      ? "border-primary/45 bg-primary/5"
                      : "border-border/70 bg-[var(--surface-inset)]")
                  }
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono font-medium">{session.file}</span>
                      {session.isCurrent && (
                        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                          {t("shioriSection.activePointer")}
                        </Badge>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {formatBytes(session.sizeBytes)} · {new Date(session.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  {!session.isCurrent && (
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
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="size-4 text-[var(--gold)]" aria-hidden="true" />
                {t("memorySection.title")}
              </CardTitle>
              <CardDescription>{t("memorySection.description")}</CardDescription>
            </div>
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
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <p className="break-all font-mono text-xs text-muted-foreground">
            {studio.shiori.memory.path}
          </p>
          <textarea
            value={memoryDraft}
            onChange={event => setMemoryDraft(event.target.value)}
            rows={12}
            placeholder={t("memorySection.placeholder")}
            aria-label={t("memorySection.title")}
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </CardContent>
      </Card>
    </div>
  );
}
