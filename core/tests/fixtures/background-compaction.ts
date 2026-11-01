import type { PerfContext } from "../../src/perf/run-context.ts";
import { nativeCompaction, threshold } from "./native-compaction.ts";
import { readEvents, seqs, until } from "../../src/perf/evidence.ts";

export async function measureBackgroundCompaction(ctx: PerfContext): Promise<Record<string, any>> {
  ctx.signal?.throwIfAborted();
  const record = ctx.log.recorder({ component: "benchmark" });
  const originEpoch = crypto.randomUUID(), laterEpoch = crypto.randomUUID(), cancelEpoch = crypto.randomUUID();
  let requests = 0, commits = 0, tailPreserved = false, originalLeaf = false;
  let cancellationMs = 0, cancellationSettled = false, cancelCommitted = false;
  const f = await nativeCompaction(ctx, originEpoch);
  try {
    record("benchmark_scenario", { scenario: "late-ready", thresholdTokens: threshold }, { epoch: originEpoch });
    await f.start();
    f.appendTail();
    f.changeEpoch(laterEpoch);
    record("benchmark_epoch_changed", { originalEpoch: originEpoch, newEpoch: laterEpoch }, { epoch: laterEpoch });
    const { completion } = await f.block();
    await Bun.sleep(35);
    ctx.signal?.throwIfAborted();
    f.finishResponse();
    await completion;
    ctx.signal?.throwIfAborted();
    commits = f.compactions().length; requests = f.requests.length;
    originalLeaf = f.compactions()[0]?.providerReplayThroughEntryId === f.initialLeafId;
    tailPreserved = JSON.stringify(f.agent.state.messages.slice(1)) === JSON.stringify(f.tail);
    record("benchmark_compaction_applied", { requests, commits, tailPreserved, originalLeaf,
      tailMessages: f.tail.length, retainedMessages: f.agent.state.messages.length - 1,
      historyEvidence: ctx.log.artifact({ snapshotLeafId: f.initialLeafId, compactions: f.compactions(),
        expectedTail: f.tail, actualTail: f.agent.state.messages.slice(1) }) }, { epoch: laterEpoch });
  } finally { await f.close(); }

  const cancelled = await nativeCompaction(ctx, cancelEpoch);
  try {
    record("benchmark_scenario", { scenario: "cancel-then-late-response", thresholdTokens: threshold }, { epoch: cancelEpoch });
    await cancelled.start();
    const { completion } = await cancelled.block();
    const requestedAt = performance.now();
    let settled = false;
    void completion.then(() => { settled = true; });
    cancelled.maintenance.abortCompaction(new Error("Benchmark control budget ended"));
    await until(() => settled, 5_000, ctx.signal);
    cancellationMs = performance.now() - requestedAt;
    cancellationSettled = settled && cancelled.requests[0]?.signal?.aborted === true;
    cancelled.finishResponse();
    await cancelled.maintenance.speculationCompletion;
    await Bun.sleep(10);
    ctx.signal?.throwIfAborted();
    cancelCommitted = cancelled.compactions().length > 0;
    record("benchmark_compaction_cancelled", { cancellationSettled, cancelCommitted, cancellationMs,
      requests: cancelled.requests.length, commits: cancelled.compactions().length }, { epoch: cancelEpoch });
  } finally { await cancelled.close(); }

  await ctx.log.flush();
  const events = await readEvents(ctx.runDir);
  const started = events.find(e => e.type === "compaction_speculation" && e.data.stage === "started" && e.trace.epoch === originEpoch);
  const lifecycle = events.filter(e => e.type === "compaction_speculation" && e.trace.operationId === started?.trace.operationId);
  const armed = lifecycle.find(e => e.data.stage === "armed");
  const applied = lifecycle.find(e => e.data.stage === "applied");
  const http = events.filter(e => e.type === "compaction_http_start" && e.trace.operationId === started?.trace.operationId);
  const maintenance = events.find(e => e.type === "auto_compaction_end" && e.trace.epoch === laterEpoch);
  const headers = events.find(e => e.type === "compaction_http_end" && e.trace.httpId === http[0]?.trace.httpId);
  const spans = new Set(events.flatMap(e => e.trace.spanId ? [e.trace.spanId] : []));
  const orphanParents = events.filter(e => e.trace.parentSpanId && !spans.has(e.trace.parentSpanId));
  ctx.metadata.limitations = ["使用真实 OMP SessionMaintenance、原生 V2 序列化/解析、提交与历史重放；摘要内容和网络等待由本地 SSE fixture 控制。", "fixture 显式固定 256000 阈值，并提供接近阈值的 token 计数触发维护路径；不改变真实 workspace 配置。", "取消场景含预期取消事件，不应当作真实运行故障率。"];
  return {
    requests, commits, originalLeaf, tailPreserved, cancellationSettled, cancelCommitted, cancellationMs,
    originEpoch, laterEpoch, cancelEpoch, started, armed, applied, lifecycle, http, maintenance, headers,
    orphanParents: orphanParents.map(event => ({ seq: event.seq, trace: event.trace })),
    evidence: seqs(events, e => e.type.startsWith("compaction_") || e.type.startsWith("benchmark_") || e.type === "auto_compaction_end"),
  };
}

export function verifyBackgroundCompaction(m: any) {
  const linked = !!m.started?.trace.traceId && !!m.started.trace.spanId && !!m.armed && !!m.applied &&
    m.lifecycle.every((e: any) => e.trace.epoch === m.originEpoch && e.trace.spanId === m.started.trace.spanId) &&
    m.http.length === 1 && m.http.every((e: any) => e.trace.epoch === m.originEpoch && e.trace.parentSpanId === m.started.trace.spanId && e.trace.traceId === m.started.trace.traceId);
  const checks = { "reuse-candidate": m.requests === 1 && m.commits === 1 && m.originalLeaf,
    "tail-preserved": m.tailPreserved, "late-identity": linked && m.orphanParents.length === 0,
    "headers-not-ready": !!m.headers && !!m.armed && m.headers.atMs < m.armed.atMs,
    "cancel-no-commit": m.cancellationSettled && !m.cancelCommitted };
  const optional = { "prepare-ms": m.armed?.data.durationMs, "foreground-wait-ms": m.maintenance?.data.durationMs };
  const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  return { rewards: { ...Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, Number(value)])),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => typeof value === "number")),
    "summary-requests": m.requests, "duplicate-summary": Math.max(0, m.requests - 1), "orphan-parents": m.orphanParents.length, "cancel-ms": m.cancellationMs },
    details: { checks, evidence: m.evidence, omitted: Object.keys(optional).filter(key => typeof optional[key as keyof typeof optional] !== "number") }, failures };
}

