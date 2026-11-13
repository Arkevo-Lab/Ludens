"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  Wrench,
  X,
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
  bridgeGame: "/Users/ame/2610dev/playness/roms/gba/games/pokemon-green/pokemon-green.gba",
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

type PoolFilter = "all" | "allowed" | "mounted";
type InspectorTab = "controllers" | "daemon";

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
  const isEn = locale === "en";

  const [snapshot, setSnapshot] = useState<WorkspaceBasewareSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyMachineId, setBusyMachineId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState("");

  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("controllers");

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
      setSnapshot(prevSnap => {
        const workspaceChanged = prevSnap?.workspaceId !== next.workspaceId;
        setSelectedMachineId(prev => {
          if (!workspaceChanged && prev && next.machines.some(m => m.id === prev)) return prev;
          return next.binding.active ?? next.machines[0]?.id ?? null;
        });
        return next;
      });
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
  const rawDeviceItems = useMemo(
    () => caps?.groups.find(group => group.id === "device")?.items ?? [],
    [caps],
  );
  const deviceGuideHref = "/?" + new URLSearchParams({
    view: "docs",
    doc: "tutorials/devices",
    docLang: locale,
    ...(project ? { project } : {}),
  });

  const machines = useMemo(
    () => (snapshot?.machines ?? []).filter(m => m.id !== "workspace-default"),
    [snapshot?.machines],
  );
  const binding: WorkspaceMachinesBinding = snapshot?.binding ?? {
    active: "local-desktop",
    allowed: ["local-desktop"],
  };
  const daemon = snapshot?.daemon;
  const mountedMap = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<NonNullable<WorkspaceBasewareSnapshot["daemon"]["status"]>["mountedMachines"]>[number]
    >();
    for (const item of daemon?.status?.mountedMachines ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [daemon?.status?.mountedMachines]);

  const filteredMachines = useMemo(() => {
    const activeId = daemon?.status?.activeMachineId ?? binding.active;
    return machines
      .filter(machine => {
        if (poolFilter === "allowed") return binding.allowed.includes(machine.id);
        if (poolFilter === "mounted") return mountedMap.has(machine.id);
        return true;
      })
      .sort((a, b) => {
        const aPrimary = a.id === activeId ? 1 : 0;
        const bPrimary = b.id === activeId ? 1 : 0;
        if (aPrimary !== bPrimary) return bPrimary - aPrimary;
        const aMounted = mountedMap.has(a.id) ? 1 : 0;
        const bMounted = mountedMap.has(b.id) ? 1 : 0;
        if (aMounted !== bMounted) return bMounted - aMounted;
        return 0;
      });
  }, [machines, poolFilter, binding.allowed, binding.active, daemon?.status?.activeMachineId, mountedMap]);

  const selectedMachine = useMemo(
    () => machines.find(m => m.id === selectedMachineId) ?? filteredMachines[0] ?? machines[0] ?? null,
    [machines, filteredMachines, selectedMachineId],
  );

  // Deduplicate controller items for the selected machine in the right-hand inspector
  const selectedMachineControllers = useMemo(() => {
    if (!selectedMachine) return [];
    const prefix = `controller/${selectedMachine.id}/`;
    const prefixed = rawDeviceItems.filter(item => item.id.startsWith(prefix));
    if (prefixed.length > 0) {
      return prefixed.map(item => ({
        ...item,
        id: `controller/${item.id.slice(prefix.length)}`,
      }));
    }
    const activeId = daemon?.status?.activeMachineId ?? binding.active;
    if (selectedMachine.id === activeId && (mountedMap.size === 0 || mountedMap.has(selectedMachine.id))) {
      return rawDeviceItems.filter(item => !item.id.slice("controller/".length).includes("/"));
    }
    return [];
  }, [rawDeviceItems, selectedMachine, daemon?.status?.activeMachineId, binding.active, mountedMap]);

  const handleControlMachine = async (
    operation: "setPrimary" | "toggleAllowed" | "mount" | "unmount" | "reconnect",
    machineId: string,
  ) => {
    if (!project) return;
    setBusyMachineId(machineId);
    setActionNotice("");
    setError("");
    try {
      const response = await fetch("/api/baseware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "controlWorkspaceMachine",
          workspaceId: project,
          operation,
          machineId,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("saveBindingFailed"));
      const next = result as WorkspaceBasewareSnapshot;
      setSnapshot(next);
      setSelectedMachineId(machineId);
      const labelMap: Record<typeof operation, string> = isEn
        ? {
            setPrimary: `Switched primary target to ${machineId}`,
            toggleAllowed: `Updated workspace access for ${machineId}`,
            mount: `Mounted ${machineId} to live Baseware`,
            unmount: `Unmounted ${machineId} from Baseware`,
            reconnect: `Triggered reconnect for ${machineId}`,
          }
        : {
            setPrimary: `已将 ${machineId} 设为当前主控节点`,
            toggleAllowed: `已更新 ${machineId} 的工作区访问权限`,
            mount: `已将 ${machineId} 并发挂载至当前 Baseware`,
            unmount: `已从当前 Baseware 卸载 ${machineId}`,
            reconnect: `已触发 ${machineId} 重新连接`,
          };
      setActionNotice(labelMap[operation]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyMachineId(null);
    }
  };

  const handleProbeMachine = async (machine: BasewareMachineRuntimeStatus) => {
    setProbes(prev => ({ ...prev, [machine.id]: "probing" }));
    try {
      const response = await fetch("/api/baseware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probeMachine", id: machine.id }),
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
      setSelectedMachineId(spec.id);
      await loadOverview(project);
    } catch (cause) {
      setMachineError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingMachine(false);
    }
  };

  const handleDeleteMachine = async (machineId: string) => {
    if (machineId === "local-desktop") return;
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

  const mountedCount = daemon?.status?.mountedMachines?.length ?? 0;
  const connectedMountedCount =
    daemon?.status?.mountedMachines?.filter(item => item.connected).length ?? 0;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-5" data-baseware-view>
      {/* Clean Compact Header with Live Status Strip */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Cpu className="size-6 text-primary" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            {/* Live Baseware Daemon Status Pill */}
            <div
              className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium"
              data-baseware-summary
            >
              <span
                className={
                  "inline-block size-2 rounded-full " +
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
                    ? isEn
                      ? "Device Disconnected / Resyncing"
                      : "设备断联 · 自动重连同步中"
                    : t("daemonOffline")}
              </span>
              {mountedCount > 0 && (
                <span className="border-l border-border pl-2 font-mono text-[11px] text-muted-foreground">
                  {isEn
                    ? `${connectedMountedCount}/${mountedCount} mounted`
                    : `已挂载 ${connectedMountedCount}/${mountedCount} 台`}
                </span>
              )}
            </div>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {isEn
              ? "Manage all local and remote controlled nodes in one place. Click any node to inspect its controllers, or toggle workspace access and live multi-device mounting with one click."
              : "集中管理本机或远端受控节点（TCP Bridge 模拟器、stdio 桌面 CUA、SSH 远端主机、HTTP/SSE MCP）。即点即切换工作区主控目标或并发挂载多台设备，点击任一节点即可在右侧检视其控制器能力。"}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actionNotice && (
            <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {actionNotice}
            </span>
          )}
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

      {/* Master-Detail Two-Column Workbench */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
        {/* Left 7 Cols: Single Unified Machine Pool List */}
        <div className="min-w-0 space-y-3 lg:col-span-7" data-baseware-section="machine-pool">
          {/* Filter Tabs & Current Workspace Context Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="节点筛选">
              <button
                type="button"
                role="tab"
                aria-selected={poolFilter === "all"}
                onClick={() => setPoolFilter("all")}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                  (poolFilter === "all"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {isEn ? "All Nodes" : "全部节点"} ({machines.length})
              </button>
              {project && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={poolFilter === "allowed"}
                  onClick={() => setPoolFilter("allowed")}
                  className={
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                    (poolFilter === "allowed"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground")
                  }
                >
                  {isEn ? "Workspace Allowed" : "当前工作区可用"} ({binding.allowed.length})
                </button>
              )}
              {mountedCount > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={poolFilter === "mounted"}
                  onClick={() => setPoolFilter("mounted")}
                  className={
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                    (poolFilter === "mounted"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground")
                  }
                >
                  {isEn ? "Live Mounted" : "实时已挂载"} ({mountedCount})
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link2 className="size-3.5 text-primary" aria-hidden="true" />
              <span>
                {snapshot?.workspaceName
                  ? isEn
                    ? `Workspace: ${snapshot.workspaceName}`
                    : `当前工作区：${snapshot.workspaceName}`
                  : t("noWorkspaceSelected")}
              </span>
            </div>
          </div>

          {/* Unified Machine Cards (Each Machine Rendered Once) */}
          <div className="space-y-3" role="list" aria-label={t("poolSectionTitle")}>
            {filteredMachines.map(machine => {
              const isSelected = selectedMachine?.id === machine.id;
              const isAllowed = binding.allowed.includes(machine.id);
              const mounted = mountedMap.get(machine.id);
              const isPrimaryActive = mounted
                ? mounted.isPrimary
                : binding.active === machine.id;
              const probe = probes[machine.id];
              const isBuiltin = machine.id === "local-desktop";
              const isBusy = busyMachineId === machine.id;

              return (
                <div
                  key={machine.id}
                  role="listitem"
                  data-baseware-machine-card={machine.id}
                  onClick={() => setSelectedMachineId(machine.id)}
                  className={
                    "group cursor-pointer rounded-xl border p-4 transition-all " +
                    (isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border bg-card hover:border-primary/40")
                  }
                >
                  {/* Row 1: Identity & Live Status Badges */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                        <TransportIcon kind={machine.transport.kind} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold">{machine.name}</h3>
                          <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {machine.id}
                          </code>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
                          <span className="uppercase">{machine.transport.kind}</span>
                          <span>·</span>
                          <span>{machine.driver}</span>
                          <span>·</span>
                          <span className="truncate" title={formatTransportSummary(machine.transport)}>
                            {formatTransportSummary(machine.transport)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Live Connection / Role Badges */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {mounted ? (
                        <span
                          className={
                            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium " +
                            (mounted.connected
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400")
                          }
                        >
                          <span
                            className={
                              "size-1.5 rounded-full " +
                              (mounted.connected ? "bg-emerald-500" : "bg-rose-500")
                            }
                          />
                          {mounted.isPrimary
                            ? mounted.connected
                              ? isEn
                                ? "Primary · Connected"
                                : "★ 当前主控 · 已连接"
                              : isEn
                                ? "Primary · Disconnected"
                                : "★ 当前主控 · 断联重连中"
                            : mounted.connected
                              ? isEn
                                ? "Co-Mounted · Connected"
                                : "已并发挂载"
                              : isEn
                                ? "Co-Mounted · Disconnected"
                                : "并发挂载 · 断联"}
                        </span>
                      ) : isPrimaryActive ? (
                        <Badge variant="default" className="text-[11px]">
                          {isEn ? "★ Default Primary" : "★ 默认主控"}
                        </Badge>
                      ) : null}
                    </div>
                  </div>

                  {/* Optional Probe Result Banner */}
                  {probe && probe !== "probing" && (
                    <div
                      className={
                        "mt-2.5 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs " +
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

                  {/* Row 2: Instant 1-Click Workspace Controls & Node Utilities */}
                  <div
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs"
                    onClick={e => e.stopPropagation()}
                  >
                    {/* Left: Instant Workspace Authorization Toggle */}
                    {project ? (
                      <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                        <input
                          type="checkbox"
                          checked={isAllowed}
                          disabled={isBusy || (isAllowed && binding.allowed.length <= 1)}
                          onChange={() => void handleControlMachine("toggleAllowed", machine.id)}
                          data-baseware-allowed-checkbox={machine.id}
                          className="rounded border-border"
                        />
                        <span
                          className={
                            isAllowed
                              ? "font-medium text-emerald-600 dark:text-emerald-400"
                              : "text-muted-foreground"
                          }
                        >
                          {isAllowed
                            ? isEn
                              ? "Authorized for workspace"
                              : "允许当前工作区访问"
                            : isEn
                              ? "Authorize for workspace"
                              : "未授权给当前工作区"}
                        </span>
                      </label>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("usedByWorkspaces").replace("{count}", String(machine.usedByWorkspaceIds.length))}
                      </span>
                    )}

                    {/* Right: Direct 1-Click Actions */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {project && mounted && !mounted.connected && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={isBusy}
                          onClick={() => void handleControlMachine("reconnect", machine.id)}
                        >
                          <RefreshCw className="size-3" aria-hidden="true" />
                          {isEn ? "Reconnect" : "立即重连"}
                        </Button>
                      )}

                      {project && !isPrimaryActive && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          disabled={isBusy}
                          onClick={() => void handleControlMachine("setPrimary", machine.id)}
                          data-baseware-activate-btn={machine.id}
                        >
                          <Star className="size-3" aria-hidden="true" />
                          {isEn ? "Set Primary" : "设为主控"}
                        </Button>
                      )}

                      {project && daemon?.status && !mounted?.isPrimary && (
                        mounted ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            disabled={isBusy}
                            onClick={() => void handleControlMachine("unmount", machine.id)}
                            data-baseware-unmount-btn={machine.id}
                          >
                            <Unplug className="size-3" aria-hidden="true" />
                            {isEn ? "Unmount" : "断开挂载"}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            disabled={isBusy}
                            onClick={() => void handleControlMachine("mount", machine.id)}
                            data-baseware-mount-btn={machine.id}
                          >
                            <PlugIcon className="size-3" aria-hidden="true" />
                            {isEn ? "Co-Mount" : "并发挂载"}
                          </Button>
                        )
                      )}

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => void handleProbeMachine(machine)}
                        disabled={probe === "probing"}
                        data-baseware-probe-btn={machine.id}
                      >
                        <Play className="size-3" aria-hidden="true" />
                        {probe === "probing" ? t("probing") : t("probe")}
                      </Button>

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
        </div>

        {/* Right 5 Cols: Contextual Machine & Daemon Inspector */}
        <div className="min-w-0 lg:sticky lg:top-[calc(1rem+var(--shell-topbar-height,0px))] lg:col-span-5" data-baseware-section="controllers-catalog">
          <Card className="min-w-0" data-capability-source="device">
            <CardContent className="min-w-0 space-y-4 p-4">
              {/* Inspector Mode Switcher */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex items-center gap-1.5" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === "controllers"}
                    onClick={() => setInspectorTab("controllers")}
                    className={
                      "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors " +
                      (inspectorTab === "controllers"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground")
                    }
                  >
                    <Monitor className="size-3.5" aria-hidden="true" />
                    {isEn ? "Node & Controllers" : "节点检视与控制器"}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === "daemon"}
                    onClick={() => setInspectorTab("daemon")}
                    className={
                      "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors " +
                      (inspectorTab === "daemon"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground")
                    }
                  >
                    <Activity className="size-3.5" aria-hidden="true" />
                    {isEn ? "Daemon & Drivers" : "守护进程与缓存"}
                  </button>
                </div>

                <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 whitespace-nowrap px-2 text-xs">
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
                selectedMachine ? (
                  <div className="space-y-4">
                    {/* Selected Node Summary Box */}
                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-semibold">
                          <TransportIcon kind={selectedMachine.transport.kind} />
                          <span>{selectedMachine.name}</span>
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
                          {isEn ? "Multi-Device CLI Routing" : "多机指定调用示例"}
                        </div>
                        <code className="text-foreground">
                          ludens controller controller/{selectedMachine.id}/screen.capture
                        </code>
                      </div>
                    </div>

                    {/* Scoped Device Controllers for this Node */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-muted-foreground uppercase tracking-wider">
                          {ct("groupTitles.device")} ({selectedMachineControllers.length})
                        </span>
                        {caps?.deviceSnapshot?.drivers.length ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {caps.deviceSnapshot.drivers
                              .map(d => `${d.id}${d.version ? ` (${d.version})` : ""}`)
                              .join(", ")}
                          </span>
                        ) : null}
                      </div>

                      {!caps ? (
                        <p className="text-xs text-muted-foreground">{ct("loadingDesc")}</p>
                      ) : caps.sources.device.status === "error" ? (
                        <p className="text-xs text-destructive">{ct("sourceFailure")}</p>
                      ) : selectedMachineControllers.length === 0 ? (
                        mountedMap.size > 0 && !mountedMap.has(selectedMachine.id) ? (
                          <div className="space-y-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                            <p>
                              {isEn
                                ? `Node "${selectedMachine.id}" is not currently mounted in the running Baseware daemon.`
                                : `节点「${selectedMachine.id}」当前未挂载到工作区 Baseware 守护进程中。`}
                            </p>
                            {project && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={busyMachineId === selectedMachine.id}
                                onClick={() => void handleControlMachine("mount", selectedMachine.id)}
                              >
                                <PlugIcon className="size-3" aria-hidden="true" />
                                {isEn ? "Mount to Live Baseware" : "立即并发挂载此节点"}
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
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {isEn ? "Select a node on the left to inspect its details." : "请点击左侧任一受控节点查看详情。"}
                  </p>
                )
              ) : (
                /* Tab 2: Live Baseware Daemon & Cached Driver Packages */
                <div className="space-y-4" data-baseware-driver-cache>
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
                            : t("externalOrUnregistered")}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">{t("epochLabel")}</dt>
                        <dd className="font-mono text-[11px]">{daemon?.status?.epoch ?? "—"}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="space-y-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <HardDrive className="size-3.5 text-primary" aria-hidden="true" />
                      {t("driverCacheTitle")}
                    </h3>
                    {!snapshot?.cachedDrivers.length ? (
                      <p className="text-xs text-muted-foreground">{t("driverCacheEmpty")}</p>
                    ) : (
                      <ul className="space-y-2 text-xs" role="list">
                        {snapshot.cachedDrivers.map(cached => (
                          <li
                            key={`${cached.driverId}:${cached.cacheKey}`}
                            className="space-y-1 rounded-md border bg-muted/20 p-2.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold">{cached.driverId}</span>
                              <code className="text-[11px] text-muted-foreground">
                                {cached.cacheKey.slice(0, 12)}
                              </code>
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground" title={cached.spec}>
                              {cached.spec}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Clean Modal Dialog for Registering / Editing a Controlled Node */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-label={editingId ? `${t("editMachineTitle")}: ${editingId}` : t("newMachineTitle")}
          data-baseware-editor
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-3">
              <div>
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <Wrench className="size-4 text-primary" aria-hidden="true" />
                  {editingId ? `${t("editMachineTitle")}: ${editingId}` : t("newMachineTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {isEn
                    ? "Choose a preset template or configure custom transport parameters."
                    : "可点击下方快速预设一键填入模板，或自定义节点传输协议参数。"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setEditorOpen(false);
                  setEditingId(null);
                  setDraftProbe(null);
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>

            {/* Quick Presets Bar inside Modal */}
            {!editingId && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
                  {isEn ? "Presets:" : "快速模板："}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDraft(GBA_PRESET_DRAFT)}
                  data-baseware-preset="gba-mgba"
                >
                  <Gamepad2 className="size-3.5" aria-hidden="true" />
                  {t("presetGbaMgba")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDraft(SSH_PRESET_DRAFT)}
                  data-baseware-preset="ssh-cua"
                >
                  <Server className="size-3.5" aria-hidden="true" />
                  {t("presetRemoteSsh")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDraft(HTTP_PRESET_DRAFT)}
                  data-baseware-preset="http-mcp"
                >
                  <Globe className="size-3.5" aria-hidden="true" />
                  {t("presetHttpMcp")}
                </Button>
              </div>
            )}

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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                <label className="space-y-1 text-xs sm:col-span-3">
                  <span className="font-medium">{t("fieldBridgeGame")}</span>
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs"
                    placeholder="/path/to/rom.gba (optional)"
                    value={draft.bridgeGame}
                    onChange={e => setDraft(prev => ({ ...prev, bridgeGame: e.target.value }))}
                  />
                </label>
              </div>
            )}

            {draft.transportKind === "ssh" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
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

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleProbeDraft()}
                disabled={draftProbe === "probing" || !draft.id.trim()}
              >
                <Play className="size-3.5" aria-hidden="true" />
                {draftProbe === "probing" ? t("probing") : t("probeConnection")}
              </Button>
              <div className="flex items-center gap-2">
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
          </div>
        </div>
      )}
    </div>
  );
}
