import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/query/aggregate.ts";
import { activityBlocks, queryActivity, refreshActivity } from "../src/query/activity.ts";
import { closeLogIndexes, getLogIndex } from "../src/query/log-index.ts";
import { contextPerception, perceptionRead } from "../src/query/observation-events.ts";
import { readRunProjection, refreshRunProjection, selectIndexedCycle } from "../src/query/run-index.ts";
import type { Event, Manifest } from "../src/query/types.ts";

function eventFactory(defaultEpoch = "epoch-1") {
  let seq = 0;
  return (
    type: string,
    data: Record<string, unknown>,
    trace: Record<string, string> = {},
  ): Event => {
    seq++;
    return {
      seq,
      at: new Date(Date.UTC(2026, 10, 17, 5, 0, seq)).toISOString(),
      atMs: seq * 1000,
      type,
      trace: { epoch: defaultEpoch, ...trace },
      data,
    };
  };
}

test("observation_context and perceptionRead preserve data/space/effect/transition with zero duplicate snapshot and pass through deliveredPayload across all injection modes", () => {
  const e = eventFactory();
  const frame = {
    id: "obs-1",
    mediaType: "image/png",
    timeline: { recordId: "rec-1", sequence: 12, asset: "objects/frame1.bin" },
  };
  const structuredPayload = {
    ok: true,
    records: [
      {
        id: "rec-1",
        sequence: 12,
        recordedAt: "2026-11-17T05:00:01.000Z",
        text: "HP 80/100",
        data: { hp: 80, maxHp: 100 },
        space: { width: 1280, height: 720 },
        effect: { deltaHp: -5 },
        transition: { from: "battle", to: "menu" },
      },
    ],
    extra: [{ note: "boss_phase_2" }],
  };

  const observeEnd = e("perception_observe_end", {
    queryId: "q-structured",
    ok: true,
    query: {},
    hasMore: false,
    records: [
      {
        id: "rec-1",
        sequence: 12,
        recordedAt: "2026-11-17T05:00:01.000Z",
        timeline: { recordId: "rec-1", sequence: 12 },
        text: "HP 80/100",
        data: { hp: 80, maxHp: 100 },
        space: { width: 1280, height: 720 },
        effect: { deltaHp: -5 },
        transition: { from: "battle", to: "menu" },
        media: [frame],
      },
    ],
    outcome: "success",
  });

  const parsedRead = perceptionRead(observeEnd);
  expect(parsedRead).not.toBeNull();
  expect(parsedRead!.snapshot).toBeUndefined();
  expect(parsedRead!.records?.[0]?.snapshot).toMatchObject({
    id: "rec-1",
    sequence: 12,
    data: { hp: 80, maxHp: 100 },
    space: { width: 1280, height: 720 },
    effect: { deltaHp: -5 },
    transition: { from: "battle", to: "menu" },
  });

  const events: Event[] = [
    e("control", { mode: "auto", epoch: "epoch-1" }),
    observeEnd,
    e("observation_context", {
      id: "del-structured",
      origin: "prompt_start",
      observations: ["obs-1"],
      queries: ["q-structured"],
      deliveredPayload: structuredPayload,
      injectionMode: "structured",
      attachImages: true,
    }),
    e("model_start", { deliveryIds: ["del-structured"], observations: ["obs-1"] }, { modelCallId: "call-structured" }),
    e("model_end", { stopReason: "stop", durationMs: 120 }, { modelCallId: "call-structured" }),

    // custom_json without underlying perception query
    e("observation_context", {
      id: "del-json",
      origin: "prompt_start",
      observations: [],
      queries: [],
      deliveredPayload: { customGoal: "defeat_boss", wave: 3 },
      injectionMode: "custom_json",
      attachImages: false,
    }),
    e("model_start", { deliveryIds: ["del-json"], observations: [] }, { modelCallId: "call-json" }),
    e("model_end", { stopReason: "stop", durationMs: 80 }, { modelCallId: "call-json" }),

    // custom_text
    e("observation_context", {
      id: "del-text",
      origin: "prompt_start",
      observations: [],
      queries: [],
      deliveredPayload: "Stage cleared — press A to advance.",
      injectionMode: "custom_text",
      attachImages: false,
    }),
    e("model_start", { deliveryIds: ["del-text"], observations: [] }, { modelCallId: "call-text" }),
    e("model_end", { stopReason: "stop", durationMs: 60 }, { modelCallId: "call-text" }),

    // none (skipped context injection)
    e("observation_context", {
      id: "del-none",
      origin: "prompt_start",
      observations: [],
      queries: [],
      deliveredPayload: null,
      injectionMode: "none",
      attachImages: false,
    }),
    e("model_start", { deliveryIds: ["del-none"], observations: [] }, { modelCallId: "call-none" }),
    e("model_end", { stopReason: "stop", durationMs: 50 }, { modelCallId: "call-none" }),
  ];

  const projected = aggregate(events);
  expect(projected.calls).toHaveLength(4);

  const [cStructured, cJson, cText, cNone] = projected.calls;
  expect(cStructured!.perception?.snapshot).toBeUndefined();
  expect(cStructured!.perception?.injectionMode).toBe("structured");
  expect(cStructured!.perception?.attachImages).toBe(true);
  expect(cStructured!.perception?.deliveredPayload).toEqual(structuredPayload);
  expect(cStructured!.perception?.records?.[0]?.snapshot).toMatchObject({
    id: "rec-1",
    sequence: 12,
    data: { hp: 80, maxHp: 100 },
    space: { width: 1280, height: 720 },
    effect: { deltaHp: -5 },
    transition: { from: "battle", to: "menu" },
  });
  // Per-image observation retains its own record snapshot (with data/space) and no duplicate records array
  expect(projected.observations[0]?.perception?.records).toBeUndefined();
  expect(projected.observations[0]?.perception?.snapshot?.data).toEqual({ hp: 80, maxHp: 100 });
  expect(projected.observations[0]?.perception?.snapshot?.space).toEqual({ width: 1280, height: 720 });

  expect(cJson!.perception?.injectionMode).toBe("custom_json");
  expect(cJson!.perception?.attachImages).toBe(false);
  expect(cJson!.perception?.deliveredPayload).toEqual({ customGoal: "defeat_boss", wave: 3 });

  expect(cText!.perception?.injectionMode).toBe("custom_text");
  expect(cText!.perception?.attachImages).toBe(false);
  expect(cText!.perception?.deliveredPayload).toBe("Stage cleared — press A to advance.");

  expect(cNone!.perception?.injectionMode).toBe("none");
  expect(cNone!.perception?.attachImages).toBe(false);
  expect(cNone!.perception?.deliveredPayload).toBeNull();

  // Direct lean `records` on `observation_context` (without `generation` or `sampling`) also parse cleanly
  const directContext = contextPerception(
    e("observation_context", {
      records: [
        {
          id: "lean-1",
          sequence: 99,
          recordedAt: "2026-11-17T05:01:00.000Z",
          data: { coins: 42 },
          space: { map: "world-1" },
          effect: { collected: 1 },
          transition: "idle->walk",
        },
      ],
      deliveredPayload: { ok: true, records: [{ id: "lean-1", sequence: 99 }] },
      injectionMode: "structured",
      attachImages: false,
    }),
  );
  expect(directContext?.snapshot).toBeUndefined();
  expect(directContext?.records?.[0]?.snapshot).toEqual({
    id: "lean-1",
    sequence: 99,
    recordedAt: "2026-11-17T05:01:00.000Z",
    data: { coins: 42 },
    space: { map: "world-1" },
    effect: { collected: 1 },
    transition: "idle->walk",
  });
});

