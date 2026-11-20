import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mediaFailureMessage, selectObservations } from "../features/live/observation-model";
import { ObservationPanel } from "../features/live/run-visuals";
import { LocaleProvider } from "../lib/locale";
import type { Call, Observation, PerceptionSnapshot, RunData } from "@ludens/protocol/types";

function makeCall(overrides: Partial<Call> = {}): Call {
  return {
    id: "call-1",
    index: 0,
    at: "2026-11-19T00:00:02.000Z",
    atMs: 2000,
    durationMs: 1000,
    headersMs: null,
    firstStreamMs: null,
    status: "complete",
    transport: "sse",
    transportDetails: null,
    phases: {},
    usage: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    tools: [],
    observations: [],
    inputObservations: [],
    ...overrides,
  } as unknown as Call;
}

function makeRunData(overrides: Partial<RunData> = {}): RunData {
  return {
    project: "test",
    run: "test",
    workspace: "/tmp/test",
    manifest: null,
    status: {
      state: "idle",
      mode: "manual",
      cycle: 1,
      requests: 1,
      model: "test-model",
      drivers: [],
      auto: false,
      autoSecondsLeft: null,
      pausedReason: null,
      epoch: null,
      runId: "test",
      updatedAt: null,
    },
    cycles: [],
    calls: [],
    tools: [],
    observations: [],
    notices: [],
    spans: [],
    spanStats: [],
    perception: null,
    ...overrides,
  } as unknown as RunData;
}

test("metadata-only deliveries render as unrecorded without broken media requests", () => {
  const observation: Observation = {
    id: "input",
    controller: "bash",
    mediaType: "image/png",
    origin: "tool_result",
    mediaStorage: "unrecorded",
    at: "2026-11-19T00:00:01.000Z",
  };
  const call = makeCall({
    id: "call",
    inputObservations: ["input"],
    observations: ["input"],
  });
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ObservationPanel, {
        data: makeRunData({ observations: [observation], calls: [call] }),
        call,
        onImage() {},
      }),
    ),
  );
  assert.match(html, /Unrecorded · delivery record only/);
  assert.doesNotMatch(html, /<img|\/api\/media/);
  assert.equal(mediaFailureMessage(410), "观测已过期或已移除");
});

test("data-only and mixed model inputs expose lazy record details without duplicating data in projections", () => {
  for (const withImage of [false, true]) {
    const snapshots: PerceptionSnapshot[] = [1, 2].map(sequence => ({
      id: `record-${sequence}`,
      sequence,
      timeline: { recordId: `record-${sequence}`, sequence },
      generation: null,
      recordedAt: new Date(sequence * 1000).toISOString(),
      sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 },
    }));
    const observations: Observation[] = withImage
      ? [
          {
            id: "frame",
            controller: "perception",
            mediaType: "image/png",
            origin: "perception",
            mediaStorage: "timeline",
            at: snapshots[1]!.recordedAt,
            perception: {
              at: snapshots[1]!.recordedAt,
              snapshot: snapshots[1]!,
            },
          },
        ]
      : [];
    const call = makeCall({
      id: "input",
      inputObservations: withImage ? ["frame"] : [],
      observations: withImage ? ["frame"] : [],
      perception: {
        at: snapshots[1]!.recordedAt,
        status: { state: "ready", generation: "sampler" },
        snapshot: snapshots[1]!,
        records: snapshots.map((snapshot, index) => ({
          snapshot,
          text: "",
          observations: index && withImage ? [{ id: "frame" }] : [],
        })),
      },
    });
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(ObservationPanel, {
          data: makeRunData({ observations, calls: [call] }),
          call,
          onImage() {},
          onOpenReplayAt() {},
        }),
      ),
    );
    assert.match(html, /Record #1 · perception data/);
    assert.match(html, /Record #2 · perception data/);
    assert.match(html, /class="codex-replay-jump-link"/);
    assert.doesNotMatch(html, /No viewable input frame|Loading timeline record/);
    if (!withImage) assert.match(html, /This input contains 2 timeline records/);
  }
});

test("canonical queries render record details and select observations cleanly", () => {
  const oldSnapshot: PerceptionSnapshot = {
    id: "old",
    sequence: 1,
    timeline: { recordId: "old", sequence: 1 },
    generation: "worker",
    recordedAt: new Date(1000).toISOString(),
    sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 },
  };
  const sensorSnapshot: PerceptionSnapshot = {
    id: "sensor",
    sequence: 2,
    timeline: { recordId: "sensor", sequence: 2 },
    generation: "worker",
    recordedAt: new Date(2000).toISOString(),
    sampling: { clock: "sensor", startedAtMs: 0, finishedAtMs: 1 },
  };
  const imageObs: Observation = {
    id: "image",
    controller: "perception",
    mediaType: "image/png",
    origin: "explicit",
    mediaStorage: "timeline",
    at: oldSnapshot.recordedAt,
    perception: { at: oldSnapshot.recordedAt, snapshot: oldSnapshot },
  };
  const call = makeCall({
    id: "model",
    inputObservations: ["image"],
    observations: ["image"],
    inputText: "read old\n\nread sensor",
    perceptionReads: [
      {
        at: oldSnapshot.recordedAt,
        queryId: "history",
        ok: true,
        durationMs: 7,
        records: [{ snapshot: oldSnapshot, text: "read old", observations: [{ id: "image" }] }],
      },
      {
        at: sensorSnapshot.recordedAt,
        queryId: "sensor",
        ok: true,
        records: [{ snapshot: sensorSnapshot, text: "read sensor", observations: [] }],
      },
    ],
  });

  const selected = selectObservations([imageObs], call, "image");
  assert.equal(selected.observation?.perception?.snapshot?.id, "old");
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ObservationPanel, {
        data: makeRunData({ observations: [imageObs], calls: [call] }),
        call,
        onImage() {},
      }),
    ),
  );
  assert.match(html, /This query · succeeded/);
  assert.match(html, /Record #1/);
  assert.match(html, /Record #2/);
});

test("a failed delivery shows its error while keeping query source records out of the model-input panel", () => {
  const failedRead = {
    at: "2026-11-19T00:00:04.000Z",
    queryId: "query",
    ok: true,
    error: "image encoding failed",
    deliveryError: "image encoding failed",
    records: [
      {
        snapshot: {
          id: "source",
          sequence: 1,
          timeline: { recordId: "source", sequence: 1 },
          recordedAt: "2026-11-19T00:00:01.000Z",
        },
        text: "source not delivered",
        observations: [{ id: "frame" }],
      },
    ],
  };
  const call = makeCall({
    id: "model",
    inputObservations: [],
    observations: [],
    perception: failedRead,
    perceptionReads: [failedRead],
  });
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ObservationPanel, {
        data: makeRunData({ calls: [call] }),
        call,
        onImage() {},
      }),
    ),
  );
  assert.match(html, /This query · succeeded/);
  assert.match(html, /input delivery failed/);
  assert.match(html, /image encoding failed/);
  assert.doesNotMatch(html, /source not delivered|Record #1|<img|\/api\/media/);
});
