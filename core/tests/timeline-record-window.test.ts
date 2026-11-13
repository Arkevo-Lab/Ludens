import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineWindow } from "../src/core/query/timeline-record.ts";

interface Entry { id: string; capability: string; at: number; runId: string; }

/** Write one segment in the exact on-disk format: .meta.json, 64-byte-entry .idx, JSONL payloads. */
async function writeSegment(root: string, stem: string, firstSequence: number, entries: Entry[], mtimeSeconds: number) {
  const dir = join(root, "segments");
  const idx = Buffer.alloc(64 * entries.length);
  const lines: string[] = [];
  let offset = 0;
  entries.forEach((entry, i) => {
    const sequence = firstSequence + i;
    const line = JSON.stringify({ id: entry.id, sequence, capability: entry.capability,
      recordedAt: new Date(entry.at).toISOString(), runId: entry.runId });
    idx.writeDoubleBE(entry.at / 1000, i * 64);
    idx.writeBigUInt64BE(BigInt(sequence), i * 64 + 8);
    idx.writeBigUInt64BE(BigInt(offset), i * 64 + 16);
    idx.writeBigUInt64BE(BigInt(line.length), i * 64 + 24);
    createHash("sha256").update(entry.capability).digest().subarray(0, 16).copy(idx, i * 64 + 32);
    createHash("sha256").update(entry.id).digest().subarray(0, 16).copy(idx, i * 64 + 48);
    lines.push(line);
    offset += line.length + 1;
  });
  await writeFile(join(dir, `${stem}.idx`), idx);
  await writeFile(join(dir, `${stem}.jsonl`), `${lines.join("\n")}\n`);
  const last = firstSequence + entries.length - 1;
  const meta = { firstSequence, lastSequence: last, count: entries.length,
    minimum: { recordedAt: new Date(entries[0].at).toISOString(), sequence: firstSequence },
    maximum: { recordedAt: new Date(entries.at(-1)!.at).toISOString(), sequence: last } };
  const metaPath = join(dir, `${stem}.meta.json`);
  await writeFile(metaPath, JSON.stringify(meta));
  // Distinct mtimes so the meta cache cannot confuse rewrites of identical size.
  await utimes(metaPath, mtimeSeconds, mtimeSeconds);
  await utimes(join(dir, `${stem}.idx`), mtimeSeconds, mtimeSeconds);
  await utimes(join(dir, `${stem}.jsonl`), mtimeSeconds, mtimeSeconds);
}

const t0 = 1_700_000_000_000;
const seg1: Entry[] = [
  { id: "a1", capability: "capA", at: t0, runId: "run1" },
  { id: "b1", capability: "capB", at: t0 + 10, runId: "run1" },
];
const seg2: Entry[] = [
  { id: "a2", capability: "capA", at: t0 + 20, runId: "run1" },
  { id: "b2", capability: "capB", at: t0 + 30, runId: "run2" }, // latest capB before the window, wrong run
];
const seg3: Entry[] = [
  { id: "c1", capability: "capC", at: t0 + 100, runId: "run1" },
  { id: "a3", capability: "capA", at: t0 + 110, runId: "run1" },
];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "timeline-window-")));
  await mkdir(join(root, "segments"));
  await writeSegment(root, "seg-0001", 1, seg1, 1000);
  await writeSegment(root, "seg-0002", 3, seg2, 1001);
  await writeSegment(root, "seg-0003", 5, seg3, 1002);
  return root;
}

const windowOptions = { run: "run1", start: t0 + 50, end: t0 + 200, scopeStart: t0, scopeEnd: t0 + 300, limit: 10 };

test("timelineWindow back-scan returns the latest previous record per capability", async () => {
  const root = await fixture();
  try {
    const { records, maxSequence } = await timelineWindow(root, windowOptions);
    // Brute force: latest capA/capB with at <= t0+49 is a2 (seq 3) and b2 (seq 4, run2 →
    // excluded → next capB is b1 seq 2); plus the two in-window run1 records, sorted by time.
    expect(maxSequence).toBe(6);
    expect(records.map(record => record.id)).toEqual(["b1", "a2", "c1", "a3"]);
    expect(records.map(record => record.sequence)).toEqual([2, 3, 5, 6]);
    expect(records.every(record => record.runId === "run1")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timelineWindow returns identical results on a cached second call", async () => {
  const root = await fixture();
  try {
    const first = await timelineWindow(root, windowOptions);
    const second = await timelineWindow(root, windowOptions);
    expect(second).toEqual(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timelineWindow excludes the wrong-run latest pointer and retries with the earlier same-run record", async () => {
  const root = await fixture();
  try {
    const { records } = await timelineWindow(root, windowOptions);
    const capB = records.filter(record => record.capability === "capB");
    // b2 (run2, seq 4) must never surface; the retry picks b1 (run1, seq 2).
    expect(capB.map(record => record.id)).toEqual(["b1"]);
    expect(records.some(record => record.id === "b2")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timelineWindow reflects appended tail-segment entries (no stale summary or meta cache)", async () => {
  const root = await fixture();
  try {
    expect((await timelineWindow(root, windowOptions)).records.map(record => record.id))
      .toEqual(["b1", "a2", "c1", "a3"]);
    const grown = [...seg3, { id: "b3", capability: "capB", at: t0 + 120, runId: "run1" }];
    await writeSegment(root, "seg-0003", 5, grown, 1003);
    const page = await timelineWindow(root, windowOptions);
    expect(page.maxSequence).toBe(7);
    expect(page.records.map(record => record.id)).toEqual(["b1", "a2", "c1", "a3", "b3"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timelineWindow bounds open payload handles across >8 segments and invalidates summary if .idx is removed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "timeline-many-")));
  try {
    await mkdir(join(root, "segments"));
    for (let i = 0; i < 12; i++) {
      await writeSegment(root, `seg-${String(i + 1).padStart(4, "0")}`, i + 1, [
        { id: `id-${i}`, capability: `cap-${i}`, at: t0 + i * 10, runId: "run1" },
      ], 2000 + i);
    }
    const first = await timelineWindow(root, {
      run: "run1",
      start: t0 + 500,
      end: t0 + 600,
      scopeStart: t0,
      scopeEnd: t0 + 700,
      limit: 20,
    });
    expect(first.records).toHaveLength(12);
    await rm(join(root, "segments/seg-0001.idx"));
    await expect(
      timelineWindow(root, {
        run: "run1",
        start: t0 + 500,
        end: t0 + 600,
        scopeStart: t0,
        scopeEnd: t0 + 700,
        limit: 20,
      }),
    ).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
