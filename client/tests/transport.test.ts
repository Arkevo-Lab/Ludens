import { test } from "node:test";
import assert from "node:assert/strict";
import { medianRequestWaits, requestWait, sseFallbackReason } from "@ludens/protocol/transport";
import type { Call } from "@ludens/protocol/types";

const call = (details: Call["transportDetails"]) => ({
  transport: "sse" as const,
  transportDetails: details,
});

function makeCall(overrides: Partial<Call>): Call {
  return {
    id: "c",
    index: 0,
    at: "2026-11-19T00:00:00.000Z",
    atMs: 0,
    durationMs: 4000,
    headersMs: null,
    firstStreamMs: null,
    status: "complete",
    transport: "sse",
    transportDetails: null,
    phases: {},
    ...overrides,
  } as unknown as Call;
}

test("fallback display uses explicit flags and never guesses an unknown or permanent cause", () => {
  assert.equal(sseFallbackReason(call(null), 0), null);
  assert.equal(sseFallbackReason(call({}), 0), null);
  assert.equal(
    sseFallbackReason(call({ sizeBlockedUntilCompaction: true }), 0),
    "尺寸阻断，等待 OMP 原生压缩",
  );
  assert.equal(
    sseFallbackReason(call({ websocketDisabled: true, retryWebsocketAt: 10000 }), 0),
    "会话已回退",
  );
  assert.equal(
    sseFallbackReason({ ...call({ sizeBlockedUntilCompaction: true }), transport: "websocket" }, 0),
    null,
  );
});

test("the recorded cooldown deadline changes to next-request retry eligibility, not retry success", () => {
  const pending = call({ retryWebsocketAt: 60000 });
  assert.equal(sseFallbackReason(pending, 31000), "握手超时，60 秒冷却中（剩余 29 秒）");
  assert.equal(sseFallbackReason(pending, 59999), "握手超时，60 秒冷却中（剩余 1 秒）");
  assert.equal(
    sseFallbackReason(pending, 60000),
    "握手超时的冷却已到期，下一次请求可重试 WS",
  );
});

test("mixed runs show HTTP and WS wait medians separately without inventing missing milestones", () => {
  const calls: Call[] = [
    makeCall({ id: "http", transport: "sse", headersMs: 1800, durationMs: 4000 }),
    makeCall({
      id: "ws",
      transport: "websocket",
      durationMs: 5000,
      phases: { afterDispatchMs: 650 },
    }),
    makeCall({
      id: "missing",
      transport: "websocket",
      durationMs: 5000,
      phases: {},
    }),
    makeCall({
      id: "pending",
      transport: "websocket",
      durationMs: null,
      phases: { afterDispatchMs: 4900 },
    }),
  ];
  assert.deepEqual(requestWait(calls[1]!), { label: "WS 首事件等待", ms: 650 });
  assert.deepEqual(requestWait(calls[2]!), { label: "WS 首事件等待", ms: null });
  assert.deepEqual(medianRequestWaits(calls), [
    { label: "HTTP 响应头等待", ms: 1800 },
    { label: "WS 首事件等待", ms: 650 },
  ]);
  assert.deepEqual(medianRequestWaits(calls.slice(2)), [
    { label: "WS 首事件等待", ms: null },
  ]);
  assert.deepEqual(requestWait({ ...calls[0]!, transport: null }), {
    label: "等待（传输未记录）",
    ms: null,
  });
});
