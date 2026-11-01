import type { Context } from "@oh-my-pi/pi-ai/types";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { ModelTrace } from "../../src/core/agent-omp/trace.ts";
import type { PerfContext } from "../../src/perf/run-context.ts";
import { codexTransport, fixtureModel, inputTexts, userMessage, type SimulatedSocket } from "./codex-transport.ts";
import { readEvents, seqs } from "../../src/perf/evidence.ts";

const conditions = [
  { id: "expiry", label: "连接到期", observed: "2026-10-18 6h run",
    fault: "connection_limit_reached after empty reasoning", inject: (socket: SimulatedSocket) => socket.expire() },
  { id: "close-1012", label: "响应中关闭 1012", observed: "2026-10-19/20 8h run",
    fault: "websocket closed (1012) before deliverable output", inject: (socket: SimulatedSocket) => socket.closeFromServer(1012) },
] as const;

export async function measureWsRecovery(ctx: PerfContext): Promise<Record<string, any>> {
  const outcomes: Record<string, any>[] = [];
  for (const condition of conditions) outcomes.push(await runCondition(ctx, condition));
  ctx.metadata.limitations = [
    "这是有生产故障依据的 TDD 特例：6h 长跑的连接到期，以及 8h 长跑的响应中关闭 1012；只重建传输工况，不包含用户历史。",
    "运行真实 OMP Codex provider 和 ModelTrace；WS/SSE 均为进程内传输 fixture，不访问在线模型。",
    "通过虚拟 Date.now 推进 60 秒冷却；计时使用真实 performance.now，只反映本地处理开销，不代表在线上传、网络或服务端性能。",
    "每个工况的无重放请求故意产生一次 model_end:error，这是预期故障证据。",
  ];
  return { conditions: outcomes };
}

