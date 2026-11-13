import assert from "node:assert/strict";
import test from "node:test";
import {
  BOTTOM_DETACH_MIN_DISTANCE_PX,
  BOTTOM_REATTACH_THRESHOLD_PX,
  computeBottomDistance,
  computeTailActivitySignature,
  countNewTailBlocks,
  createTailPauseBaseline,
  evaluateScrollFollowTransition,
} from "../features/live/use-live-auto-scroll";
import type { ActivityBlock } from "../features/live/activity-feed-model";
import type { StreamSegment } from "../features/live/shiori-segments";

function makeBlock(
  id: string,
  at: string,
  overrides: Partial<ActivityBlock> = {},
): ActivityBlock {
  return {
    id,
    kind: "text",
    at,
    title: "Assistant",
    text: "hello",
    status: "complete",
    createdRevision: 1,
    revision: 1,
    ...overrides,
  };
}

test("computeBottomDistance clamps negative overflow to zero", () => {
  assert.equal(
    computeBottomDistance({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }),
    100,
  );
  assert.equal(
    computeBottomDistance({ scrollHeight: 800, scrollTop: 450, clientHeight: 400 }),
    0,
  );
});

test("evaluateScrollFollowTransition never detaches when content grows below viewport without upward user intent", () => {
  // User was pinned at bottom (scrollTop = 600, clientHeight = 400, scrollHeight = 1000),
  // then a tall assistant turn / image expands scrollHeight to 1320 before scrollTop catches up.
  const res = evaluateScrollFollowTransition({
    currentlyFollowing: true,
    manualHold: false,
    prevScrollTop: 600,
    currentScrollTop: 600,
    scrollHeight: 1320,
    clientHeight: 400,
    isProgrammatic: false,
    hasUpwardUserIntent: false,
  });

  assert.equal(res.nextFollowing, true);
  assert.equal(res.bottomDistance, 320);
  assert.equal(res.scrolledUp, false);
});

test("evaluateScrollFollowTransition detaches on genuine upward scroll or wheel intent past threshold", () => {
  const wheelDetach = evaluateScrollFollowTransition({
    currentlyFollowing: true,
    manualHold: false,
    prevScrollTop: 600,
    currentScrollTop: 540,
    scrollHeight: 1000,
    clientHeight: 400,
    isProgrammatic: false,
    hasUpwardUserIntent: true,
  });
  assert.equal(wheelDetach.nextFollowing, false);
  assert.ok(wheelDetach.bottomDistance > BOTTOM_DETACH_MIN_DISTANCE_PX);

  // Programmatic scroll (e.g., smooth glide or prepend anchor adjustment) preserves follow state
  const programmatic = evaluateScrollFollowTransition({
    currentlyFollowing: true,
    manualHold: false,
    prevScrollTop: 600,
    currentScrollTop: 480,
    scrollHeight: 1000,
    clientHeight: 400,
    isProgrammatic: true,
    hasUpwardUserIntent: false,
  });
  assert.equal(programmatic.nextFollowing, true);
});

test("evaluateScrollFollowTransition re-attaches near bottom and respects header manualHold", () => {
  // When paused via header toggle while already at bottom (bottomDistance = 0), passive scroll events stay paused
  const heldAtBottom = evaluateScrollFollowTransition({
    currentlyFollowing: false,
    manualHold: true,
    prevScrollTop: 600,
    currentScrollTop: 600,
    scrollHeight: 1000,
    clientHeight: 400,
    isProgrammatic: false,
    hasUpwardUserIntent: false,
  });
  assert.equal(heldAtBottom.nextFollowing, false);
  assert.equal(heldAtBottom.nextManualHold, true);

  // Once scrolled away from bottom, manualHold clears so scrolling back down re-attaches naturally
  const scrolledAway = evaluateScrollFollowTransition({
    currentlyFollowing: false,
    manualHold: true,
    prevScrollTop: 600,
    currentScrollTop: 420,
    scrollHeight: 1000,
    clientHeight: 400,
    isProgrammatic: false,
    hasUpwardUserIntent: true,
  });
  assert.equal(scrolledAway.nextFollowing, false);
  assert.equal(scrolledAway.nextManualHold, false);

  const returnedToBottom = evaluateScrollFollowTransition({
    currentlyFollowing: false,
    manualHold: scrolledAway.nextManualHold,
    prevScrollTop: 420,
    currentScrollTop: 1000 - 400 - (BOTTOM_REATTACH_THRESHOLD_PX - 4),
    scrollHeight: 1000,
    clientHeight: 400,
    isProgrammatic: false,
    hasUpwardUserIntent: false,
  });
  assert.equal(returnedToBottom.nextFollowing, true);
});

