export interface Trace extends Record<string, unknown> {
  traceId?: string; spanId?: string; parentSpanId?: string;
  recordingId?: string; recordingPurpose?: "continuous-perception";
  inputGeneration?: string;
}
export interface EventSource { component: string; implementation?: string; implementationVersion?: string }
export interface EventOrigin { eventId: string; clockId: string; seq: number; at: string; atMs: number }
export interface EventMetadata { source?: EventSource; origin?: EventOrigin; channel?: "diagnostic"; persisted?: boolean }
export interface DeviceEvent extends EventMetadata { type: string; data: unknown; trace: Trace; source: EventSource; origin: EventOrigin }
export type RecordEvent = (type: string, data: unknown, trace?: Trace, metadata?: EventMetadata) => void;
import type { ToolDefinition, ToolArguments } from "./contracts.ts";
import type { DriverManifest } from "./drivers/registry.ts";

export interface BasewareMountedMachineStatus {
  id: string;
  label: string;
  driver: string;
  transport: string;
  connected: boolean;
  reason: string;
  isPrimary: boolean;
  controllers: string[];
}

/** Serializable service discovery; driver implementation objects never cross this boundary. */
export interface Catalog {
  drivers: (Pick<DriverManifest, "id" | "transport" | "defaultPort" | "needsGame" | "launchHint" | "launchCommand" | "launchEnv" | "source"> & { version: string })[];
  controllers: (ToolDefinition & { requiresControl: boolean; mediaTypes?: readonly string[]; machineId?: string })[];
  machines?: BasewareMountedMachineStatus[];
  activeMachineId?: string;
}
export interface Request {
  kind: "status" | "list" | "help" | "acquire" | "release" | "revoke" | "input_generation" | "lease_duration" | "controller" | "cancel" | "subscribe" | "reconnect" | "machines";
  id?: string;
  machine?: string;
  action?: "list" | "use" | "connect" | "disconnect";
  ids?: string[];
  arguments?: ToolArguments;
  epoch?: string;
  seconds?: number | null;
  generation?: string | null;
  trace?: Trace;
  origin?: string;
  operationId?: string;
  omitInlineMedia?: boolean;
}
export interface Envelope { id: string; request: Request }
export type Response = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string };
export type Message = Response | { event: DeviceEvent };