async function runCondition(ctx: PerfContext, condition: typeof conditions[number]): Promise<Record<string, any>> {
  ctx.signal?.throwIfAborted();
  const transport = codexTransport();
  const originalNow = Date.now;
  let virtualNow = originalNow();
  Date.now = () => virtualNow;
  const epoch = crypto.randomUUID();
  const record = ctx.log.recorder({ component: "benchmark" });
  const trace = new ModelTrace(ctx.log, () => ({ epoch }));
  const stream = trace.wrap(transport.stream as StreamFn);
  const initialText = `seed-${ctx.seed}:` + "stable history ".repeat(4_096);
  let history: Context = { messages: [userMessage(initialText)] };
  const results: string[] = [];
  const outputs: string[] = [];
  const durations: number[] = [];
  const steps: Record<string, unknown>[] = [];
  const step = async (name: string, text?: string) => {
    ctx.signal?.throwIfAborted();
    if (text) history = { messages: [...history.messages, userMessage(text)] };
    const began = performance.now();
    const response = await (await stream(fixtureModel, history, { ...transport.options, signal: ctx.signal })).result();
    ctx.signal?.throwIfAborted();
    durations.push(performance.now() - began); results.push(response.stopReason);
    outputs.push(response.content.filter(block => block.type === "text").map(block => block.text).join(""));
    history = { messages: [...history.messages, response] };
    steps.push({ name, stopReason: response.stopReason, output: outputs.at(-1), virtualNow,
      frames: transport.frames.length, httpRequests: transport.http.length, connections: transport.sockets.length,
      retryWebsocketAt: transport.details().retryWebsocketAt,
      lastHttpInput: transport.http.length ? inputTexts(transport.http.at(-1)!) : [],
      lastFrameInput: transport.frames.length ? inputTexts(transport.frames.at(-1)!) : [],
      previousResponseId: transport.frames.at(-1)?.previous_response_id });
    record("benchmark_transport_step", { condition: condition.id, name, stopReason: response.stopReason, details: transport.details(),
      frames: transport.frames.length, httpRequests: transport.http.length, connections: transport.sockets.length,
      durationMs: durations.at(-1), output: outputs.at(-1) }, { epoch });
    return response;
  };
  let delivered = 0, noReplayHttpBefore = 0, noReplayHttpAfter = 0;
  let partialStopReason = "";
  let fullBytes = 0, deltaBytes = 0;
  try {
    await step("initial-ws");
    transport.onSend(socket => {
      // Empty reasoning has not delivered text or a tool: recovery must remain safe.
      socket.message({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_empty", summary: [], content: [] } });
      condition.inject(socket);
    });
    record("benchmark_fault", { condition: condition.id, observed: condition.observed, fault: condition.fault,
      simulation: "in-process WS/HTTP; virtual cooldown; no online latency measurement", virtualCooldownMs: 60_000 }, { epoch });
    await step("failure-to-sse", "request-two");
    virtualNow += 59_999;
    await step("cooldown-sse", "request-three");
    virtualNow += 2;
    transport.onSend(socket => transport.complete(socket));
    await step("restored-full-ws", "request-four");
    fullBytes = transport.frameBytes[2] ?? 0;
    await step("restored-delta-ws", "request-five");
    deltaBytes = transport.frameBytes[3] ?? 0;
    transport.onSend(socket => {
      const item = { type: "function_call", id: "fc_once", call_id: "call_once", name: "move", arguments: "" };
      socket.message({ type: "response.output_item.added", item });
      socket.message({ type: "response.output_item.done", item: { ...item, arguments: "{}" } });
      condition.inject(socket);
    });
    const before = transport.http.length;
    ctx.signal?.throwIfAborted();
    const partial = await stream(fixtureModel, { messages: [...history.messages, userMessage("use one tool")] }, { ...transport.options, signal: ctx.signal });
    for await (const event of partial) if (event.type === "toolcall_end") delivered++;
    const partialResult = await partial.result();
    ctx.signal?.throwIfAborted();
    noReplayHttpBefore = before; noReplayHttpAfter = transport.http.length; partialStopReason = partialResult.stopReason;
    record("benchmark_no_replay", { condition: condition.id, delivered, httpBefore: before, httpAfter: transport.http.length,
      stopReason: partialResult.stopReason }, { epoch });
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { Date.now = originalNow; transport.close(); }
  await ctx.log.flush();
  const events = (await readEvents(ctx.runDir)).filter(event => event.trace?.epoch === epoch);
  const evidence = seqs(events, e => e.type === "benchmark_transport_step" || e.type === "benchmark_fault");
  return {
    id: condition.id, initialText, steps, durations, fullBytes, deltaBytes, delivered,
    noReplayHttpBefore, noReplayHttpAfter, partialStopReason,
    httpRequests: transport.http.length, connections: transport.sockets.length,
    evidence,
    noReplayEvidence: seqs(events, e => e.type === "benchmark_no_replay" || e.type === "model_end" && e.data.stopReason === "error"),
  };
}

export function verifyWsRecovery(m: any) {
  if (!Array.isArray(m.conditions) || m.conditions.length !== 2) throw new Error("Both recovery conditions are required");
  const rewards: Record<string, number> = {}, details: any[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const c of m.conditions) {
    const [, fallback, cooldown, full, delta] = c.steps;
    const checks = {
      "responses-completed": c.steps.length === 5 && c.steps.every((s: any) => s.stopReason === "stop" && s.output === "OK"),
      fallback: fallback.httpRequests === 1 && fallback.frames === 2 && same(fallback.lastHttpInput, [c.initialText, "request-two"]) && fallback.retryWebsocketAt === fallback.virtualNow + 60_000,
      cooldown: cooldown.connections === 1 && cooldown.frames === 2 && cooldown.httpRequests === 2,
      restore: full.connections === 2 && full.httpRequests === 2 && full.previousResponseId === undefined && full.retryWebsocketAt === undefined && same(full.lastFrameInput, [c.initialText, "request-two", "request-three", "request-four"]),
      delta: delta.httpRequests === 2 && delta.previousResponseId === "ws_3" && same(delta.lastFrameInput, ["request-five"]),
      "no-tool-replay": c.delivered === 1 && c.noReplayHttpBefore === c.noReplayHttpAfter && c.partialStopReason === "error",
    };
    for (const [key, value] of Object.entries(checks)) rewards[c.id + "-" + key] = Number(value);
    Object.assign(rewards, Object.fromEntries(Object.entries({ restored: Number(checks.restore && checks.delta), "sse-requests": c.httpRequests,
      connections: c.connections, "full-frame-bytes": c.fullBytes, "delta-frame-bytes": c.deltaBytes,
      ...(c.fullBytes ? { "delta-ratio": c.deltaBytes / c.fullBytes * 100 } : {}),
      "local-request-ms": c.durations.reduce((a: number, b: number) => a + b, 0) / c.durations.length }).map(([key, value]) => [c.id + "-" + key, value])));
    details.push({ id: c.id, checks, evidence: c.evidence, noReplayEvidence: c.noReplayEvidence,
      omitted: c.fullBytes ? [] : ["delta-ratio: no full frame bytes"] });
  }
  return { rewards, details, failures: [...details.flatMap((d: any) => Object.entries(d.checks).filter(([, passed]) => passed !== true).map(([key]) => `${d.id}-${key}`))] };
}

