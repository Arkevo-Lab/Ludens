#!/usr/bin/env bun
import { ludensHome, readMachinesConfig } from "@ludens/protocol/ludens";
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { MACHINE_TRANSPORT_KINDS as TRANSPORTS, type BasewareMachineSpec, type MachineTransportKind } from "@ludens/protocol/machines";
import { cli, HELP } from "./cli.ts";
import { defaultSocket } from "./address.ts";
import { BasewareCore, type DriverInfo, type MachinesAction, type MountedMachineEntry } from "./core.ts";
import type { Capabilities, Clock } from "./contracts.ts";
import { EventLog } from "./events.ts";
import { listen } from "./server.ts";
import { type DriverCreateOptions, type DriverProvider, type DriverRegistration } from "./drivers/registry.ts";
import { defaultDriverCacheRoot, resolveDriver } from "./drivers/loader.ts";

interface MountedRuntime {
  spec: BasewareMachineSpec;
  registration: DriverRegistration;
  provider?: DriverProvider;
  connected: boolean;
  reason: string;
  isPrimary: boolean;
  resyncTimer?: ReturnType<typeof setInterval>;
}

function transportParams(spec: BasewareMachineSpec): Partial<DriverCreateOptions> {
  const transport = spec.transport;
  if (transport.kind === "bridge") return { port: transport.port, host: transport.host };
  if (transport.kind === "stdio") return { command: transport.command };
  if (transport.kind === "ssh") return { ssh: { host: transport.host, user: transport.user, port: transport.port, identityFile: transport.identityFile, command: transport.command } };
  return { url: transport.url, transportMode: transport.kind };
}

