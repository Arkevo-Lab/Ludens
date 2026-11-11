import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildInboundEventDigest,
  computeEventPoolSummary,
  EMPTY_EVENT_POOL_SUMMARY,
  INBOUND_EVENT_KINDS,
  OUTBOUND_EVENT_KINDS,
  POOL_EVENT_ACTORS,
  POOL_EVENT_STATUSES,
  type EventDirection,
  type EventPoolDigest,
  type EventPoolSnapshot,
  type EventPoolSummary,
  type InboundEventKind,
  type OutboundEventKind,
  type PoolEvent,
  type PoolEventActor,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import { resolveWorkspaceState } from "./workspace-state.ts";

interface EventPoolFile {
  version: 1;
  latestSeq: number;
  events: PoolEvent[];
}

const MAX_RETAINED_HANDLED_EVENTS = 200;
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalTitle(title?: string): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function validatePoolEvent(raw: unknown): PoolEvent {
  if (!isRecord(raw)) throw new Error("Invalid PoolEvent record");
  if (typeof raw.id !== "string" || !raw.id) throw new Error("Invalid PoolEvent.id");
  if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) throw new Error("Invalid PoolEvent.seq");
  if (raw.direction !== "inbound" && raw.direction !== "outbound") throw new Error("Invalid PoolEvent.direction");
  const validKinds: readonly string[] = raw.direction === "inbound" ? INBOUND_EVENT_KINDS : OUTBOUND_EVENT_KINDS;
  if (typeof raw.kind !== "string" || !validKinds.includes(raw.kind)) throw new Error("Invalid PoolEvent.kind");
  if (typeof raw.status !== "string" || !(POOL_EVENT_STATUSES as readonly string[]).includes(raw.status)) {
    throw new Error("Invalid PoolEvent.status");
  }
  if (typeof raw.text !== "string" || !raw.text.trim()) throw new Error("Invalid PoolEvent.text");
  if (typeof raw.createdAt !== "string" || !raw.createdAt) throw new Error("Invalid PoolEvent.createdAt");
  if (raw.handledBy !== undefined && (typeof raw.handledBy !== "string" || !(POOL_EVENT_ACTORS as readonly string[]).includes(raw.handledBy))) {
    throw new Error("Invalid PoolEvent.handledBy");
  }
  return {
    id: raw.id,
    seq: raw.seq,
    direction: raw.direction,
    kind: raw.kind as PoolEvent["kind"],
    status: raw.status as PoolEventStatus,
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    text: raw.text,
    ...(typeof raw.replyTo === "string" && raw.replyTo ? { replyTo: raw.replyTo } : {}),
    ...(typeof raw.pauseRequested === "boolean" ? { pauseRequested: raw.pauseRequested } : {}),
    ...(raw.runId === null || typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(raw.epoch === null || typeof raw.epoch === "string" ? { epoch: raw.epoch } : {}),
    createdAt: raw.createdAt,
    ...(typeof raw.handledAt === "string" && raw.handledAt ? { handledAt: raw.handledAt } : {}),
    ...(raw.handledBy !== undefined ? { handledBy: raw.handledBy as PoolEventActor } : {}),
  };
}

function parseEventPoolFile(text: string): EventPoolFile {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.latestSeq !== "number" || !Array.isArray(parsed.events)) {
    throw new Error("Invalid event-pool.json schema");
  }
  const events = parsed.events.map(validatePoolEvent);
  const maxSeq = events.reduce((acc, item) => Math.max(acc, item.seq), parsed.latestSeq);
  return { version: 1, latestSeq: maxSeq, events };
}

function pruneEvents(events: PoolEvent[]): PoolEvent[] {
  const pending: PoolEvent[] = [];
  const handled: PoolEvent[] = [];
  for (const event of events) {
    if (event.status === "pending") pending.push(event);
    else handled.push(event);
  }
  const keptHandled = handled.length > MAX_RETAINED_HANDLED_EVENTS
    ? handled.slice(handled.length - MAX_RETAINED_HANDLED_EVENTS)
    : handled;
  return [...pending, ...keptHandled].sort((a, b) => a.seq - b.seq);
}

