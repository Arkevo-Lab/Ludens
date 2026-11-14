import { existsSync, watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  EventsSubscribeParams,
  EventsSubscribeResult,
  EventsUnsubscribeParams,
  EventsUnsubscribeResult,
  LudensEventTopic,
  LudensServerEvent,
} from "@ludens/protocol/app-rpc";
import { listRegisteredWorkspaces } from "@ludens/protocol/ludens";
import { eventObservations } from "../core/query/observation-events.ts";
import type { Event } from "../core/query/types.ts";

export const EVENT_HUB_RING_CAPACITY = 1024;
export const DEFAULT_EVENT_HUB_SWEEP_MS = 800;
const MAX_READ_CHUNK_BYTES = 512 * 1024;
const MAX_MEDIA_WAIT_RETRIES = 25;
const SUPPORTS_RECURSIVE_WATCH = process.platform === "darwin" || process.platform === "win32";

export interface PublishEventInput {
  topic: LudensEventTopic;
  workspaceId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

interface SubscriptionFilter {
  topics?: Set<LudensEventTopic>;
  workspaceId?: string;
  runId?: string;
}

interface SubscriberEntry {
  filters: SubscriptionFilter[];
  onEvent: (event: LudensServerEvent) => void;
}

interface PendingObservationItem {
  observationId?: string;
  mediaType?: string;
  mediaFiles: string[];
  eventType: string;
  seq?: number;
  retries: number;
}

interface WatchedRunState {
  key: string;
  workspaceId: string;
  workspace: string;
  runId: string;
  runDir: string;
  eventsPath: string;
  manifestPath: string;
  offset: number;
  pendingBytes: Buffer;
  ended: boolean;
  pendingObservations: PendingObservationItem[];
}

interface WorkspaceRecord {
  id: string;
  workspace: string;
}

function matchesFilter(event: LudensServerEvent, filter: SubscriptionFilter): boolean {
  if (filter.topics && filter.topics.size > 0 && !filter.topics.has(event.topic)) return false;
  if (filter.workspaceId !== undefined && event.workspaceId !== filter.workspaceId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  return true;
}

function filterMatchesUnsubscribe(
  filter: SubscriptionFilter,
  params?: EventsUnsubscribeParams,
): boolean {
  if (!params || params.all) return true;
  if (params.workspaceId !== undefined && filter.workspaceId !== params.workspaceId) return false;
  if (params.runId !== undefined && filter.runId !== params.runId) return false;
  if (params.topics && params.topics.length > 0) {
    if (!filter.topics || filter.topics.size === 0) return false;
    for (const topic of params.topics) {
      if (!filter.topics.has(topic)) return false;
    }
  }
  return true;
}

function sameSafeParts(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return false;
  const parts = relPath.split(/[\\/]/);
  return parts.every(part => part.length > 0 && part !== "." && part !== "..");
}

async function fileReady(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function resolveObservationMediaFiles(
  workspace: string,
  runDir: string,
  parsed: Record<string, unknown>,
): Array<{ observationId?: string; mediaType?: string; mediaFiles: string[] }> {
  const normalizedEvent = {
    type: typeof parsed.type === "string" ? parsed.type : "",
    at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
    data: parsed.data && typeof parsed.data === "object" ? parsed.data : {},
    trace: parsed.trace && typeof parsed.trace === "object" ? parsed.trace : {},
    ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
  } as Event;

  const extracted = eventObservations(normalizedEvent);
  const results: Array<{ observationId?: string; mediaType?: string; mediaFiles: string[] }> = [];

  for (const obs of extracted) {
    const mediaFiles: string[] = [];
    if (obs.timeline?.asset && sameSafeParts(obs.timeline.asset)) {
      mediaFiles.push(join(workspace, ".ludens", "timeline", obs.timeline.asset));
    } else if (typeof obs.path === "string" && obs.path.length > 0) {
      const obsInRun = join(runDir, "observations", basename(obs.path));
      mediaFiles.push(obsInRun);
      if (obs.path !== obsInRun && obs.path.startsWith(runDir)) {
        mediaFiles.push(obs.path);
      }
    }
    results.push({
      observationId: typeof obs.id === "string" ? obs.id : undefined,
      mediaType: typeof obs.mediaType === "string" ? obs.mediaType : undefined,
      mediaFiles,
    });
  }

  if (
    results.length === 0 &&
    normalizedEvent.type === "observation_media" &&
    normalizedEvent.data &&
    typeof normalizedEvent.data === "object"
  ) {
    const d = normalizedEvent.data as Record<string, unknown>;
    const asset = typeof d.asset === "string" && sameSafeParts(d.asset) ? d.asset : null;
    if (asset) {
      results.push({
        observationId: typeof d.observationId === "string" ? d.observationId : undefined,
        mediaFiles: [join(workspace, ".ludens", "timeline", asset)],
      });
    }
  }

  return results;
}

/**
 * Coordinates real-time events across RPC subscribers, mutations, active run JSONL tailing,
 * and pet/workspace state files with bounded 1,024-event `sinceSeq` catch-up replay.
 */
export class EventHub {
  private readonly home: string;
  private readonly sweepIntervalMs: number;
  private seq = 0;
  private readonly buffer: LudensServerEvent[] = [];
  private readonly subscribers = new Map<string, SubscriberEntry>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly runStates = new Map<string, WatchedRunState>();
  private readonly fileSignatures = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private initializedBaseline = false;
  private closed = false;
  private sweepPromise: Promise<void> | null = null;

  constructor(options: { home: string; sweepIntervalMs?: number }) {
    this.home = resolve(options.home);
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_EVENT_HUB_SWEEP_MS;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get activeRunCount(): number {
    let count = 0;
    for (const run of this.runStates.values()) {
      if (!run.ended) count++;
    }
    return count;
  }

  publish(input: PublishEventInput): LudensServerEvent {
    const event: LudensServerEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      topic: input.topic,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    if (this.buffer.length >= EVENT_HUB_RING_CAPACITY) {
      this.buffer.shift();
    }
    this.buffer.push(event);

    for (const entry of this.subscribers.values()) {
      if (entry.filters.some(filter => matchesFilter(event, filter))) {
        try {
          entry.onEvent(event);
        } catch {
          // Listener cleanup runs on disconnect; never let one sink break others.
        }
      }
    }
    return event;
  }

  subscribe(
    listenerId: string,
    params: EventsSubscribeParams = {},
    onEvent: (event: LudensServerEvent) => void,
  ): EventsSubscribeResult {
    const filter: SubscriptionFilter = {
      ...(params.topics && params.topics.length > 0 ? { topics: new Set(params.topics) } : {}),
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    };

    const existing = this.subscribers.get(listenerId);
    if (existing) {
      existing.onEvent = onEvent;
      existing.filters.push(filter);
    } else {
      this.subscribers.set(listenerId, { filters: [filter], onEvent });
    }

    let replayTruncated = false;
    let events: LudensServerEvent[] = [];

    if (params.sinceSeq !== undefined && Number.isFinite(params.sinceSeq)) {
      const since = Math.floor(params.sinceSeq);
      if (since < this.seq) {
        if (this.buffer.length === 0) {
          replayTruncated = this.seq > 0 && since < this.seq;
        } else {
          const oldestSeq = this.buffer[0]!.seq;
          if (since < oldestSeq - 1) {
            replayTruncated = true;
          }
          events = this.buffer.filter(ev => ev.seq > since && matchesFilter(ev, filter));
        }
      }
    }

    this.syncSweepTimer();
    return {
      subscribedSeq: this.seq,
      events,
      replayTruncated,
    };
  }

  unsubscribe(listenerId: string, params?: EventsUnsubscribeParams): EventsUnsubscribeResult {
    const entry = this.subscribers.get(listenerId);
    if (!entry) {
      return { ok: true, activeSubscriptions: 0 };
    }
    if (!params || params.all) {
      this.subscribers.delete(listenerId);
      this.syncSweepTimer();
      return { ok: true, activeSubscriptions: 0 };
    }

    entry.filters = entry.filters.filter(filter => !filterMatchesUnsubscribe(filter, params));
    if (entry.filters.length === 0) {
      this.subscribers.delete(listenerId);
    }
    this.syncSweepTimer();
    return { ok: true, activeSubscriptions: entry.filters.length };
  }

  removeSubscriber(listenerId: string): void {
    if (this.subscribers.delete(listenerId)) {
      this.syncSweepTimer();
    }
  }

  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    await this.sweepNow();
  }

  private syncSweepTimer(): void {
    if (this.closed || !this.started) return;
    const needed = this.subscribers.size > 0 || this.activeRunCount > 0;
    if (needed && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        void this.sweepNow();
      }, this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    } else if (!needed && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private scheduleDebouncedSweep(): void {
    if (this.closed || !this.started || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sweepNow();
    }, 50);
    this.debounceTimer.unref?.();
  }

  private ensureWatcher(dirPath: string, recursive = false): void {
    if (this.closed || this.watchers.has(dirPath) || !existsSync(dirPath)) return;
    try {
      const watcher = watch(
        dirPath,
        {
          persistent: false,
          ...(recursive && SUPPORTS_RECURSIVE_WATCH ? { recursive: true } : {}),
        },
        () => {
          this.scheduleDebouncedSweep();
        },
      );
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(dirPath);
      });
      this.watchers.set(dirPath, watcher);
    } catch {
      // Directory may not exist yet; next sweep retries when created.
    }
  }

  async sweepNow(): Promise<void> {
    if (this.closed) return;
    if (this.sweepPromise) {
      await this.sweepPromise;
      return;
    }
    this.sweepPromise = this.runSweep().finally(() => {
      this.sweepPromise = null;
    });
    await this.sweepPromise;
  }

  private async runSweep(): Promise<void> {
    if (this.closed) return;
    const firstPass = !this.initializedBaseline;
    this.initializedBaseline = true;

    this.ensureWatcher(this.home, true);
    if (!SUPPORTS_RECURSIVE_WATCH) {
      this.ensureWatcher(join(this.home, "registry"));
      this.ensureWatcher(join(this.home, "pet"));
    }

    const registered = await this.readRegisteredWorkspaces();
    const registryKey = `${this.home}::registry`;
    const registrySignature = registered.map(w => `${w.id}:${w.workspace}`).sort().join("|");
    const prevRegistrySig = this.fileSignatures.get(registryKey);
    if (prevRegistrySig !== registrySignature) {
      this.fileSignatures.set(registryKey, registrySignature);
      if (!firstPass) {
        this.publish({ topic: "catalog", payload: { reason: "workspacesChanged" } });
        this.publish({ topic: "workspace", payload: { reason: "workspacesChanged" } });
      }
    }

    for (const petPath of [
      join(this.home, "pet", "target.json"),
      join(this.home, "pet", "consumer.json"),
    ]) {
      await this.checkJsonFileChange(petPath, firstPass, () => {
        this.publish({ topic: "pet", payload: { file: basename(petPath) } });
      });
    }

    const workspaces = registered;
    for (const ws of workspaces) {
      const logsDir = join(ws.workspace, "logs");
      this.ensureWatcher(logsDir, true);
      let entries: string[] = [];
      try {
        entries = await readdir(logsDir);
      } catch {
        continue;
      }

      for (const runId of entries) {
        if (!runId || runId.startsWith(".")) continue;
        const runDir = join(logsDir, runId);
        const eventsPath = join(runDir, "events.jsonl");
        const manifestPath = join(runDir, "manifest.json");
        const key = `${ws.id}:${runId}`;
        let state = this.runStates.get(key);
        if (!state) {
          let initialOffset = 0;
          let ended = false;
          try {
            const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { endedAt?: string };
            ended = typeof manifest.endedAt === "string" && manifest.endedAt.length > 0;
          } catch {
            // Manifest may still be initializing.
          }
          if (firstPass) {
            try {
              const info = await stat(eventsPath);
              if (info.isFile()) initialOffset = info.size;
            } catch {
              initialOffset = 0;
            }
          }
          state = {
            key,
            workspaceId: ws.id,
            workspace: ws.workspace,
            runId,
            runDir,
            eventsPath,
            manifestPath,
            offset: initialOffset,
            pendingBytes: Buffer.alloc(0),
            ended,
            pendingObservations: [],
          };
          this.runStates.set(key, state);
        }

        if (!state.ended) {
          if (!SUPPORTS_RECURSIVE_WATCH) {
            this.ensureWatcher(runDir);
          }
          await this.tailRunState(state);
          await this.flushPendingObservations(state);
          await this.refreshRunEnded(state);
        } else if (state.pendingObservations.length > 0) {
          await this.flushPendingObservations(state);
        }
      }
    }

    this.syncSweepTimer();
  }

  private async readRegisteredWorkspaces(): Promise<WorkspaceRecord[]> {
    try {
      const list = await listRegisteredWorkspaces(this.home);
      const records: WorkspaceRecord[] = [];
      for (const item of list) {
        const canonical = await realpath(item.workspace).catch(() => item.workspace);
        records.push({ id: item.id, workspace: canonical });
      }
      return records;
    } catch {
      return [];
    }
  }

  private async checkJsonFileChange(
    filePath: string,
    suppressEmit: boolean,
    onChange: () => void,
  ): Promise<void> {
    let signature = "";
    try {
      const info = await stat(filePath);
      if (info.isFile()) {
        signature = `${info.mtimeMs}:${info.size}`;
      }
    } catch {
      signature = "";
    }
    const prev = this.fileSignatures.get(filePath);
    if (prev === undefined) {
      this.fileSignatures.set(filePath, signature);
      if (!suppressEmit && signature !== "") {
        onChange();
      }
      return;
    }
    if (prev !== signature) {
      this.fileSignatures.set(filePath, signature);
      if (!suppressEmit) {
        onChange();
      }
    }
  }

  private async refreshRunEnded(state: WatchedRunState): Promise<void> {
    try {
      const manifest = JSON.parse(await readFile(state.manifestPath, "utf8")) as { endedAt?: string };
      if (typeof manifest.endedAt === "string" && manifest.endedAt.length > 0) {
        state.ended = true;
      }
    } catch {
      // Ignore transient/missing manifest.
    }
  }

  private async tailRunState(state: WatchedRunState): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(state.eventsPath);
    } catch {
      return;
    }
    if (!info.isFile()) return;
    if (info.size < state.offset) {
      state.offset = 0;
      state.pendingBytes = Buffer.alloc(0);
    }
    if (info.size === state.offset) return;

