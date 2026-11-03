import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareCore } from "../src/core.ts";
import type { ToolExecutionResult } from "../src/contracts.ts";
import { ObservationStreamSpool } from "../src/stream.ts";

function nativeResult(data = Buffer.from("streamed image").toString("base64")): ToolExecutionResult {
  const timing = { clock: "device", requestedAtMs: 1, receivedAtMs: 2 };
  return {
    id: "capture-1", status: "completed", exitCode: 0, stdout: "", stderr: "", timing,
    observations: [{ id: "observation-1", controllerId: "screen.capture", mediaType: "image/png",
      contentIndex: 0, data, timing }],
    result: { content: [{ type: "image", data, mimeType: "image/png" }] },
  };
}

test("omitInlineMedia spools image bytes and replaces inline base64 with a reference", async () => {
  const streamDir = await mkdtemp(join(tmpdir(), "baseware-stream-test-"));
  const spool = new ObservationStreamSpool({ streamDir });
  try {
    const native = nativeResult();
    const result = await spool.spool(native, { omitInlineMedia: true });
    const observation = result.observations![0]!;
    expect(observation.path).toStartWith(streamDir);
    expect(observation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.bytes).toBe(Buffer.byteLength("streamed image"));
    expect(observation.data).toBeUndefined();
    expect(result.result.content[0]).toMatchObject({ type: "image", data: "", path: observation.path,
      sha256: observation.sha256, bytes: observation.bytes });
    expect(await readFile(observation.path!)).toEqual(Buffer.from("streamed image"));
    expect(native.observations![0]!.path).toBeUndefined();
    expect(native.result.content[0]).toMatchObject({ data: Buffer.from("streamed image").toString("base64") });
  } finally {
    await spool.close();
  }
  const second = new ObservationStreamSpool({ streamDir, maxFiles: 2 });
  try {
    for (let i = 0; i < 4; i++) await second.spool(nativeResult(Buffer.from(`img-${i}`).toString("base64")), { omitInlineMedia: true });
    expect(await readdir(streamDir)).toHaveLength(2);
  } finally {
    await second.close();
    expect(await readdir(streamDir)).toHaveLength(0);
    await rm(streamDir, { recursive: true, force: true });
  }
});

test("default spooling returns the native result by identity", async () => {
  const spool = new ObservationStreamSpool();
  try {
    const native = nativeResult();
    expect(await spool.spool(native)).toBe(native);
    expect(await spool.spool(native, { omitInlineMedia: false })).toBe(native);
  } finally { await spool.close(); }
});

test("continuous perception pre-fetches frames and close stops the producer", async () => {
  const streamDir = await mkdtemp(join(tmpdir(), "baseware-stream-core-test-"));
  let captures = 0;
  const core = new BasewareCore({
    drivers: [],
    streamPrefetch: true,
    capabilities: { controllers: [{
      tool: { name: "screen.capture", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      requiresControl: false,
      async execute(): Promise<ToolExecutionResult> {
        const capture = ++captures;
        const result = nativeResult(Buffer.from(`frame-${capture}`).toString("base64"));
        result.id = `capture-${capture}`;
        result.observations![0]!.id = `observation-${capture}`;
        result.observations![0]!.sourceSequence = capture;
        return result;
      },
    }] },
  });
  const execute = () => core.execute("screen.capture", {}, undefined, new AbortController().signal,
    { recordingPurpose: "continuous-perception" }, undefined, "test", { omitInlineMedia: true });
  try {
    // Integration coverage: exercise actual producer intervals and performance.now freshness.
    expect((await execute()).id).toBe("capture-1");
    const deadline = performance.now() + 1000;
    while (captures < 3 && performance.now() < deadline) await Bun.sleep(5);
    expect(captures).toBeGreaterThanOrEqual(3);
    const beforeRead = captures;
    const prefetched = await execute();
    expect(prefetched.observations![0]!.sourceSequence).toBeGreaterThan(1);
    expect(captures).toBe(beforeRead);
  } finally { await core.close(); }
  const stoppedAt = captures;
  await Bun.sleep(60);
  expect(captures).toBe(stoppedAt);
  await rm(streamDir, { recursive: true, force: true });
});