/**
 * Atomic, cross-process workspace Event Pool backed by `<stateDir>/event-pool.json`.
 * Never initializes `.ludens/` on its own; callers pass an existing `.ludens` state directory
 * or resolve via `openWorkspaceEventPool()`.
 */
export class WorkspaceEventPool {
  private readonly filePath: string;
  private readonly lockDir: string;

  constructor(private readonly stateDir: string) {
    const resolved = resolve(stateDir);
    this.filePath = join(resolved, "event-pool.json");
    this.lockDir = join(resolved, "event-pool.json.lock");
  }

  private async readUnlocked(): Promise<EventPoolFile> {
    try {
      return parseEventPoolFile(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, latestSeq: 0, events: [] };
      }
      throw error;
    }
  }

  private async writeUnlocked(data: EventPoolFile): Promise<void> {
    const pruned: EventPoolFile = {
      version: 1,
      latestSeq: data.latestSeq,
      events: pruneEvents(data.events),
    };
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(pruned, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(this.lockDir);
        await writeFile(join(this.lockDir, owner), String(Date.now()));
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        await this.recoverStaleLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for workspace Event Pool lock");
        await new Promise(r => setTimeout(r, 15));
      }
    }
    try {
      return await work();
    } finally {
      await unlink(join(this.lockDir, owner)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await rmdir(this.lockDir).catch(error => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      });
    }
  }

  private async recoverStaleLock(): Promise<void> {
    const info = await stat(this.lockDir).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
    const entries = await readdir(this.lockDir).catch(() => []);
    for (const entry of entries) {
      await unlink(join(this.lockDir, entry)).catch(() => {});
    }
    await rmdir(this.lockDir).catch(() => {});
  }

  async summary(): Promise<EventPoolSummary> {
    const state = await this.readUnlocked();
    if (!state.events.length && state.latestSeq === 0) return { ...EMPTY_EVENT_POOL_SUMMARY };
    return computeEventPoolSummary(state.events, state.latestSeq);
  }

  async digest(): Promise<EventPoolDigest> {
    const state = await this.readUnlocked();
    return buildInboundEventDigest(state.events);
  }

  async snapshot(filter: {
    direction?: EventDirection;
    status?: PoolEventStatus;
    ids?: string[];
    limit?: number;
  } = {}): Promise<EventPoolSnapshot> {
    const state = await this.readUnlocked();
    const summary = computeEventPoolSummary(state.events, state.latestSeq);
    const idSet = filter.ids?.length ? new Set(filter.ids) : undefined;
    let events = state.events.filter(event => {
      if (filter.direction && event.direction !== filter.direction) return false;
      if (filter.status && event.status !== filter.status) return false;
      if (idSet && !idSet.has(event.id)) return false;
      return true;
    });
    if (filter.limit !== undefined && filter.limit > 0 && events.length > filter.limit) {
      events = events.slice(events.length - filter.limit);
    }
    return { summary, events };
  }

  async postInbound(input: {
    text: string;
    title?: string;
    replyTo?: string;
    runId?: string | null;
    epoch?: string | null;
    now?: string;
  }): Promise<{ event: PoolEvent; resolvedOutbound?: PoolEvent; summary: EventPoolSummary }> {
    const text = input.text.trim();
    if (!text) throw new Error("Message cannot be empty");
    const replyTo = input.replyTo?.trim() || undefined;
    const title = normalizeOptionalTitle(input.title);
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const now = input.now ?? new Date().toISOString();
      let resolvedOutbound: PoolEvent | undefined;
      if (replyTo) {
        const target = state.events.find(item => item.id === replyTo && item.direction === "outbound");
        if (!target) throw new Error(`Outbound event not found: ${replyTo}`);
        if (target.status === "pending") {
          target.status = "handled";
          target.handledAt = now;
          target.handledBy = "human";
          resolvedOutbound = { ...target };
        }
      }
      const seq = state.latestSeq + 1;
      const kind: InboundEventKind = replyTo ? "reply" : "message";
      const event: PoolEvent = {
        id: `ev-${seq}-${randomUUID().slice(0, 8)}`,
        seq,
        direction: "inbound",
        kind,
        status: "pending",
        ...(title ? { title } : {}),
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
        createdAt: now,
      };
      state.latestSeq = seq;
      state.events.push(event);
      await this.writeUnlocked(state);
      return {
        event,
        ...(resolvedOutbound ? { resolvedOutbound } : {}),
        summary: computeEventPoolSummary(state.events, state.latestSeq),
      };
    });
  }

  async emitOutbound(input: {
    kind?: OutboundEventKind;
    text: string;
    title?: string;
    pauseRequested?: boolean;
    runId?: string | null;
    epoch?: string | null;
    now?: string;
  }): Promise<{ event: PoolEvent; summary: EventPoolSummary }> {
    const text = input.text.trim();
    if (!text) throw new Error("Event text cannot be empty");
    const kind: OutboundEventKind = input.kind ?? "help_request";
    if (!(OUTBOUND_EVENT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Invalid outbound event kind: ${String(input.kind)}`);
    }
    const title = normalizeOptionalTitle(input.title);
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const now = input.now ?? new Date().toISOString();
      const seq = state.latestSeq + 1;
      const event: PoolEvent = {
        id: `ev-${seq}-${randomUUID().slice(0, 8)}`,
        seq,
        direction: "outbound",
        kind,
        status: "pending",
        ...(title ? { title } : {}),
        text,
        ...(input.pauseRequested ? { pauseRequested: true } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
        createdAt: now,
      };
      state.latestSeq = seq;
      state.events.push(event);
      await this.writeUnlocked(state);
      return { event, summary: computeEventPoolSummary(state.events, state.latestSeq) };
    });
  }

  async readInbound(options: {
    ids?: string[];
    includeHandled?: boolean;
    ack?: boolean;
    now?: string;
  } = {}): Promise<{ events: PoolEvent[]; acknowledged: PoolEvent[]; summary: EventPoolSummary }> {
    const shouldAck = options.ack !== false;
    const idSet = options.ids?.length ? new Set(options.ids) : undefined;
    if (!shouldAck) {
      const state = await this.readUnlocked();
      const events = state.events.filter(event => {
        if (event.direction !== "inbound") return false;
        if (!options.includeHandled && event.status !== "pending") return false;
        if (idSet && !idSet.has(event.id)) return false;
        return true;
      });
      return { events, acknowledged: [], summary: computeEventPoolSummary(state.events, state.latestSeq) };
    }
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const now = options.now ?? new Date().toISOString();
      const matched: PoolEvent[] = [];
      const acknowledged: PoolEvent[] = [];
      for (const event of state.events) {
        if (event.direction !== "inbound") continue;
        if (!options.includeHandled && event.status !== "pending") continue;
        if (idSet && !idSet.has(event.id)) continue;
        if (event.status === "pending") {
          event.status = "handled";
          event.handledAt = now;
          event.handledBy = "shiori";
          acknowledged.push({ ...event });
        }
        matched.push({ ...event });
      }
      if (acknowledged.length > 0) {
        await this.writeUnlocked(state);
      }
      return {
        events: matched,
        acknowledged,
        summary: computeEventPoolSummary(state.events, state.latestSeq),
      };
    });
  }

  async ack(
    ids: readonly string[],
    actor: PoolEventActor,
    direction?: EventDirection,
    nowIso?: string,
  ): Promise<{ updated: PoolEvent[]; summary: EventPoolSummary }> {
    const cleanIds = ids.map(id => id.trim()).filter(Boolean);
    if (!cleanIds.length) throw new Error("At least one event ID is required");
    const targetIds = new Set(cleanIds);
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const now = nowIso ?? new Date().toISOString();
      const updated: PoolEvent[] = [];
      for (const event of state.events) {
        if (!targetIds.has(event.id)) continue;
        if (direction && event.direction !== direction) continue;
        if (event.status === "pending") {
          event.status = "handled";
          event.handledAt = now;
          event.handledBy = actor;
          updated.push({ ...event });
        }
      }
      if (updated.length > 0) {
        await this.writeUnlocked(state);
      }
      return { updated, summary: computeEventPoolSummary(state.events, state.latestSeq) };
    });
  }
}

/** Resolve an initialized workspace and return its Event Pool store without creating new identities. */
export async function openWorkspaceEventPool(workspacePath: string, globalHome?: string): Promise<WorkspaceEventPool> {
  const state = await resolveWorkspaceState(workspacePath, globalHome);
  return new WorkspaceEventPool(state.dir);
}
