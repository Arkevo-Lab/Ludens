import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryActivity, refreshActivity } from "../lib/activity";
import { closeLogIndexes, getLogIndex } from "../lib/log-index";
import type { Event } from "../lib/types";

const scope = { project: "fixture", runId: "run", epoch: "cycle" };

function makeEvent(seq: number, type: string, modelCallId = "model", data: Record<string, unknown> = {}): Event {
  return {
    seq,
    type,
    at: new Date(Date.UTC(2026, 10, 12, 0, 0, seq)).toISOString(),
    atMs: seq * 1000,
    data,
    trace: { epoch: "cycle", ...(type === "control" ? {} : { modelCallId }) },
  };
}

function makeFrame(type: string, itemId: string, text: string, sequence: number): string {
  return (
    JSON.stringify({
      atMs: sequence * 1000,
      event: {
        data: JSON.stringify({
          type,
          item_id: itemId,
          ...(type.endsWith("delta") ? { delta: text } : { text }),
          sequence_number: sequence,
        }),
      },
    }) + "\n"
  );
}

async function withFixture(work: (path: string) => Promise<void>): Promise<void> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ludens-live-activity-cache-")));
  try {
    await mkdir(join(path, "streams"));
    await writeFile(
      join(path, "events.jsonl"),
      [makeEvent(1, "control", "model", { mode: "auto" }), makeEvent(2, "model_start", "model")]
        .map(ev => JSON.stringify(ev))
        .join("\n") + "\n",
    );
    await writeFile(join(path, "streams/model.jsonl"), "");
    await work(path);
  } finally {
    await closeLogIndexes();
    await rm(path, { recursive: true, force: true });
  }
}

test("batch model hydration caches sibling blocks in WeakMap<LogIndex> across upward pagination", async () =>
  withFixture(async path => {
    const streamPath = join(path, "streams/model.jsonl");
    const frames: string[] = [];
    for (let i = 1; i <= 12; i++) {
      frames.push(makeFrame("response.output_text.done", `msg_${i}`, `Message body ${i}`, i));
    }
    await writeFile(streamPath, frames.join(""));

    const index = getLogIndex(path);
    await refreshActivity(index);

    // Page 1 (latest 5 text blocks) hydrates model.jsonl once and caches sibling blocks
    const page1 = await queryActivity(index, scope, { mode: "history", kind: "text", limit: 5 });
    assert.deepEqual(
      page1.blocks.map(b => b.text),
      ["Message body 8", "Message body 9", "Message body 10", "Message body 11", "Message body 12"],
    );
    assert.equal(page1.hasMore, true);
    assert.ok(page1.before);

    // Page 2 and Page 3 hit cached blocks cleanly in exact chronological order
    const page2 = await queryActivity(index, scope, {
      mode: "history",
      kind: "text",
      limit: 5,
      before: page1.before,
    });
    assert.deepEqual(
      page2.blocks.map(b => b.text),
      ["Message body 3", "Message body 4", "Message body 5", "Message body 6", "Message body 7"],
    );
    assert.equal(page2.hasMore, true);
    assert.ok(page2.before);

    const page3 = await queryActivity(index, scope, {
      mode: "history",
      kind: "text",
      limit: 5,
      before: page2.before,
    });
    assert.deepEqual(
      page3.blocks.map(b => b.text),
      ["Message body 1", "Message body 2"],
    );
    assert.equal(page3.hasMore, false);

    // Warm repeat read returns identical blocks
    const page1Warm = await queryActivity(index, scope, { mode: "history", kind: "text", limit: 5 });
    assert.deepEqual(page1Warm.blocks, page1.blocks);
  }));

test("historical revisions in delta pagination never leak later streamOffset/eventCutoff from latest pointer coalescing", async () =>
  withFixture(async path => {
    const index = getLogIndex(path);
    await refreshActivity(index);
    const initial = await queryActivity(index, scope);
    if (!("cursor" in initial)) throw new Error("Expected snapshot cursor");

    // Revision A: item_1 has partial text "Draft v1", item_2 has "Sibling v1"
    await appendFile(
      join(path, "streams/model.jsonl"),
      makeFrame("response.output_text.delta", "item_1", "Draft v1", 1) +
        makeFrame("response.output_text.done", "item_2", "Sibling v1", 2),
    );
    await refreshActivity(index);

    // Revision B: item_1 finishes as "Final v2" AND item_3 is added later in the SAME model.jsonl!
    await appendFile(
      join(path, "streams/model.jsonl"),
      makeFrame("response.output_text.done", "item_1", "Final v2", 3) +
        makeFrame("response.output_text.done", "item_3", "Latest item v2", 4),
    );
    await refreshActivity(index);

    // Fetch ALL delta versions in a SINGLE batch call (limit: 50) so historical pointer (item_1 @ Rev A)
    // and latest pointers (item_1 @ Rev B, item_3 @ Rev B) enter `hydrate.batch(items)` together!
    const delta = await queryActivity(index, scope, { cursor: initial.cursor, limit: 50 });
    assert.equal(delta.mode, "delta");

    const item1Versions = delta.blocks.filter(b => b.id === "model:text:item_1:0");
    assert.equal(item1Versions.length, 2, "delta feed must include both creation revision and late update revision");

    // Guardrail #1 (in-memory index): Earlier revision MUST read "Draft v1" (running), NOT "Final v2"
    assert.equal(item1Versions[0]!.text, "Draft v1");
    assert.equal(item1Versions[0]!.status, "running");
    assert.equal(item1Versions[1]!.text, "Final v2");
    assert.equal(item1Versions[1]!.status, "complete");
    assert.ok((item1Versions[1]!.revision ?? 0) > (item1Versions[0]!.revision ?? 0));

    // Guardrail #1 (cold reopened SQLite index -> exercises hydrate.batch disk path directly!):
    await closeLogIndexes();
    const reopened = getLogIndex(path);
    const coldDelta = await queryActivity(reopened, scope, { cursor: initial.cursor, limit: 50 });
    const coldVersions = coldDelta.blocks.filter(b => b.id === "model:text:item_1:0");
    assert.equal(coldVersions.length, 2);
    assert.equal(coldVersions[0]!.text, "Draft v1");
    assert.equal(coldVersions[0]!.status, "running");
    assert.equal(coldVersions[1]!.text, "Final v2");
    assert.equal(coldVersions[1]!.status, "complete");
  }));

test("stream truncation rotates activityGeneration and invalidates WeakMap block cache cleanly", async () =>
  withFixture(async path => {
    const streamPath = join(path, "streams/model.jsonl");
    await writeFile(
      streamPath,
      makeFrame("response.output_text.done", "msg_1", "Original long stream content before truncation", 1),
    );

    const index = getLogIndex(path);
    await refreshActivity(index);
    const beforeTruncate = await queryActivity(index, scope, { mode: "history", kind: "text" });
    assert.equal(beforeTruncate.blocks[0]?.text, "Original long stream content before truncation");

    // Rewrite stream file with shorter content -> LogIndex / refreshActivity rotates generation
    await writeFile(streamPath, makeFrame("response.output_text.done", "msg_1", "Short", 1));
    await refreshActivity(index);

    const afterTruncate = await queryActivity(index, scope, { mode: "history", kind: "text" });
    assert.notEqual(afterTruncate.projection.generation, beforeTruncate.projection.generation);
    assert.equal(afterTruncate.blocks[0]?.text, "Short");
  }));