test("run-index reducers-9 re-projects stale caches and activity projects loop_step, loop_fault, loop_status, and inter-turn capabilities", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-query-loop-")));
  try {
    await mkdir(join(root, "streams"), { recursive: true });
    const e = eventFactory("epoch-loop");
    const rows: Event[] = [
      e("control", { mode: "auto", epoch: "epoch-loop", maxSeconds: 600 }),
      e("loop_status", { state: "ready", generation: "loop-gen-1", codeSHA: "abc12345" }),
      e("loop_step", { turn: 1, action: "wait", seconds: 2, reason: "cooldown", durationMs: 4 }),
      e(
        "capability_end",
        { action: "call", id: "python/actions.py:tap_confirm", outcome: "success", durationMs: 38 },
        { traceId: "t-cap", spanId: "s-cap", recordingPurpose: "loop" },
      ),
      // Ordinary bash subprocess capability call inside active epoch lacks modelCallId AND lacks recordingPurpose="loop" -> must stay diagnostic!
      e(
        "capability_end",
        { action: "call", id: "python/actions.py:from_bash_tool", outcome: "success", durationMs: 19 },
        { traceId: "t-bash-cap", spanId: "s-bash-cap" },
      ),
      e("loop_fault", {
        phase: "step",
        error: "ZeroDivisionError: division by zero",
        fallback: "default_loop",
        codeSHA: "bad123",
      }),
      e("loop_status", { state: "error", generation: null, error: "ZeroDivisionError: division by zero" }),
      e("loop_step", { turn: 2, action: "prompt", durationMs: 3, injectionMode: "custom_json" }),
      e("observation_context", {
        id: "del-loop-1",
        origin: "prompt_start",
        observations: [],
        queries: [],
        deliveredPayload: { custom: "from_loop", loopFault: { phase: "step" } },
        injectionMode: "custom_json",
        attachImages: false,
      }),
      e("model_start", { deliveryIds: ["del-loop-1"], observations: [] }, { modelCallId: "m-1" }),
      e("model_end", { stopReason: "stop", durationMs: 95 }, { modelCallId: "m-1" }),
      e("loop_step", { turn: 3, action: "consolidate", durationMs: 2 }),
      e("loop_step", { turn: 4, action: "stop", reason: "goal_met", durationMs: 1 }),
      e("control", { mode: "manual", epoch: "epoch-loop", reason: "loop: goal_met", elapsedMs: 12_000 }),
    ];
    await writeFile(join(root, "events.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(join(root, "streams/m-1.jsonl"), "");

    const index = getLogIndex(root);
    // Simulate a stale reducers-8 stamp and stale activitySemantics=11 stamp to verify clean cache reset
    index.setMeta("run_projection", `reducers-8:${index.generation}`);
    index.setMeta("run_position", 999);
    index.setMeta("activitySemantics", "11");
    index.setMeta("activityPosition", 999);

    await refreshRunProjection(index);
    expect(index.meta("run_projection")).toBe(`reducers-9:${index.generation}`);

    const manifest: Manifest = {
      runId: "run-1",
      workspace: root,
      socket: join(root, "host.sock"),
      drivers: [],
      model: "openai/gpt-5",
      seconds: 600,
      maxRequests: 100,
      compactionThreshold: null,
    };
    const cycleSelection = await selectIndexedCycle(index, manifest, "epoch-loop");
    expect(cycleSelection.cycles[0]?.reason).toBe("loop: goal_met");

    const run = await readRunProjection(index, "epoch-loop");
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.perception?.injectionMode).toBe("custom_json");
    expect(run.calls[0]?.perception?.deliveredPayload).toEqual({
      custom: "from_loop",
      loopFault: { phase: "step" },
    });

    // Direct activityBlocks + indexed refreshActivity / queryActivity parity
    const directBlocks = await activityBlocks(root, rows);
    await refreshActivity(index);
    expect(index.meta("activitySemantics")).toBe("13");
    const snap = await queryActivity(index, { project: "p", runId: "run-1", epoch: "epoch-loop" });
    const visible = snap.blocks.filter(b => b.kind !== "diagnostic");

    const waitBlock = visible.find(b => b.title === "loop_step" && b.data?.action === "wait");
    expect(waitBlock).toMatchObject({
      kind: "system",
      status: "complete",
      text: "Turn #1 · wait 2s (cooldown)",
      data: {
        role: "loop_step",
        turn: 1,
        action: "wait",
        seconds: 2,
        reason: "cooldown",
        durationMs: 4,
      },
    });

    const capBlock = visible.find(b => b.data?.role === "loop_capability");
    expect(capBlock).toMatchObject({
      kind: "system",
      status: "complete",
      recordingPurpose: "loop",
      text: "python/actions.py:tap_confirm (38ms)",
      data: {
        role: "loop_capability",
        capability: "python/actions.py:tap_confirm",
        outcome: "success",
      },
    });
    expect(visible.some(b => b.text.includes("from_bash_tool"))).toBe(false);
    const bashCapDiag = directBlocks.find(b => b.trace?.spanId === "s-bash-cap");
    expect(bashCapDiag?.kind).toBe("diagnostic");
    expect(bashCapDiag?.recordingPurpose).toBeUndefined();

    const faultBlock = visible.find(b => b.title === "loop_fault");
    expect(faultBlock).toMatchObject({
      kind: "system",
      status: "error",
      text: "loop.py step fault: ZeroDivisionError: division by zero",
      data: {
        role: "loop_fault",
        phase: "step",
        error: "ZeroDivisionError: division by zero",
        fallback: "default_loop",
      },
    });

    const readyStatus = visible.find(b => b.title === "loop_status" && b.data?.state === "ready");
    expect(readyStatus?.status).toBe("complete");
    const errStatus = visible.find(b => b.title === "loop_status" && b.data?.state === "error");
    expect(errStatus?.status).toBe("error");

    const stopBlock = visible.find(b => b.title === "loop_step" && b.data?.action === "stop");
    expect(stopBlock?.text).toBe("Turn #4 · stop (goal_met)");

    // Ensure direct and indexed projections produce matching loop blocks
    expect(
      directBlocks
        .filter(b => ["loop_step", "loop_fault", "loop_status"].includes(b.title))
        .map(b => [b.title, b.status, b.text]),
    ).toEqual(
      visible
        .filter(b => ["loop_step", "loop_fault", "loop_status"].includes(b.title))
        .map(b => [b.title, b.status, b.text]),
    );
  } finally {
    await closeLogIndexes();
    await rm(root, { recursive: true, force: true });
  }
});
