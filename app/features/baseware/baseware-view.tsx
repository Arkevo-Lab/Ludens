"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  Cpu,
  Edit3,
  Gamepad2,
  Globe,
  HardDrive,
  Laptop,
  Link2,
  Monitor,
  Network,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  MACHINE_TRANSPORT_KINDS,
  type BasewareMachineSpec,
  type MachineTransportConfig,
  type MachineTransportKind,
  type WorkspaceMachinesBinding,
} from "@ludens/protocol/machines";
import type {
  BasewareMachineRuntimeStatus,
  WorkspaceBasewareSnapshot,
} from "@/lib/workspaces";
import type { CapabilitiesResult, CapabilityEntry } from "@/lib/capabilities";
import type { Project } from "@/lib/types";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useLocale, useTranslations } from "@/lib/locale";
import { useReadResource } from "@/components/use-read-resource";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

interface MachineFormDraft {
  id: string;
  name: string;
  driver: string;
  driverPackage: string;
  transportKind: MachineTransportKind;
  stdioCommand: string;
  stdioArgs: string;
  bridgeHost: string;
  bridgePort: string;
  bridgeGame: string;
  bridgeManaged: boolean;
  sshHost: string;
  sshUser: string;
  sshPort: string;
  sshIdentityFile: string;
  sshCommand: string;
  httpUrl: string;
}

const EMPTY_DRAFT: MachineFormDraft = {
  id: "",
  name: "",
  driver: "mgba",
  driverPackage: "",
  transportKind: "bridge",
  stdioCommand: "cua-driver",
  stdioArgs: "",
  bridgeHost: "127.0.0.1",
  bridgePort: "47653",
  bridgeGame: "",
  bridgeManaged: false,
  sshHost: "",
  sshUser: "",
  sshPort: "22",
  sshIdentityFile: "",
  sshCommand: "cua-driver",
  httpUrl: "http://127.0.0.1:8910/mcp",
};

const GBA_PRESET_DRAFT: MachineFormDraft = {
  ...EMPTY_DRAFT,
  id: "gba-mgba",
  name: "mGBA Emulator (Bridge :47653)",
  driver: "mgba",
  driverPackage: "file:/Users/ame/2610dev/playness/ludens-gba-driver",
  transportKind: "bridge",
  bridgeHost: "127.0.0.1",
  bridgePort: "47653",
  bridgeGame: "/Users/ame/2610dev/playness/roms/gba/games/pokemon-green/rom.gba",
  bridgeManaged: false,
};

const SSH_PRESET_DRAFT: MachineFormDraft = {
  ...EMPTY_DRAFT,
  id: "remote-pc-ssh",
  name: "Remote Desktop CUA (SSH)",
  driver: "cua",
  driverPackage: "",
  transportKind: "ssh",
  sshHost: "192.168.1.100",
  sshUser: "player",
  sshPort: "22",
  sshCommand: "cua-driver",
};

const HTTP_PRESET_DRAFT: MachineFormDraft = {
  ...EMPTY_DRAFT,
  id: "remote-mcp-http",
  name: "Remote MCP Bridge (HTTP)",
  driver: "cua",
  driverPackage: "",
  transportKind: "http",
  httpUrl: "http://127.0.0.1:8910/mcp",
};

function draftFromMachine(machine: BasewareMachineSpec): MachineFormDraft {
  const draft: MachineFormDraft = {
    ...EMPTY_DRAFT,
    id: machine.id,
    name: machine.name,
    driver: machine.driver,
    driverPackage: machine.driverPackage ?? "",
    transportKind: machine.transport.kind,
  };
  switch (machine.transport.kind) {
    case "stdio":
      draft.stdioCommand = machine.transport.command ?? "cua-driver";
      draft.stdioArgs = (machine.transport.args ?? []).join(" ");
      break;
    case "bridge":
      draft.bridgeHost = machine.transport.host ?? "127.0.0.1";
      draft.bridgePort = String(machine.transport.port);
      draft.bridgeGame = machine.transport.game ?? "";
      draft.bridgeManaged = Boolean(machine.transport.managed);
      break;
    case "ssh":
      draft.sshHost = machine.transport.host;
      draft.sshUser = machine.transport.user ?? "";
      draft.sshPort = machine.transport.port !== undefined ? String(machine.transport.port) : "22";
      draft.sshIdentityFile = machine.transport.identityFile ?? "";
      draft.sshCommand = machine.transport.command ?? "cua-driver";
      break;
    case "http":
    case "sse":
      draft.httpUrl = machine.transport.url;
      break;
  }
  return draft;
}

