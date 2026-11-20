import { delimiter, resolve } from "node:path";
import { Runtime, type DeviceSession, type ServiceLaunchOrigin } from "./runtime.ts";
import { WorkspaceController } from "../subsystems/controller.ts";
import { PerceptionRuntime } from "../subsystems/perception.ts";
import { LoopRuntime } from "../subsystems/loop.ts";
import { WorkspaceEventPool } from "../storage/event-pool.ts";
import type { EventLog, RecordEvent } from "../storage/events.ts";
import type { WorkspaceState } from "../storage/workspace-state.ts";
import type { ModelConnectionConfig } from "@ludens/protocol/ludens";

/** The Host assembly used by daily play and evaluated agents. Transports remain owned by the caller. */
export async function createHostRuntime(options: {
  devices: DeviceSession; workspace: string; runDir: string; state: WorkspaceState;
  log: EventLog; record?: RecordEvent; ludensSocket: string; basewareSocket: string;
  model?: string; resume?: string; compactionThreshold?: number;
  connection?: ModelConnectionConfig;
  launchedBy?: ServiceLaunchOrigin;
}) {
  const { devices, workspace, runDir, state, log, ludensSocket, basewareSocket } = options;
  const record = options.record ?? log.record;
  const runtime = new Runtime(devices, record, log.clock.id, log.diagnostics, undefined, undefined, options.launchedBy);
  const eventPool = new WorkspaceEventPool(state.dir);
  runtime.attach({ eventPool, eventPoolSummary: await eventPool.summary() });
  const binDir = resolve(import.meta.dir, "../../../bin");
  const env = {
    LUDENS_SOCKET: ludensSocket, BASEWARE_SOCKET: basewareSocket, LUDENS_WORKSPACE: workspace, LUDENS_RUN_ID: log.clock.id,
    LUDENS_LOG_DIAGNOSTICS: log.diagnostics, BASEWARE_TRACE: JSON.stringify({ recordingId: log.clock.id }),
    PATH: [binDir, resolve(import.meta.dir, "../../../../baseware/bin"), process.env.PATH ?? ""].join(delimiter),
  };
  runtime.attach({ controller: new WorkspaceController({ workspace, devices, record, env }) });
  runtime.attach({ perception: new PerceptionRuntime({ workspace, runDir, env, record, registerMedia: log.registerMedia,
    diagnostics: log.diagnostics, clock: log.clock,
    onCleanupError: error => { void runtime.stop(error.message); },
    setInputGeneration: devices.setInputGeneration
      ? async (epoch, generation) => {
        // Host handback owns the full device release. A concurrent per-generation
        // cleanup may arrive after that epoch has already been revoked.
        if (generation === null && runtime.status().epoch !== epoch) return;
        try { await devices.setInputGeneration!(epoch, generation); }
        catch (error) {
          if (generation === null && runtime.status().epoch !== epoch) return;
          throw error;
        }
      }
      : undefined }) });
  runtime.attach({ loop: new LoopRuntime({ workspace, runDir, socketPath: ludensSocket, env, record,
    diagnostics: log.diagnostics, clock: log.clock }) });
  try {
    if (options.model) {
      const { createOmpAgent } = await import("../agent-omp/session.ts");
      runtime.attach({ agent: await createOmpAgent({ runtime, workspace, runDir, state, log, binDir, ludensSocket, basewareSocket,
        model: options.model, resume: options.resume,
        compactionThreshold: options.compactionThreshold, connection: options.connection }) });
    }
    return runtime;
  } catch (error) { await runtime.close(); throw error; }
}
