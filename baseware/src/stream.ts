import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArguments, ToolExecutionResult } from "./contracts.ts";

interface StreamState {
  lastContinuousReadAt: number;
  inFlight?: Promise<ToolExecutionResult>;
  timer?: ReturnType<typeof setInterval>;
  frame?: { result: ToolExecutionResult; sequence: number; producedAt: number; consumed: boolean };
  consumedSequence: number;
}

/** Bounded local media spool with look-ahead capture for continuous readers. */
export class ObservationStreamSpool {
  private readonly streamDir?: string;
  private readonly maxFiles: number;
  private readonly sampleHz: number;
  private readonly prefetch: boolean;
  private directory?: Promise<string>;
  private temporary = false;
  private files: string[] = [];
  private seq = 0;
  private frameSequence = 0;
  private states = new Map<string, StreamState>();
  private closed = false;

  constructor(options: { streamDir?: string; maxFiles?: number; sampleHz?: number; prefetch?: boolean } = {}) {
    this.streamDir = options.streamDir;
    this.maxFiles = options.maxFiles ?? 128;
    const configuredHz = Number(process.env.LUDENS_PERCEPTION_SAMPLE_HZ ?? 30);
    this.sampleHz = options.sampleHz ?? (Number.isFinite(configuredHz) && configuredHz > 0 ? configuredHz : 30);
    this.prefetch = options.prefetch ?? false;
  }

  private dir() {
    if (!this.directory) {
      const configured = this.streamDir;
      this.directory = configured
        ? rm(configured, { recursive: true, force: true }).then(() => mkdir(configured, { recursive: true })).then(() => configured)
        : mkdtemp(join(tmpdir(), "baseware-stream-")).then(path => { this.temporary = true; return path; });
    }
    return this.directory;
  }

  private async retain(path: string) {
    this.files.push(path);
    while (this.files.length > this.maxFiles) {
      const oldest = this.files.shift()!;
      try { await unlink(oldest); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  async spool(result: ToolExecutionResult, options?: { omitInlineMedia?: boolean }): Promise<ToolExecutionResult> {
    if (!options?.omitInlineMedia || !result.observations?.length || !result.result?.content?.length) return result;
    const observations = result.observations.map(observation => ({ ...observation }));
    const content = [...result.result.content];
    for (const obs of observations) {
      if (obs.contentIndex === undefined) continue;
      const block = content[obs.contentIndex];
      if ((block?.type !== "image" && block?.type !== "audio") || typeof block.data !== "string" || !block.data.length) continue;
      if (!obs.path) {
        const raw = Buffer.from(block.data, "base64");
        const sha256 = createHash("sha256").update(raw).digest("hex");
        const path = join(await this.dir(), `${++this.seq}-${sha256.slice(0, 16)}.bin`);
        await writeFile(path, raw);
        await this.retain(path);
        obs.path = path;
        obs.sha256 = sha256;
        obs.bytes = raw.byteLength;
      }
      content[obs.contentIndex] = Object.assign({}, block, { data: "", path: obs.path,
        ...(obs.sha256 ? { sha256: obs.sha256 } : {}),
        ...(obs.bytes !== undefined ? { bytes: obs.bytes } : {}) });
      obs.data = undefined;
    }
    return { ...result, observations, result: { ...result.result, content } };
  }

  private capture(state: StreamState, executeRaw: () => Promise<ToolExecutionResult>) {
    if (state.inFlight) return state.inFlight;
    const pending = executeRaw().then(result => this.spool(result, { omitInlineMedia: true })).then(result => {
      state.frame = { result, sequence: ++this.frameSequence, producedAt: performance.now(), consumed: false };
      return result;
    }).finally(() => { if (state.inFlight === pending) state.inFlight = undefined; });
    state.inFlight = pending;
    return pending;
  }

  private produce(controllerId: string, state: StreamState, executeRaw: () => Promise<ToolExecutionResult>) {
    if (state.timer || this.closed) return;
    state.timer = setInterval(() => {
      if (this.closed || performance.now() - state.lastContinuousReadAt >= 1500) {
        clearInterval(state.timer);
        state.timer = undefined;
        return;
      }
      if (!state.inFlight) void this.capture(state, executeRaw).catch(() => {});
    }, Math.max(5, Math.floor(1000 / this.sampleHz)));
    state.timer.unref();
  }

  async readOrProduce(controllerId: string, args: ToolArguments, continuous: boolean, omitInlineMedia: boolean,
    executeRaw: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const eligible = omitInlineMedia && continuous && Object.keys(args)
      .filter(key => args[key] !== undefined && !(key === "delayMs" && args[key] === 0)).length === 0;
    if (!eligible) return this.spool(await executeRaw(), { omitInlineMedia });
    const state = this.states.get(controllerId) ?? { lastContinuousReadAt: 0, consumedSequence: 0 };
    this.states.set(controllerId, state);
    state.lastContinuousReadAt = performance.now();
    if (this.prefetch) {
      this.produce(controllerId, state, executeRaw);
      const frame = state.frame;
      if (frame && (!frame.consumed || (performance.now() - frame.producedAt <= 1000 / this.sampleHz
        && frame.sequence > state.consumedSequence))) {
        frame.consumed = true;
        state.consumedSequence = frame.sequence;
        return frame.result;
      }
    }
    const result = await this.capture(state, executeRaw);
    const current = state.frame!;
    current.consumed = true;
    state.consumedSequence = current.sequence;
    return result;
  }

  stopProducers() {
    for (const state of this.states.values()) {
      clearInterval(state.timer);
      state.timer = undefined;
      state.frame = undefined;
    }
  }

  async close() {
    this.closed = true;
    this.stopProducers();
    await Promise.allSettled([...this.states.values()].flatMap(state => state.inFlight ? [state.inFlight] : []));
    this.states.clear();
    const retained = this.files.splice(0);
    await Promise.allSettled(retained.map(file => unlink(file)));
    if (this.temporary && this.directory) {
      const directory = await this.directory;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
