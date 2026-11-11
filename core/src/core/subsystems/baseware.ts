import { BasewareClient } from "@ludens/baseware/client";
import type { ExecutionResult } from "@ludens/baseware/contracts";
import type { Catalog } from "@ludens/baseware/protocol";
import type { RecordEvent, EventTrace } from "../storage/events.ts";
import type { DeviceSession } from "../shiori/runtime.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EventSourceDescriptor, SourceDependency } from "@ludens/protocol/event-sources";

interface ControlStatus { mode: string; epoch: string | null; connected: boolean; remainingSeconds: number | null;
  source?: EventSourceDescriptor; seq?: number; diagnostics?: "normal" | "full" }

/** One persistent control connection; shell/API clients share its epoch. */
export async function connectBaseware(options: { socket: string; seconds?: number | null; runDir: string; record: RecordEvent; reconnectAttempts?: number; reconnectDelayMs?: number }) {
  let owner: string | undefined;
  let pendingOwner: string | undefined;
  let disconnected: Error | undefined;
  let onDisconnect: ((error: Error) => void) | undefined;
  let onReconnect: (() => void) | undefined;
  let onHandback: ((reason: string) => void) | undefined;
  let reconnecting: Promise<void> | undefined;
  let closed = false;
  let catalog: Catalog | undefined;
  const maxReconnectAttempts = options.reconnectAttempts ?? 3;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  if (!Number.isInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) throw new Error("reconnectAttempts must be a non-negative integer");
  if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) throw new Error("reconnectDelayMs must be non-negative");
  const recordingId = basename(options.runDir);
  const eventSources: SourceDependency[] = [];
  let dirty = false;
  let gap: { sourceId: string; firstSeq: number; lastSeq: number; count: number } | undefined;
  let gapWarning = false;
  const recordGap = (data: Record<string, unknown>) => {
    try { options.record("event_source_gap", data); }
    catch (error) {
      // Both journals may share a failed disk. Logging that failure must not
      // interrupt the control notification or fail an already delivered input.
      if (!gapWarning) { gapWarning = true; console.error(`Event source gap could not be recorded: ${String(error)}`); }
    }
  };
  const persistSources = () => {
    if (!dirty) return;
    const path = join(options.runDir, "manifest.json");
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const temporary = `${path}.sources.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...manifest, eventSources }, null, 2));
      renameSync(temporary, path);
      dirty = false;
    } catch (error) {
      // The initial manifest is written after connecting. A storage failure is
      // diagnostic, never a reason to retry an already delivered input.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Event source manifest: ${String(error)}`);
    }
  };
  let recovering: Promise<void> | undefined;
  const refreshCatalog = async () => {
    const fresh = await client.request({ kind: "list" }) as Catalog;
    if (!catalog) return;
    catalog.drivers = fresh.drivers;
    catalog.controllers = fresh.controllers;
    catalog.machines = fresh.machines;
    catalog.activeMachineId = fresh.activeMachineId;
  };
  const recovered = (source: "reconnect_loop" | "baseware_event", attempt?: number) => {
    if (!disconnected || closed) return;
    recovering ??= (async () => {
      await refreshCatalog();
      if (!disconnected || closed) return;
      disconnected = undefined;
      options.record("device_reconnected", { ...(attempt === undefined ? {} : { attempt }), source });
      onReconnect?.();
    })().finally(() => { recovering = undefined; });
    return recovering;
  };
  const recoverFromEvent = () => {
    void recovered("baseware_event")?.catch(error => options.record("error", String(error)));
  };
  const deviceDisconnected = (error: Error) => {
    if (disconnected || closed) return;
    disconnected = error;
    options.record("device_disconnected", { reason: error.message });
    reconnecting = (async () => {
      for (let attempt = 1; attempt <= maxReconnectAttempts; attempt++) {
        if (reconnectDelayMs !== 0) await Bun.sleep(reconnectDelayMs);
        if (!disconnected || closed) return;
        options.record("device_reconnect_attempt", { attempt, maxAttempts: maxReconnectAttempts });
        try {
          const state = await client.request({ kind: "reconnect" }) as { connected: boolean };
          if (state.connected) {
            await recovered("reconnect_loop", attempt);
            return;
          }
        } catch {
          // A still-live Baseware socket can reject individual reconnect attempts.
        }
      }
      if (!disconnected || closed) return;
      options.record("device_reconnect_failed", { attempts: maxReconnectAttempts, error: error.message });
      onDisconnect?.(new Error(`Device disconnected after ${maxReconnectAttempts} reconnect attempts: ${error.message}`));
    })().finally(() => { reconnecting = undefined; });
    void reconnecting.catch(error => { if (!closed) disconnect(error instanceof Error ? error : new Error(String(error))); });
  };
  const disconnect = (error: Error) => { if (disconnected) return; disconnected = error; onDisconnect?.(error); };
  const socketDisconnect = (error: Error) => { if (disconnected) onDisconnect?.(error); else disconnect(error); };
  const client = await BasewareClient.connect(options.socket, {
    onEvent(event) {
      // The device service owns its facts. Ludens only keeps source dependencies
      // and consumes control notifications; it never appends a second body.
      const dependency = eventSources.find(source => source.sourceId === event.origin.clockId);
      if (dependency) {
        const window = dependency.windows.at(-1)!;
        if (event.origin.seq > (window.throughSeq ?? window.afterSeq)) { window.throughSeq = event.origin.seq; dirty = true; }
      }
      if (event.persisted === false) {
        if (!gap) {
          gap = { sourceId: event.origin.clockId, firstSeq: event.origin.seq, lastSeq: event.origin.seq, count: 0 };
          recordGap({ ...gap, phase: "start" });
        }
        gap.lastSeq = event.origin.seq; gap.count++;
      } else if (gap) {
        recordGap({ ...gap, phase: "end" }); gap = undefined;
      }
      if (event.type === "baseware_control") {
        const state = event.data as { mode: string; connected: boolean; reason?: string };
        if (!state.connected) {
          deviceDisconnected(new Error(state.reason ?? "Baseware driver disconnected"));
        } else {
          if (state.mode === "manual" && (event.trace.epoch === owner || event.trace.epoch === pendingOwner)
            && typeof event.trace.epoch === "string") {
            owner = undefined;
            pendingOwner = undefined;
            onHandback?.(state.reason ?? "Baseware released control");
          }
          if (disconnected) recoverFromEvent();
        }
      }
      if (event.type === "baseware_disconnected") {
        const message = typeof event.data === "string" ? event.data : "Baseware driver disconnected";
        deviceDisconnected(new Error(message));
      }
      if (event.type === "baseware_reconnected" && disconnected) recoverFromEvent();
    },
    onDisconnect: socketDisconnect,
  });
  try {
    catalog = await client.request({ kind: "list" }) as Catalog;
    const initial = await client.request({ kind: "status" }) as ControlStatus;
    if (!initial.connected || disconnected) throw disconnected ?? new Error("Baseware driver disconnected");
    if (initial.source) eventSources.push({ ...initial.source, recordingId,
      windows: [{ afterSeq: initial.seq ?? 0, throughSeq: initial.seq ?? 0 }] });
    const watermark = setInterval(persistSources, 5000); watermark.unref();
    async function acquire(epoch: string, signal?: AbortSignal, seconds?: number | null) {
      signal?.throwIfAborted();
      if (disconnected) throw disconnected;
      if (owner || pendingOwner) throw new Error("Baseware control is already owned or changing");
      // An explicit per-cycle duration overrides the session default; null means unbounded.
      const leaseSeconds = seconds !== undefined ? seconds : (options.seconds ?? null);
      pendingOwner = epoch;
      try {
        const state = await client.request({ kind: "acquire", epoch, ...(leaseSeconds != null ? { seconds: leaseSeconds } : {}), trace: { recordingId } }, signal) as ControlStatus;
        signal?.throwIfAborted();
        if (pendingOwner !== epoch || state.mode !== "auto" || state.epoch !== epoch || !state.connected
          || (leaseSeconds != null && (state.remainingSeconds === null || state.remainingSeconds <= 0))) {
          throw new Error("Baseware control acquisition was revoked before completion");
        }
        owner = epoch;
      } finally { if (pendingOwner === epoch) pendingOwner = undefined; }
    }
    async function release(epoch: string) {
      if (owner !== epoch && pendingOwner !== epoch) return;
      owner = undefined;
      pendingOwner = undefined;
      const state = await client.request({ kind: "release", epoch, trace: { recordingId } }) as ControlStatus;
      if (!state.connected) {
        const error = new Error("Baseware driver disconnected during control release");
        disconnect(error);
        throw error;
      }
    }
    const session: DeviceSession = {
      catalog: catalog!, acquire, release, diagnostics: initial.diagnostics ?? "normal",
      async machines(action, payload) {
        const result = await client.request({ kind: "machines", action, id: payload?.id, ids: payload?.ids });
        await refreshCatalog();
        return result;
      },
      async setInputGeneration(epoch, generation) {
        await client.request({ kind: "input_generation", epoch, generation, trace: { recordingId } });
      },
      async execute(id, args, epoch, signal, trace, origin, machine) {
        const omitInlineMedia = trace?.recordingPurpose === "continuous-perception";
        const result = await client.request({ kind: "controller", id, arguments: args, epoch, trace: { ...trace, recordingId }, origin,
          ...(machine ? { machine } : {}),
          ...(omitInlineMedia ? { omitInlineMedia: true } : {}) }, signal) as ExecutionResult;
        return result;
      },
    };
    return { ...session, eventSources,
      onDisconnect(handler: (error: Error) => void) { onDisconnect = handler; if (disconnected && !reconnecting) handler(disconnected); },
      onReconnect(handler: () => void) { onReconnect = handler; },
      onHandback(handler: (reason: string) => void) { onHandback = handler; },
      close() {
        closed = true;
        clearInterval(watermark); persistSources();
        if (gap) { recordGap({ ...gap, phase: "end", reason: "host_closed" }); gap = undefined; }
        client.close();
      },
    };
  } catch (error) { closed = true; client.close(); throw error; }
}
