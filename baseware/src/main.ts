#!/usr/bin/env bun
import { ludensHome } from "@ludens/protocol/ludens";
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { MACHINE_TRANSPORT_KINDS as TRANSPORTS, type MachineTransportKind } from "@ludens/protocol/machines";
import { cli, HELP } from "./cli.ts";
import { defaultSocket } from "./address.ts";
import { BasewareCore } from "./core.ts";
import type { Capabilities } from "./contracts.ts";
import { EventLog } from "./events.ts";
import { listen } from "./server.ts";
import { type DriverProvider } from "./drivers/registry.ts";
import { defaultDriverCacheRoot, resolveDriver } from "./drivers/loader.ts";

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
  } });
  if (!values.driver?.trim()) throw new Error("serve requires --driver <id>; emulator drivers also require --driver-package <spec>");
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
  let provider: DriverProvider | undefined;
  // Claim the address before touching a device; a second service must fail immediately.
  const closeServer = await listen(values.socket!, () => {
    if (!core) throw new Error("Baseware is starting");
    return core;
  });
  try {
    const serviceId = crypto.randomUUID();
    const clock = { id: serviceId, now: () => performance.now() };
    const log = new EventLog(dataDir, serviceId);
    provider = await registration.load({ port, host: values.host, command: values["cua-command"],
      transportMode, ssh, url: values.url, clock });
    core = new BasewareCore({ capabilities: provider.capabilities, record: log.record, serviceId, source: log.source,
      diagnostics: values.diagnostics, streamDir: join(dataDir, "stream"),
      streamPrefetch: process.env.LUDENS_BASEWARE_STREAM_PREFETCH !== "0",
      drivers: [{ id: registration.id, version: provider.version ?? registration.version ?? registration.fallbackVersion ?? "unknown",
        source: registration.source,
        ...(registration.transport ? { transport: registration.transport } : {}),
        ...(registration.defaultPort !== undefined ? { defaultPort: registration.defaultPort } : {}),
        ...(registration.needsGame ? { needsGame: true } : {}),
        ...(registration.launchHint ? { launchHint: registration.launchHint } : {}),
        ...(registration.launchCommand ? { launchCommand: registration.launchCommand } : {}),
        ...(registration.launchEnv ? { launchEnv: registration.launchEnv } : {}) }] });
    provider.onDisconnect(error => { void core!.disconnected(error); });
    core.record("service_start", { driver: values.driver, driverSource: registration.source,
      ...(port !== undefined ? { port } : {}), socket: values.socket, dataDir });
    console.log(JSON.stringify({ ready: true, socket: values.socket, dataDir, ...core.status() }));
    await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } finally {
    await closeServer();
    await core?.close();
    await provider?.close();
    core?.record("service_end", core.status());
  }
}

if (import.meta.main) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
