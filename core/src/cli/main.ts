#!/usr/bin/env bun
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { cli, HELP } from "./control-cli.ts";
import { Runtime } from "../core/shiori/runtime.ts";
import { listen } from "../daemon/transport.ts";
import { connectBaseware } from "../core/subsystems/baseware.ts";
import { createHostRuntime } from "../core/shiori/host.ts";
import { defaultSocket } from "@ludens/baseware/address";
import { writeCapabilityDocument } from "@ludens/baseware/catalog";
import { EventLog, EVENT_SCHEMA_VERSION } from "../core/storage/events.ts";
import { runProvenance } from "../core/storage/provenance.ts";
import { readCurrentSession, resolveWorkspaceAddress, resolveWorkspaceState } from "../core/storage/workspace-state.ts";
import { validateSessionWorkspace } from "../core/agent-omp/workspace-session.ts";
import perceptionTemplate from "../../templates/perception.py" with { type: "text" };
import { ludensHome, registerWorkspace } from "@ludens/protocol/ludens";
import { evalCommand } from "./eval-cli.ts";
import { eventCommand } from "./event-cli.ts";

const globalHome = ludensHome();
let exit: (code: number) => void | Promise<void> = code => process.exit(code);

const RUN_HELP = `ludens-core [--workspace <path>] run [--baseware-socket <path>] [--workspace <path>] [--device-only] [--model <provider/model>] [--resume <session.jsonl> | --new-session] [--compaction-threshold <tokens>] [--diagnostics normal|full] [--launched-by app|cli]
Each workspace keeps its sessions in .ludens/shiori/; --new-session starts fresh without deleting workspace files.
The current directory is the default workspace. Run logs go to <workspace>/logs/<run-id>/.
--resume selects an existing session from the same workspace, then remembers it for future starts.
--compaction-threshold configures OMP's native compaction trigger; default follows the selected model's native OMP setting.
--diagnostics normal|full selects recording detail at startup (default normal).
Perception starts empty. Implement workspace/perception.py and use ludens-core perception reload.
ludens-core perception inject off disables automatic context attachment while sampling and recording continue.
Hardware and device bridges are provided by an independent Baseware integration service. Its default socket is derived from the workspace.`;