function buildMachineSpecFromDraft(draft: MachineFormDraft): BasewareMachineSpec {
  let transport: MachineTransportConfig;
  switch (draft.transportKind) {
    case "stdio": {
      const args = draft.stdioArgs
        .split(/\s+/)
        .map(item => item.trim())
        .filter(Boolean);
      transport = {
        kind: "stdio",
        ...(draft.stdioCommand.trim() ? { command: draft.stdioCommand.trim() } : {}),
        ...(args.length > 0 ? { args } : {}),
      };
      break;
    }
    case "bridge": {
      const port = Number(draft.bridgePort.trim());
      transport = {
        kind: "bridge",
        host: draft.bridgeHost.trim() || "127.0.0.1",
        port: Number.isInteger(port) && port > 0 ? port : 47663,
        ...(draft.bridgeGame.trim() ? { game: draft.bridgeGame.trim() } : {}),
        managed: draft.bridgeManaged,
      };
      break;
    }
    case "ssh": {
      const port = Number(draft.sshPort.trim());
      transport = {
        kind: "ssh",
        host: draft.sshHost.trim(),
        ...(draft.sshUser.trim() ? { user: draft.sshUser.trim() } : {}),
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        ...(draft.sshIdentityFile.trim() ? { identityFile: draft.sshIdentityFile.trim() } : {}),
        ...(draft.sshCommand.trim() ? { command: draft.sshCommand.trim() } : {}),
      };
      break;
    }
    case "http":
    case "sse": {
      transport = {
        kind: draft.transportKind,
        url: draft.httpUrl.trim(),
      };
      break;
    }
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    driver: draft.driver.trim(),
    ...(draft.driverPackage.trim() ? { driverPackage: draft.driverPackage.trim() } : {}),
    transport,
    updatedAt: new Date().toISOString(),
  };
}