test("computeTailActivitySignature detects intra-turn streaming growth while ignoring prepended history", () => {
  const b1 = makeBlock("b1", "2026-11-13T04:00:01.000Z", { text: "step 1" });
  const b2 = makeBlock("b2", "2026-11-13T04:00:02.000Z", { text: "Streaming answer" });
  const turnSeg: StreamSegment = {
    kind: "turn",
    id: "turn:1",
    steps: [b1],
    responseBlock: b2,
    responseText: "Streaming answer",
  };

  const sigInitial = computeTailActivitySignature({
    run: "run-1",
    blocks: [b1, b2],
    segments: [turnSeg],
    poolLatestSeq: 2,
    thinking: true,
  });

  // Prepending an older block at index 0 must NOT change the tail signature
  const b0 = makeBlock("b0", "2026-11-13T03:59:00.000Z", { text: "older history" });
  const olderSeg: StreamSegment = {
    kind: "turn",
    id: "turn:0",
    steps: [],
    responseBlock: b0,
    responseText: "older history",
  };
  const sigAfterPrepend = computeTailActivitySignature({
    run: "run-1",
    blocks: [b0, b1, b2],
    segments: [olderSeg, turnSeg],
    poolLatestSeq: 2,
    thinking: true,
  });
  assert.equal(sigAfterPrepend, sigInitial);

  // Streaming extra prose characters inside the SAME last segment MUST change the tail signature
  const b2Grown = { ...b2, text: "Streaming answer with more tokens..." };
  const turnSegGrown: StreamSegment = {
    ...turnSeg,
    responseBlock: b2Grown,
    responseText: b2Grown.text,
  };
  const sigAfterStream = computeTailActivitySignature({
    run: "run-1",
    blocks: [b0, b1, b2Grown],
    segments: [olderSeg, turnSegGrown],
    poolLatestSeq: 2,
    thinking: true,
  });
  assert.notEqual(sigAfterStream, sigInitial);
});

test("countNewTailBlocks counts genuinely new tail blocks and ignores prepended upward history", () => {
  const b10 = makeBlock("b10", "2026-11-13T04:10:00.000Z");
  const b11 = makeBlock("b11", "2026-11-13T04:11:00.000Z");
  const baseline = createTailPauseBaseline("run-1", [b10, b11]);

  // Upward pagination prepends b08, b09 before b10 -> 0 unread tail updates
  const b08 = makeBlock("b08", "2026-11-13T04:08:00.000Z");
  const b09 = makeBlock("b09", "2026-11-13T04:09:00.000Z");
  assert.equal(countNewTailBlocks(baseline, "run-1", [b08, b09, b10, b11]), 0);

  // New live dialogue & tool blocks arrive after b11 -> 2 unread tail updates
  const b12 = makeBlock("b12", "2026-11-13T04:12:00.000Z");
  const b13 = makeBlock("b13", "2026-11-13T04:12:05.000Z");
  assert.equal(
    countNewTailBlocks(baseline, "run-1", [b08, b09, b10, b11, b12, b13]),
    2,
  );
});