function driverInfo(registration: DriverRegistration, provider: DriverProvider): DriverInfo {
  return { id: registration.id, version: provider.version ?? registration.version ?? registration.fallbackVersion ?? "unknown",
    source: registration.source,
    ...(registration.transport ? { transport: registration.transport } : {}),
    ...(registration.defaultPort !== undefined ? { defaultPort: registration.defaultPort } : {}),
    ...(registration.needsGame ? { needsGame: true } : {}),
    ...(registration.launchHint ? { launchHint: registration.launchHint } : {}),
    ...(registration.launchCommand ? { launchCommand: registration.launchCommand } : {}),
    ...(registration.launchEnv ? { launchEnv: registration.launchEnv } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "--help") { console.log(HELP); return; }
  const socket = process.env.BASEWARE_SOCKET ?? await defaultSocket();
  if (args[0] === "mcp") { const { startMcp } = await import("./mcp.ts"); return startMcp(socket); }
  if (args[0] !== "serve") return cli(args, socket);
  const { values } = parseArgs({ args: args.slice(1), options: {
    driver: { type: "string" }, "driver-package": { type: "string" }, port: { type: "string" },
    socket: { type: "string", default: socket }, "data-dir": { type: "string" },
    "cua-command": { type: "string" }, diagnostics: { type: "string", default: "normal" },
    host: { type: "string" }, transport: { type: "string" }, url: { type: "string" },
    "ssh-host": { type: "string" }, "ssh-user": { type: "string" }, "ssh-port": { type: "string" },
    "ssh-identity": { type: "string" }, "ssh-command": { type: "string" },
    "machine-id": { type: "string" },
  } });
  if (!values.driver?.trim()) throw new Error("serve requires --driver <id>; emulator drivers also require --driver-package <spec>");
  const machineId = values["machine-id"] ?? process.env.LUDENS_MACHINE_ID ?? "primary";
  const registration = await resolveDriver(values.driver, values["driver-package"], defaultDriverCacheRoot());
  if (values["cua-command"] && registration.defaultPort !== undefined) throw new Error("--cua-command is only for drivers without a bridge port");
  if (values.diagnostics !== "normal" && values.diagnostics !== "full") throw new Error("--diagnostics must be normal or full");
  const transportMode = values.transport as MachineTransportKind | undefined;
  if (transportMode !== undefined && !TRANSPORTS.includes(transportMode)) {
    throw new Error(`--transport must be one of ${TRANSPORTS.join(", ")}`);
  }
  const sshPort = values["ssh-port"] === undefined ? undefined : Number(values["ssh-port"]);
  if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
    throw new Error("--ssh-port must be between 1 and 65535");
  }
  const portValue = values.port ?? registration.defaultPort;
  const port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--port must be between 1 and 65535");
  const ssh = values["ssh-host"] === undefined ? undefined : {
    host: values["ssh-host"], user: values["ssh-user"], port: sshPort,
    identityFile: values["ssh-identity"], command: values["ssh-command"],
  };
  const dataDir = resolve(values["data-dir"] ?? join(ludensHome(), "logs", "baseware", basename(values.socket!, ".sock")));
  let core: BasewareCore | undefined;
  // Claim the address before touching a device; a second service must fail immediately.
  const closeServer = await listen(values.socket!, () => {
    if (!core) throw new Error("Baseware is starting");
    return core;
  });
  const machines = new Map<string, MountedRuntime>();
  const serviceId = crypto.randomUUID();
  const clock: Clock = { id: serviceId, now: () => performance.now() };
  const stopResync = (id: string) => {
    const runtime = machines.get(id);
    if (runtime?.resyncTimer) { clearInterval(runtime.resyncTimer); runtime.resyncTimer = undefined; }
  };
  const mountedEntry = (runtime: MountedRuntime): MountedMachineEntry => ({ id: runtime.spec.id, label: runtime.spec.name,
    driver: runtime.spec.driver, transport: runtime.spec.transport.kind, connected: runtime.connected,
    reason: runtime.reason, isPrimary: runtime.isPrimary, capabilities: runtime.provider!.capabilities,
    drivers: [driverInfo(runtime.registration, runtime.provider!)] });
  const closeQuietly = async (provider?: DriverProvider): Promise<void> => { try { await provider?.close(); } catch { /* already dead */ } };
  const wireDisconnect = (runtime: MountedRuntime, provider: DriverProvider) => {
    provider.onDisconnect(error => {
      if (machines.get(runtime.spec.id) !== runtime || runtime.provider !== provider) return;
      runtime.connected = false;
      runtime.reason = error.message;
      core!.mountMachine(mountedEntry(runtime));
      void closeQuietly(provider);
      if (runtime.isPrimary) void core!.disconnected(error).catch(() => {});
      else core!.record("baseware_machine_disconnected", { machineId: runtime.spec.id, error: error.message });
      startResync(runtime.spec.id);
    });
  };
  const connectMachineSpec = async (spec: BasewareMachineSpec, isPrimary: boolean, existing?: DriverRegistration): Promise<MountedRuntime> => {
    const resolved = existing ?? await resolveDriver(spec.driver, spec.driverPackage, defaultDriverCacheRoot());
    const provider = await resolved.load({ ...transportParams(spec), clock });
    if (isPrimary) for (const m of machines.values()) m.isPrimary = false;
    const runtime: MountedRuntime = { spec, registration: resolved, provider, connected: true, reason: "connected", isPrimary };
    machines.set(spec.id, runtime);
    core!.mountMachine(mountedEntry(runtime));
    wireDisconnect(runtime, provider);
    return runtime;
  };
  const resyncMachine = async (id: string): Promise<boolean> => {
    const runtime = machines.get(id);
    if (!runtime || runtime.connected) return !!runtime?.connected;
    try {
      const provider = await runtime.registration.load({ ...transportParams(runtime.spec), clock });
      runtime.provider = provider;
      runtime.connected = true;
      runtime.reason = "reconnected";
      wireDisconnect(runtime, provider);
      core!.mountMachine(mountedEntry(runtime));
      if (runtime.isPrimary) core!.reconnected({ capabilities: provider.capabilities, machineId: id });
      else core!.reconnected({ machineId: id });
      core!.record("baseware_machine_reconnected", { machineId: id });
      stopResync(id);
      return true;
    } catch { return false; }
  };
  const startResync = (id: string) => {
    const runtime = machines.get(id);
    if (!runtime || runtime.resyncTimer) return;
    runtime.resyncTimer = setInterval(() => { void resyncMachine(id); }, 1000);
    runtime.resyncTimer.unref();
  };
  const machinesSnapshot = () => ({ activeMachineId: core!.status().activeMachineId ?? null, machines: core!.getMountedMachines() });
  const findSpec = async (id: string): Promise<BasewareMachineSpec> => {
    const spec = (await readMachinesConfig(ludensHome())).machines.find(machine => machine.id === id);
    if (!spec) throw new Error(`Unknown machine: ${id}; register it in ~/.ludens/machines.json`);
    return spec;
  };
  const onMachines = async (action: MachinesAction, { id, ids }: { id?: string; ids?: string[] }): Promise<unknown> => {
    if (action === "list") return { ...machinesSnapshot(), available: (await readMachinesConfig(ludensHome())).machines };
    if (action === "connect") {
      for (const target of ids ?? (id ? [id] : [])) {
        if (machines.get(target)?.connected) continue;
        const spec = await findSpec(target);
        const runtime = await connectMachineSpec(spec, false);
        // Join an existing lease: the freshly mounted controllers were not part of acquire().
        const status = core!.status();
        if (status.mode === "auto" && status.epoch) {
          for (const controller of runtime.provider!.capabilities.controllers.filter(c => c.requiresControl)) {
            await controller.acquire?.(status.epoch);
          }
        }
      }
      return machinesSnapshot();
    }
    if (action === "use") {
      if (!id) throw new Error("use requires a machine id");
      let runtime = machines.get(id);
      if (!runtime?.connected) {
        const spec = await findSpec(id);
        runtime = await connectMachineSpec(spec, true);
      } else {
        for (const m of machines.values()) m.isPrimary = m.spec.id === id;
      }
      core!.setPrimaryMachine(id);
      if (runtime.connected && !core!.status().connected) {
        core!.reconnected({ capabilities: runtime.provider!.capabilities, machineId: id });
      }
      core!.record("baseware_machine_switched", { machineId: id });
      return { activeMachineId: id, machines: core!.getMountedMachines() };
    }
    if (!id) throw new Error("disconnect requires a machine id");
    stopResync(id);
    const runtime = machines.get(id);
    machines.delete(id);
    core!.unmountMachine(id);
    await closeQuietly(runtime?.provider);
    return machinesSnapshot();
  };
  try {
    const log = new EventLog(dataDir, serviceId);
    const primarySpec: BasewareMachineSpec = { id: machineId, name: machineId, driver: values.driver!,
      ...(values["driver-package"] ? { driverPackage: values["driver-package"] } : {}),
      transport: ssh ? { kind: "ssh", host: ssh.host, user: ssh.user, port: ssh.port, identityFile: ssh.identityFile, command: ssh.command }
        : values.url ? { kind: transportMode === "sse" ? "sse" : "http", url: values.url }
        : values["cua-command"] ? { kind: "stdio", command: values["cua-command"] }
        : { kind: "bridge", port: port ?? 0, host: values.host },
      updatedAt: new Date().toISOString() };
    const onReconnect = async (targetId?: string): Promise<boolean> => {
      let ok = true;
      for (const id of targetId ? [targetId] : [...machines.keys()]) {
        const runtime = machines.get(id);
        if (!runtime || runtime.connected) continue;
        ok = await resyncMachine(id) && ok;
      }
      return ok;
    };
    const provider = await registration.load({ port, host: values.host, command: values["cua-command"],
      transportMode, ssh, url: values.url, clock });
    core = new BasewareCore({ capabilities: provider.capabilities, record: log.record, serviceId, source: log.source,
      diagnostics: values.diagnostics, streamDir: join(dataDir, "stream"),
      streamPrefetch: process.env.LUDENS_BASEWARE_STREAM_PREFETCH !== "0",
      activeMachineId: machineId, onReconnect, onMachines,
      drivers: [driverInfo(registration, provider)] });
    const primary: MountedRuntime = { spec: primarySpec, registration, provider, connected: true, reason: "connected", isPrimary: true };
    machines.set(machineId, primary);
    core.mountMachine(mountedEntry(primary));
    wireDisconnect(primary, provider);
    core.record("service_start", { driver: values.driver, driverSource: registration.source,
      ...(port !== undefined ? { port } : {}), socket: values.socket, dataDir, machineId });
    console.log(JSON.stringify({ ready: true, socket: values.socket, dataDir, ...core.status() }));
    await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } finally {
    for (const id of [...machines.keys()]) stopResync(id);
    await closeServer();
    await core?.close();
    for (const runtime of machines.values()) await closeQuietly(runtime.provider);
    core?.record("service_end", core.status());
  }
}

if (import.meta.main) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
