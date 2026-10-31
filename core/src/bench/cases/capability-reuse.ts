import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunEvents } from "@ludens/protocol/event-sources";
import { freezeReuseEvents } from "../fixtures/reuse-facts.ts";
import { EventLog as DeviceEventLog } from "../../../../baseware/src/events.ts";
import { atomicJson } from "../../core/storage/store.ts";
import { BasewareCore } from "@ludens/baseware/core";
import { writeCapabilityDocument } from "@ludens/baseware/catalog";
import { listen as listenBaseware } from "@ludens/baseware/server";
import { connectBaseware } from "../../core/subsystems/baseware.ts";
import { createHostRuntime } from "../../core/shiori/host.ts";
import { PythonCapabilities } from "../../core/subsystems/python-capabilities.ts";
import { Runtime } from "../../core/shiori/runtime.ts";
import { listen as listenLudens } from "../../daemon/transport.ts";
import { initializeWorkspaceState } from "../../core/storage/workspace-state.ts";
import type { RecordEvent } from "../../core/storage/events.ts";
import type { BenchmarkContext } from "../types.ts";
import { ReuseEnvironment } from "../fixtures/reuse-environment.ts";
import perceptionTemplate from "../../../templates/perception.py" with { type: "text" };

async function workspaceBaseline(workspace: string) {
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(workspace, path), { withFileTypes: true })) {
      const relative = join(path, entry.name);
      if (!path && entry.name === "logs") continue;
      if (entry.isDirectory()) await walk(relative);
      else files.push(relative);
    }
  }
  await walk("");
  const pythonFiles = files.filter(path => path.endsWith(".py"));
  const experienceFiles = files.filter(path => path.startsWith("skills/") || path.startsWith("memory/")).length;
  if (pythonFiles.length || experienceFiles) throw new Error("capability-reuse requires a new workspace with empty skills, memory, and no Python files");
  return { pythonFiles, experienceFiles };
}

/** Real Shiori + production CLI/API + a tiny simulated device, never a scripted agent. */
export async function run(ctx: BenchmarkContext): Promise<Record<string, unknown>> {
  ctx.signal?.throwIfAborted();
  const baseline = await workspaceBaseline(ctx.workspace);
  const recordBenchmark = ctx.log.recorder({ component: "benchmark", implementation: "assembly-bench", implementationVersion: "1" });
  const environment = new ReuseEnvironment(ctx.seed, join(ctx.runDir, "bench-frames"), recordBenchmark);
  const state = await initializeWorkspaceState(ctx.workspace);
  const prefix = `/tmp/ludens-bench-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, ludensSocket = `${prefix}-r.sock`;
  let runtime: Runtime | undefined;
  const record: RecordEvent = (type, data, trace, metadata) => {
    ctx.log.record(type, data, trace, metadata);
    if (type === "control" && (data as { mode?: string }).mode === "auto") {
      recordBenchmark("benchmark_reuse_workspace", { ...baseline, session: "new" }, trace);
      environment.begin(trace ?? {});
    }
    if (type === "tool_end") {
      environment.afterExec(trace ?? {});
      // The operation has returned to the agent (including wait/read after a
      // background job); now stop without cancelling its final tool result.
      if (environment.done) queueMicrotask(() => { void runtime?.stop("benchmark tasks completed"); });
    }
  };
  const deviceLog = new DeviceEventLog(join(ctx.runDir, "device-sources"), crypto.randomUUID());
  const core = new BasewareCore({ serviceId: deviceLog.source.sourceId, source: deviceLog.source, record: deviceLog.record,
    diagnostics: ctx.log.diagnostics, capabilities: environment.capabilities,
    drivers: [{ id: "benchmark-assembly-bench", version: "1" }] });
  let closeBaseware: (() => Promise<void>) | undefined;
  let closeLudens: (() => Promise<void>) | undefined;
  let devices: Awaited<ReturnType<typeof connectBaseware>> | undefined;
  let epoch: string | undefined;
  const cancel = () => { void runtime?.stop("benchmark cancelled"); };
  ctx.signal?.addEventListener("abort", cancel, { once: true });
  try {
    ctx.signal?.throwIfAborted();
    closeBaseware = await listenBaseware(basewareSocket, core);
    devices = await connectBaseware({ socket: basewareSocket, seconds: ctx.seconds, runDir: ctx.runDir, record });
    await atomicJson(join(ctx.runDir, "manifest.json"), { ...JSON.parse(await readFile(join(ctx.runDir, "manifest.json"), "utf8")),
      eventSources: devices.eventSources, logging: {diagnostics: ctx.log.diagnostics, basewareDiagnostics: devices.diagnostics} });
    await writeCapabilityDocument(devices.catalog, join(ctx.workspace, "baseware.json"));
    await writeFile(join(ctx.workspace, "perception.py"), perceptionTemplate, { flag: "wx" });
    runtime = await createHostRuntime({ devices, record, workspace: ctx.workspace, runDir: ctx.runDir,
      state, log: ctx.log, basewareSocket, ludensSocket, seconds: ctx.seconds, budget: ctx.budget,
      model: ctx.model, maxRequests: ctx.maxRequests, compactionThreshold: 256000, action: false });
    devices.onHandback(reason => { void runtime!.stop(reason); });
    devices.onDisconnect(error => { void runtime!.disconnected(error); });
    closeLudens = await listenLudens(ludensSocket, runtime);
    await runtime.perception!.reload();
    ctx.signal?.throwIfAborted();
    epoch = (await runtime.start(await readFile(join(process.env.LUDENS_BENCH_TASK_DIR!, "instruction.md"), "utf8"))).epoch!;
    ctx.signal?.throwIfAborted();
    while (runtime.status().mode !== "manual" || runtime.status().thinking) await Bun.sleep(50);
    recordBenchmark("benchmark_reuse_finished", { ...environment.summary(), reason: runtime.status().reason }, { epoch });
  } finally {
    ctx.signal?.removeEventListener("abort", cancel);
    try { await runtime?.close(); }
    finally {
      devices?.close();
      await closeLudens?.(); await closeBaseware?.();
      await rm(ludensSocket, { force: true }); await rm(basewareSocket, { force: true });
    }
  }
  ctx.signal?.throwIfAborted();
  // An agent may import its helper directly without querying the registry again.
  // This read-only AST audit proves creation, never agent discovery or invocation.
  const inventory = await new PythonCapabilities(ctx.workspace).discover(ctx.signal);
  recordBenchmark("benchmark_reuse_inventory", { stage: "post-run", ...inventory }, { epoch });
  await ctx.log.flush();
  const events = [];
  for await (const event of readRunEvents(ctx.runDir)) events.push(event);
  return { epoch, baseline, environment: environment.summary(), events: freezeReuseEvents(events, ctx.runDir) };
}