async function main() {
  const args = process.argv.slice(2);
  let selectedWorkspace = process.env.LUDENS_WORKSPACE ?? process.cwd();

  while (args.length > 0 && args[0]!.startsWith("--") && args[0] !== "--help") {
    const flag = args[0]!;
    if (flag === "--workspace") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("--workspace requires a path");
      selectedWorkspace = args[1];
      args.splice(0, 2);
      continue;
    }
    if (flag.startsWith("--workspace=")) {
      selectedWorkspace = flag.slice("--workspace=".length);
      if (!selectedWorkspace) throw new Error("--workspace requires a path");
      args.splice(0, 1);
      continue;
    }
    break;
  }

  if (!args.length || args[0] === "--help" || args[0] === "-h" || (args[0] === "run" && args.includes("--help"))) {
    console.log(`${RUN_HELP}\n\n${HELP}`);
    return;
  }

  if (args[0] === "eval") return evalCommand(args.slice(1), selectedWorkspace);
  if (args[0] === "event") {
    const socket = process.env.LUDENS_SOCKET ?? (await resolveWorkspaceAddress(selectedWorkspace)).socket;
    return eventCommand(args.slice(1), selectedWorkspace, socket, globalHome);
  }
  if (args[0] !== "run") {
    const socket = process.env.LUDENS_SOCKET ?? (await resolveWorkspaceAddress(selectedWorkspace)).socket;
    return cli(args, socket);
  }

  const { values } = parseArgs({ args: args.slice(1), options: {
    workspace: { type: "string", default: selectedWorkspace },
    "baseware-socket": { type: "string" },
    "device-only": { type: "boolean", default: false },
    model: { type: "string" },
    resume: { type: "string" },
    "new-session": { type: "boolean", default: false },
    "compaction-threshold": { type: "string" },
    diagnostics: { type: "string", default: "normal" },
    "launched-by": { type: "string" },
  } });
  if (values.diagnostics !== "normal" && values.diagnostics !== "full") throw new Error("--diagnostics must be normal|full");
  const diagnostics = values.diagnostics;
  const rawLaunchedBy = values["launched-by"] ?? process.env.LUDENS_LAUNCHED_BY ?? "cli";
  if (rawLaunchedBy !== "app" && rawLaunchedBy !== "cli") throw new Error("--launched-by must be app|cli");
  const launchedBy = rawLaunchedBy;
  const compactionThreshold = values["compaction-threshold"] === undefined ? undefined : Number(values["compaction-threshold"]);
  if (compactionThreshold !== undefined && (!Number.isInteger(compactionThreshold) || compactionThreshold <= 0)) {
    throw new Error("--compaction-threshold must be a positive integer");
  }
  if (values.resume && values["new-session"]) throw new Error("Use either --resume or --new-session");
  if (values["device-only"] && (values.resume || values["new-session"])) throw new Error("Session options require an agent");
  const state = await resolveWorkspaceState(values.workspace!, globalHome);
  const workspace = state.workspace;
  await registerWorkspace(workspace, globalHome);
  const socket = process.env.LUDENS_SOCKET ?? state.socket;
  const runId = new Date().toISOString().replaceAll(":", "-");
  const runDir = join(workspace, "logs", runId);
  const basewareSocket = values["baseware-socket"] ?? process.env.BASEWARE_SOCKET ?? await defaultSocket(workspace);
  let devices: Awaited<ReturnType<typeof connectBaseware>> | undefined;
  let runtime: Runtime | undefined;
  let log: EventLog | undefined;
  let ready = false;
  const closeServers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    ready = false;
    try { await runtime?.close(); }
    finally {
      devices?.close();
      for (const closeServer of closeServers.reverse()) await closeServer();
      if (runtime) log?.record("run_end", runtime.status());
    }
  })();
  let unregisterCleanup: (() => void) | undefined;
  try {
    const getRuntime = () => {
      if (!ready || !runtime) throw new Error("Host is starting or closing");
      return runtime;
    };
    closeServers.push(await listen(state.socket, getRuntime));
    if (socket !== state.socket) closeServers.push(await listen(socket, getRuntime));
    const resume = values["device-only"] || values["new-session"] ? undefined
      : values.resume ? await realpath(resolve(values.resume)) : await readCurrentSession(state);
    if (resume) await validateSessionWorkspace(resume, workspace);
    process.chdir(workspace);
    await mkdir(state.sessionsDir, { recursive: true });
    await mkdir(join(workspace, "skills"), { recursive: true });
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(workspace, "perception.py"), perceptionTemplate, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const clock = { id: runId, now: () => performance.now() };
    log = new EventLog(runDir, clock, workspace, diagnostics);
    log.record("run_start", { workspace, workspaceId: state.id, diagnostics });
    devices = await connectBaseware({ socket: basewareSocket, runDir, record: log.record });
    await writeCapabilityDocument(devices.catalog, join(workspace, "baseware.json"));
    const configuredModel = values.model ?? await Bun.file(join(workspace, "ludens.json")).json()
      .then((cfg: Record<string, unknown>) => typeof cfg?.model === "string" && cfg.model.trim() ? cfg.model.trim() : undefined)
      .catch(() => undefined);
    const model = configuredModel ?? "openai-codex/gpt-6.2-sol";
    if (!values["device-only"]) {
      const postmortem = await import("@oh-my-pi/pi-utils/postmortem");
      unregisterCleanup = postmortem.register("ludens-run", close, { exitOnly: true });
      exit = postmortem.quit;
    }
    runtime = await createHostRuntime({ devices, workspace, state, runDir, log, resume,
      ludensSocket: socket, basewareSocket, model: values["device-only"] ? undefined : model,
      compactionThreshold, launchedBy });
    devices.onHandback(reason => { void runtime!.stop(reason); });
    devices.onDisconnect(error => { void runtime!.disconnected(error); });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace, workspaceId: state.id, stateDir: state.dir, socket,
      drivers: devices.catalog.drivers, basewareSocket, omp: "18.22.2", eventSchemaVersion: EVENT_SCHEMA_VERSION,
      logging: { diagnostics, basewareDiagnostics: devices.diagnostics }, eventSources: devices.eventSources,
      shiori: values["device-only"] ? null : { implementation: "omp", implementationVersion: "18.22.2" },
      provenance: await runProvenance(workspace), model: values["device-only"] ? null : model,
      resume, perception: { entry: "perception.py:Perception" }, compactionThreshold: compactionThreshold ?? null }, null, 2));
    ready = true;
    await runtime.perception!.reload();
    console.log(JSON.stringify({ ready: true, socket, workspace, stateDir: state.dir, runDir, ...runtime.status() }, null, 2));
    const interrupt = Promise.withResolvers<NodeJS.Signals>();
    process.once("SIGINT", () => interrupt.resolve("SIGINT"));
    process.once("SIGTERM", () => interrupt.resolve("SIGTERM"));
    shutdownSignal = await interrupt.promise;
  } finally {
    try { await close(); }
    finally { unregisterCleanup?.(); }
  }
}

let shutdownSignal: NodeJS.Signals | undefined;
main().then(() => exit(shutdownSignal === "SIGTERM" ? 143 : shutdownSignal === "SIGINT" ? 130 : Number(process.exitCode ?? 0)), (error) => { console.error(String(error)); return exit(1); });