function formatTransportSummary(transport: MachineTransportConfig): string {
  switch (transport.kind) {
    case "stdio":
      return [transport.command || "cua-driver", ...(transport.args ?? [])].join(" ");
    case "bridge":
      return `${transport.host ?? "127.0.0.1"}:${transport.port}${transport.game ? ` · ${transport.game.split("/").pop()}` : ""}`;
    case "ssh":
      return `${transport.user ? `${transport.user}@` : ""}${transport.host}${transport.port && transport.port !== 22 ? `:${transport.port}` : ""} · ${transport.command || "cua-driver"}`;
    case "http":
    case "sse":
      return transport.url;
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

  const [snapshot, setSnapshot] = useState<WorkspaceBasewareSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingBinding, setSavingBinding] = useState(false);
  const [bindingNotice, setBindingNotice] = useState("");
  const [bindingDraft, setBindingDraft] = useState<WorkspaceMachinesBinding>({
    active: "workspace-default",
    allowed: ["workspace-default", "local-desktop"],
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MachineFormDraft>(EMPTY_DRAFT);
  const [savingMachine, setSavingMachine] = useState(false);
  const [machineError, setMachineError] = useState("");
  const [probes, setProbes] = useState<Record<string, ProbeResult | "probing">>({});
  const [draftProbe, setDraftProbe] = useState<ProbeResult | "probing" | null>(null);

  const loadOverview = useCallback(async (workspaceId: string) => {
    setLoading(true);
    try {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
      const response = await fetch(`/api/baseware${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? t("loadFailed"));
      const next = data as WorkspaceBasewareSnapshot;
      setSnapshot(next);
      setBindingDraft(next.binding);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadOverview(project);
  }, [project, loadOverview]);

  const capsLoad = useReadResource<CapabilitiesResult>(
    project && workspace ? "/api/capabilities?" + new URLSearchParams({ project, workspace }) : null,
    ct("readFailed"),
  );
  const caps = capsLoad.value;
  const deviceItems = caps?.groups.find(group => group.id === "device")?.items ?? [];
  const deviceGuideHref = "/?" + new URLSearchParams({
    view: "docs",
    doc: "tutorials/devices",
    docLang: locale,
    ...(project ? { project } : {}),
  });

  const handleToggleAllowed = (machineId: string) => {
    setBindingNotice("");
    setBindingDraft(prev => {
      const exists = prev.allowed.includes(machineId);
      const nextAllowed = exists
        ? prev.allowed.filter(id => id !== machineId)
        : [...prev.allowed, machineId];
      const safeAllowed = nextAllowed.length > 0 ? nextAllowed : [machineId];
      const nextActive = prev.active && safeAllowed.includes(prev.active)
        ? prev.active
        : safeAllowed[0] ?? null;
      return { active: nextActive, allowed: safeAllowed };
    });
  };

  const handleSelectActive = (machineId: string) => {
    setBindingNotice("");
    setBindingDraft(prev => {
      const nextAllowed = prev.allowed.includes(machineId)
        ? prev.allowed
        : [...prev.allowed, machineId];
      return { active: machineId, allowed: nextAllowed };
    });
  };

  const handleSaveBinding = async (overrideBinding?: WorkspaceMachinesBinding) => {
    if (!project) return;
    const targetBinding = overrideBinding ?? bindingDraft;
    setSavingBinding(true);
    setBindingNotice("");
    try {
      const response = await fetch("/api/baseware", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "workspaceMachines",
          id: project,
          binding: targetBinding,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("saveBindingFailed"));
      const next = result as WorkspaceBasewareSnapshot;
      setSnapshot(next);
      setBindingDraft(next.binding);
      setBindingNotice(t("bindingSaved"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingBinding(false);
    }
  };

  const handleQuickActivate = async (machineId: string) => {
    const nextAllowed = bindingDraft.allowed.includes(machineId)
      ? bindingDraft.allowed
      : [...bindingDraft.allowed, machineId];
    const nextBinding: WorkspaceMachinesBinding = {
      active: machineId,
      allowed: nextAllowed,
    };
    setBindingDraft(nextBinding);
    await handleSaveBinding(nextBinding);
  };

  const handleProbeMachine = async (machine: BasewareMachineRuntimeStatus) => {
    setProbes(prev => ({ ...prev, [machine.id]: "probing" }));
    try {
      const body = machine.implicitForWorkspaceId
        ? { action: "probeMachine", machine: { id: machine.id, name: machine.name, driver: machine.driver, driverPackage: machine.driverPackage, transport: machine.transport } }
        : { action: "probeMachine", id: machine.id };
      const response = await fetch("/api/baseware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("probeFailed"));
      setProbes(prev => ({ ...prev, [machine.id]: result as ProbeResult }));
    } catch (cause) {
      setProbes(prev => ({
        ...prev,
        [machine.id]: {
          ok: false,
          latencyMs: 0,
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    }
  };

  const handleProbeDraft = async () => {
    setDraftProbe("probing");
    setMachineError("");
    try {
      const spec = buildMachineSpecFromDraft(draft);
      const response = await fetch("/api/baseware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probeMachine", machine: spec }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("probeFailed"));
      setDraftProbe(result as ProbeResult);
    } catch (cause) {
      setDraftProbe({
        ok: false,
        latencyMs: 0,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const handleSaveMachine = async () => {
    setSavingMachine(true);
    setMachineError("");
    try {
      const spec = buildMachineSpecFromDraft(draft);
      const response = await fetch("/api/baseware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upsertMachine", machine: spec }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("saveMachineFailed"));
      setEditorOpen(false);
      setEditingId(null);
      setDraftProbe(null);
      await loadOverview(project);
    } catch (cause) {
      setMachineError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingMachine(false);
    }
  };

  const handleDeleteMachine = async (machineId: string) => {
    if (machineId === "local-desktop" || machineId === "workspace-default") return;
    try {
      const response = await fetch("/api/baseware", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: machineId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("deleteMachineFailed"));
      await loadOverview(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openEditorWithDraft = (nextDraft: MachineFormDraft, existingId: string | null = null) => {
    setDraft(nextDraft);
    setEditingId(existingId);
    setMachineError("");
    setDraftProbe(null);
    setEditorOpen(true);
  };

  const machines = snapshot?.machines ?? [];
  const activeMachine = snapshot?.activeMachine ?? snapshot?.implicitMachine ?? null;
  const daemon = snapshot?.daemon;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-6" data-baseware-view>
      {/* Page Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <Cpu className="size-6 text-primary" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            <Badge variant="outline" className="font-mono text-xs">
              Control Plane ↔ Machine Pool
            </Badge>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadOverview(project)}
            disabled={loading}
          >
            <RefreshCw className={"size-3.5 " + (loading ? "animate-spin" : "")} aria-hidden="true" />
            {t("refresh")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => openEditorWithDraft(EMPTY_DRAFT)}
            data-baseware-add-machine
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("addMachine")}
          </Button>
        </div>
      </header>

      {catalogError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{catalogError}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetryCatalog} disabled={catalogLoading}>
              {ct(catalogLoading ? "retrying" : "retryCatalog")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Top Topology Summary Strip */}
      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t("summaryLabel")}
        data-baseware-summary
      >
        <Card className="min-w-0">
          <CardContent className="space-y-1 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardActiveTarget")}</span>
              <Gamepad2 className="size-4 text-primary" aria-hidden="true" />
            </div>
            <div className="truncate text-base font-semibold">
              {activeMachine ? activeMachine.name : t("unboundTarget")}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {activeMachine ? (
                <>
                  <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px] uppercase">
                    {activeMachine.transport.kind}
                  </Badge>
                  <code className="truncate">{activeMachine.driver}</code>
                </>
              ) : (
                <span>—</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardContent className="space-y-1 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardWorkspacePool")}</span>
              <Link2 className="size-4 text-primary" aria-hidden="true" />
            </div>
            <div className="text-base font-semibold">
              {bindingDraft.allowed.length} {t("machinesAllowedUnit")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {snapshot?.workspaceName || project || t("noWorkspaceSelected")}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardContent className="space-y-1 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardGlobalRegistry")}</span>
              <Server className="size-4 text-primary" aria-hidden="true" />
            </div>
            <div className="text-base font-semibold">
              {machines.length} {t("machinesRegisteredUnit")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              <code>~/.ludens/machines.json</code>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardContent className="space-y-1 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("cardDaemonStatus")}</span>
              <Activity className="size-4 text-primary" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-2 text-base font-semibold">
              <span
                className={
                  "inline-block size-2.5 rounded-full " +
                  (daemon?.status?.connected
                    ? "bg-emerald-500"
                    : daemon?.basewareSocketExists
                      ? "bg-amber-500"
                      : "bg-slate-400")
                }
              />
              <span>
                {daemon?.status?.connected
                  ? `${t("daemonConnected")} (${daemon.status.mode})`
                  : daemon?.basewareSocketExists
                    ? t("daemonStandby")
                    : t("daemonOffline")}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {daemon?.status?.serviceId ? <code>{daemon.status.serviceId}</code> : <span>{t("daemonHint")}</span>}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Section 1: Workspace Machine Binding & Live Baseware Lease */}
      <Card className="min-w-0" data-baseware-section="workspace-binding">
        <CardContent className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2.5 text-base font-semibold">
                <Link2 className="size-5 text-primary" aria-hidden="true" />
                {t("bindingSectionTitle")}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("bindingSectionDesc")}
              </p>
            </div>
            {project && (
              <div className="flex items-center gap-2">
                {bindingNotice && (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {bindingNotice}
                  </span>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSaveBinding()}
                  disabled={savingBinding || !project}
                  data-baseware-save-binding
                >
                  {savingBinding ? t("saving") : t("saveBinding")}
                </Button>
              </div>
            )}
          </div>

          {!project && ready ? (
            <p className="text-sm text-muted-foreground">{t("noWorkspaceSelected")}</p>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              {/* Left 7 cols: Active Target & Allowed Machines Selector */}
              <div className="space-y-4 lg:col-span-7">
                <div className="space-y-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("activeMachineLabel")}
                  </label>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("activeMachineLabel")}>
                    {machines
                      .filter(m => bindingDraft.allowed.includes(m.id))
                      .map(machine => {
                        const isSelected = bindingDraft.active === machine.id;
                        return (
                          <button
                            key={machine.id}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            onClick={() => handleSelectActive(machine.id)}
                            data-baseware-active-option={machine.id}
                            className={
                              "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors " +
                              (isSelected
                                ? "border-primary bg-primary/10 font-semibold text-foreground"
                                : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground")
                            }
                          >
                            <TransportIcon kind={machine.transport.kind} />
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span>{machine.name}</span>
                                <Badge variant="outline" className="px-1 py-0 font-mono text-[10px] uppercase">
                                  {machine.transport.kind}
                                </Badge>
                              </div>
                              <div className="font-mono text-[11px] text-muted-foreground">
                                {formatTransportSummary(machine.transport)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("allowedMachinesLabel")}
                  </label>
                  <p className="text-xs text-muted-foreground">{t("allowedMachinesHint")}</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {machines.map(machine => {
                      const allowed = bindingDraft.allowed.includes(machine.id);
                      const isActive = bindingDraft.active === machine.id;
                      return (
                        <label
                          key={machine.id}
                          className={
                            "flex cursor-pointer items-start justify-between gap-2 rounded-md border p-2.5 text-xs transition-colors " +
                            (allowed ? "border-primary/40 bg-primary/5" : "border-border bg-card opacity-75")
                          }
                        >
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={allowed}
                              onChange={() => handleToggleAllowed(machine.id)}
                              data-baseware-allowed-checkbox={machine.id}
                            />
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                <span className="truncate">{machine.name}</span>
                                <code className="text-[11px] text-muted-foreground">({machine.id})</code>
                              </div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                {machine.driver} · {formatTransportSummary(machine.transport)}
                              </div>
                            </div>
                          </div>
                          {isActive && (
                            <Badge variant="default" className="shrink-0 text-[10px]">
                              {t("activeBadge")}
                            </Badge>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Right 5 cols: Live Daemon & Service Jobs */}
              <div className="space-y-3 rounded-lg border bg-muted/20 p-4 lg:col-span-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Activity className="size-3.5 text-primary" aria-hidden="true" />
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
                        : t("externalOrUnregistered")}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t("epochLabel")}</dt>
                    <dd className="font-mono text-[11px]">{daemon?.status?.epoch ?? "—"}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Global Baseware Machine Pool */}
      <Card className="min-w-0" data-baseware-section="machine-pool">
        <CardContent className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2.5 text-base font-semibold">
                <Server className="size-5 text-primary" aria-hidden="true" />
                {t("poolSectionTitle")}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("poolSectionDesc")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openEditorWithDraft(GBA_PRESET_DRAFT)}
                data-baseware-preset="gba-mgba"
              >
                <Gamepad2 className="size-3.5 text-primary" aria-hidden="true" />
                {t("presetGbaMgba")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openEditorWithDraft(SSH_PRESET_DRAFT)}
                data-baseware-preset="ssh-cua"
              >
                <Laptop className="size-3.5 text-primary" aria-hidden="true" />
                {t("presetRemoteSsh")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openEditorWithDraft(HTTP_PRESET_DRAFT)}
                data-baseware-preset="http-mcp"
              >
                <Network className="size-3.5 text-primary" aria-hidden="true" />
                {t("presetHttpMcp")}
              </Button>
            </div>
          </div>

          {/* Add / Edit Machine Modal / Drawer */}
          {editorOpen && (
            <div
              className="space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4"
              data-baseware-machine-editor
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Wrench className="size-4 text-primary" aria-hidden="true" />
                  {editingId ? t("editMachineTitle") : t("newMachineTitle")}
                </h3>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleProbeDraft()}
                    disabled={draftProbe === "probing"}
                  >
                    <Play className="size-3.5" aria-hidden="true" />
                    {draftProbe === "probing" ? t("probing") : t("probeConnection")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditorOpen(false);
                      setEditingId(null);
                      setDraftProbe(null);
                    }}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleSaveMachine()}
                    disabled={savingMachine}
                    data-baseware-save-machine
                  >
                    {savingMachine ? t("saving") : t("saveMachine")}
                  </Button>
                </div>
              </div>

              {machineError && (
                <Alert variant="destructive">
                  <AlertDescription>{machineError}</AlertDescription>
                </Alert>
              )}

              {draftProbe && draftProbe !== "probing" && (
                <div
                  className={
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-xs " +
                    (draftProbe.ok
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-destructive/40 bg-destructive/10 text-destructive")
                  }
                >
                  {draftProbe.ok ? (
                    <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-semibold">{draftProbe.ok ? t("probeOk") : t("probeFailed")}</span>
                  <span>· {draftProbe.latencyMs}ms ·</span>
                  <code className="break-all">{draftProbe.detail}</code>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1 text-xs">
                  <span className="font-medium">{t("fieldId")}</span>
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                    placeholder="gba-mgba"
                    value={draft.id}
                    disabled={Boolean(editingId)}
                    onChange={e => setDraft(prev => ({ ...prev, id: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="font-medium">{t("fieldName")}</span>
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs"
                    placeholder="mGBA Emulator"
                    value={draft.name}
                    onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="font-medium">{t("fieldDriver")}</span>
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                    placeholder="mgba / cua / desmume"
                    value={draft.driver}
                    onChange={e => setDraft(prev => ({ ...prev, driver: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="font-medium">{t("fieldTransport")}</span>
                  <select
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                    value={draft.transportKind}
                    onChange={e =>
                      setDraft(prev => ({ ...prev, transportKind: e.target.value as MachineTransportKind }))
                    }
                  >
                    {MACHINE_TRANSPORT_KINDS.map(kind => (
                      <option key={kind} value={kind}>
                        {kind.toUpperCase()} — {t(`transportKinds.${kind}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="font-medium">{t("fieldDriverPackage")}</span>
                <input
                  type="text"
                  className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                  placeholder="file:/Users/ame/2610dev/playness/ludens-gba-driver (optional for built-in cua)"
                  value={draft.driverPackage}
                  onChange={e => setDraft(prev => ({ ...prev, driverPackage: e.target.value }))}
                />
              </label>

              {/* Transport-specific fields */}
              {draft.transportKind === "stdio" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldStdioCommand")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      value={draft.stdioCommand}
                      onChange={e => setDraft(prev => ({ ...prev, stdioCommand: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldStdioArgs")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      placeholder="--display 1"
                      value={draft.stdioArgs}
                      onChange={e => setDraft(prev => ({ ...prev, stdioArgs: e.target.value }))}
                    />
                  </label>
                </div>
              )}

              {draft.transportKind === "bridge" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldBridgeHost")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      value={draft.bridgeHost}
                      onChange={e => setDraft(prev => ({ ...prev, bridgeHost: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldBridgePort")}</span>
                    <input
                      type="number"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      value={draft.bridgePort}
                      onChange={e => setDraft(prev => ({ ...prev, bridgePort: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs sm:col-span-2">
                    <span className="font-medium">{t("fieldBridgeGame")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      placeholder="/path/to/rom.gba (optional if emulator is started externally)"
                      value={draft.bridgeGame}
                      onChange={e => setDraft(prev => ({ ...prev, bridgeGame: e.target.value }))}
                    />
                  </label>
                </div>
              )}

              {draft.transportKind === "ssh" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
                  <label className="space-y-1 text-xs sm:col-span-2">
                    <span className="font-medium">{t("fieldSshHost")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      placeholder="192.168.1.100"
                      value={draft.sshHost}
                      onChange={e => setDraft(prev => ({ ...prev, sshHost: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldSshUser")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      placeholder="player"
                      value={draft.sshUser}
                      onChange={e => setDraft(prev => ({ ...prev, sshUser: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldSshPort")}</span>
                    <input
                      type="number"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      value={draft.sshPort}
                      onChange={e => setDraft(prev => ({ ...prev, sshPort: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">{t("fieldSshCommand")}</span>
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                      value={draft.sshCommand}
                      onChange={e => setDraft(prev => ({ ...prev, sshCommand: e.target.value }))}
                    />
                  </label>
                </div>
              )}

              {(draft.transportKind === "http" || draft.transportKind === "sse") && (
                <label className="block space-y-1 text-xs">
                  <span className="font-medium">{t("fieldHttpUrl")}</span>
                  <input
                    type="url"
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                    placeholder="http://127.0.0.1:8910/mcp"
                    value={draft.httpUrl}
                    onChange={e => setDraft(prev => ({ ...prev, httpUrl: e.target.value }))}
                  />
                </label>
              )}
            </div>
          )}

          {/* Machine Pool Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2" role="list" aria-label={t("poolSectionTitle")}>
            {machines.map(machine => {
              const isActive = bindingDraft.active === machine.id;
              const isAllowed = bindingDraft.allowed.includes(machine.id);
              const probe = probes[machine.id];
              const isBuiltin = machine.id === "local-desktop" || Boolean(machine.implicitForWorkspaceId);

              return (
                <div
                  key={machine.id}
                  role="listitem"
                  data-baseware-machine-card={machine.id}
                  className={
                    "flex flex-col justify-between gap-3 rounded-lg border p-4 transition-colors " +
                    (isActive ? "border-primary bg-primary/5" : "border-border bg-card")
                  }
                >
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <TransportIcon kind={machine.transport.kind} />
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="text-sm font-semibold">{machine.name}</h3>
                            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {machine.id}
                            </code>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="font-mono text-[10px] uppercase">
                          {machine.transport.kind}
                        </Badge>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {machine.driver}
                        </Badge>
                        {isActive && (
                          <Badge variant="default" className="text-[10px]">
                            {t("activeBadge")}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1 rounded-md bg-muted/40 p-2.5 font-mono text-xs">
                      <div className="truncate" title={formatTransportSummary(machine.transport)}>
                        {formatTransportSummary(machine.transport)}
                      </div>
                      {machine.driverPackage && (
                        <div className="truncate text-[11px] text-muted-foreground" title={machine.driverPackage}>
                          pkg: {machine.driverPackage}
                        </div>
                      )}
                    </div>

                    {probe && probe !== "probing" && (
                      <div
                        className={
                          "flex items-center gap-1.5 rounded px-2 py-1 text-xs " +
                          (probe.ok
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "bg-destructive/10 text-destructive")
                        }
                        data-baseware-probe-result={machine.id}
                      >
                        {probe.ok ? (
                          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span className="font-medium">{probe.ok ? t("probeOk") : t("probeFailed")}</span>
                        <span>({probe.latencyMs}ms)</span>
                        <span className="truncate">· {probe.detail}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs">
                    <span className="text-muted-foreground">
                      {isAllowed ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="size-3.5" aria-hidden="true" />
                          {t("authorizedForWorkspace")}
                        </span>
                      ) : (
                        <span>
                          {t("usedByWorkspaces").replace("{count}", String(machine.usedByWorkspaceIds.length))}
                        </span>
                      )}
                    </span>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => void handleProbeMachine(machine)}
                        disabled={probe === "probing"}
                        data-baseware-probe-btn={machine.id}
                      >
                        <Play className="size-3" aria-hidden="true" />
                        {probe === "probing" ? t("probing") : t("probe")}
                      </Button>
                      {project && !isActive && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => void handleQuickActivate(machine.id)}
                          disabled={savingBinding}
                          data-baseware-activate-btn={machine.id}
                        >
                          {t("bindAndActivate")}
                        </Button>
                      )}
                      {!machine.implicitForWorkspaceId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => openEditorWithDraft(draftFromMachine(machine), machine.id)}
                          aria-label={t("edit")}
                        >
                          <Edit3 className="size-3.5" aria-hidden="true" />
                        </Button>
                      )}
                      {!isBuiltin && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => void handleDeleteMachine(machine.id)}
                          aria-label={t("delete")}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Relocated Device Controllers Catalog & Driver Cache */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" data-baseware-section="controllers-catalog">
        <Card className="min-w-0 lg:col-span-8" data-capability-source="device">
          <CardContent className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <h2 className="flex items-center gap-2.5 text-base font-semibold">
                  <Monitor className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  {ct("groupTitles.device")}
                </h2>
                {caps && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{ct(`sourceStates.${caps.sources.device.status}`)}</Badge>
                    <span>
                      {caps.sources.device.status === "error" || caps.sources.device.status === "missing"
                        ? "—"
                        : String(deviceItems.length)}{" "}
                      {ct("capabilitiesUnit")}
                    </span>
                  </div>
                )}
              </div>
              <Button asChild variant="outline" size="sm">
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
            <p className="text-xs leading-relaxed text-muted-foreground">{ct("sourceDescriptions.device")}</p>
            {caps?.deviceSnapshot && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  {caps.deviceSnapshot.generatedAt ? (
                    <>
                      {ct("snapshotAt")}{" "}
                      <time dateTime={caps.deviceSnapshot.generatedAt}>
                        {new Date(caps.deviceSnapshot.generatedAt).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    ct("snapshotTimeUnknown")
                  )}
                </p>
                {caps.deviceSnapshot.drivers.length > 0 && (
                  <p className="break-words">
                    {ct("recordedDrivers")}:{" "}
                    {caps.deviceSnapshot.drivers
                      .map(driver => `${driver.id}${driver.version ? ` (${driver.version})` : ""}`)
                      .join(", ")}
                  </p>
                )}
              </div>
            )}
            {!caps ? (
              <p className="text-sm text-muted-foreground">{ct("loadingDesc")}</p>
            ) : caps.sources.device.status === "error" ? (
              <p className="text-sm text-destructive">{ct("sourceFailure")}</p>
            ) : deviceItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">{ct("sourceEmpty.device")}</p>
            ) : (
              <DeviceCapabilityDeclarations items={deviceItems} title={ct("groupTitles.device")} />
            )}
          </CardContent>
        </Card>

        {/* Cached Driver Packages (~/.ludens/cache/drivers) */}
        <Card className="min-w-0 lg:col-span-4" data-baseware-driver-cache>
          <CardContent className="min-w-0 space-y-4">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <HardDrive className="size-5 shrink-0 text-primary" aria-hidden="true" />
                {t("driverCacheTitle")}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("driverCacheDesc")}
              </p>
            </div>

            {!snapshot?.cachedDrivers.length ? (
              <p className="text-xs text-muted-foreground">{t("driverCacheEmpty")}</p>
            ) : (
              <ul className="space-y-2.5" role="list">
                {snapshot.cachedDrivers.map(entry => (
                  <li
                    key={`${entry.driverId}-${entry.cacheKey}`}
                    className="space-y-1 rounded-md border bg-muted/20 p-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <code className="font-semibold text-primary">{entry.driverId}</code>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        #{entry.cacheKey.slice(0, 8)}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11px]" title={entry.spec}>
                      {entry.spec}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground" title={entry.path}>
                      {entry.path}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