    const handle = await open(state.eventsPath, "r").catch(() => null);
    if (!handle) return;
    try {
      while (state.offset < info.size) {
        const toRead = Math.min(MAX_READ_CHUNK_BYTES, info.size - state.offset);
        if (toRead <= 0) break;
        const buf = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(buf, 0, toRead, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        const combined = state.pendingBytes.length > 0
          ? Buffer.concat([state.pendingBytes, buf.subarray(0, bytesRead)])
          : buf.subarray(0, bytesRead);
        const lastNewline = combined.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          state.pendingBytes = Buffer.from(combined);
          continue;
        }
        const completeBlock = combined.subarray(0, lastNewline).toString("utf8");
        state.pendingBytes = combined.subarray(lastNewline + 1).length > 0
          ? Buffer.from(combined.subarray(lastNewline + 1))
          : Buffer.alloc(0);

        for (const rawLine of completeBlock.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          await this.processJsonlLine(state, line);
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async processJsonlLine(state: WatchedRunState, line: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      parsed = value as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : "unknown";
    const eventSeq = typeof parsed.seq === "number" ? parsed.seq : undefined;
    const trace = parsed.trace && typeof parsed.trace === "object" ? (parsed.trace as Record<string, unknown>) : undefined;
    const epoch = trace && typeof trace.epoch === "string" ? trace.epoch : undefined;

    this.publish({
      topic: "run",
      workspaceId: state.workspaceId,
      runId: state.runId,
      payload: {
        type: eventType,
        ...(eventSeq !== undefined ? { eventSeq } : {}),
        ...(epoch !== undefined ? { epoch } : {}),
      },
    });

    if (eventType === "pool_event") {
      this.publish({
        topic: "eventPool",
        workspaceId: state.workspaceId,
        runId: state.runId,
        payload: {
          type: eventType,
          ...(eventSeq !== undefined ? { eventSeq } : {}),
        },
      });
    }

    if (eventType === "control" || eventType === "run_end") {
      this.publish({
        topic: "core",
        workspaceId: state.workspaceId,
        runId: state.runId,
        payload: {
          type: eventType,
          ...(eventSeq !== undefined ? { eventSeq } : {}),
          ...(epoch !== undefined ? { epoch } : {}),
        },
      });
    }

    const obsItems = resolveObservationMediaFiles(state.workspace, state.runDir, parsed);
    for (const item of obsItems) {
      if (item.mediaFiles.length === 0 || (await this.allMediaReady(item.mediaFiles))) {
        this.publish({
          topic: "observation",
          workspaceId: state.workspaceId,
          runId: state.runId,
          payload: {
            type: eventType,
            ...(item.observationId ? { observationId: item.observationId } : {}),
            ...(item.mediaType ? { mediaType: item.mediaType } : {}),
            ...(eventSeq !== undefined ? { eventSeq } : {}),
          },
        });
      } else {
        state.pendingObservations.push({
          ...item,
          eventType,
          seq: eventSeq,
          retries: 0,
        });
      }
    }
  }

  private async allMediaReady(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return true;
    for (const path of paths) {
      if (await fileReady(path)) return true;
    }
    return false;
  }

  private async flushPendingObservations(state: WatchedRunState): Promise<void> {
    if (state.pendingObservations.length === 0) return;
    const remaining: PendingObservationItem[] = [];
    for (const pending of state.pendingObservations) {
      if (await this.allMediaReady(pending.mediaFiles)) {
        this.publish({
          topic: "observation",
          workspaceId: state.workspaceId,
          runId: state.runId,
          payload: {
            type: pending.eventType,
            ...(pending.observationId ? { observationId: pending.observationId } : {}),
            ...(pending.mediaType ? { mediaType: pending.mediaType } : {}),
            ...(pending.seq !== undefined ? { eventSeq: pending.seq } : {}),
          },
        });
      } else if (pending.retries < MAX_MEDIA_WAIT_RETRIES) {
        pending.retries++;
        remaining.push(pending);
      }
    }
    state.pendingObservations = remaining;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors.
      }
    }
    this.watchers.clear();
    this.subscribers.clear();
    this.runStates.clear();
  }
}
