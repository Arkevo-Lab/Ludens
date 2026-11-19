import test from "node:test";
import assert from "node:assert/strict";
import { readArchiveJson, type ArchiveProgress } from "../lib/archive-client";

test("archive preparation is retried rather than consumed as an empty history response", async () => {
  let calls = 0;
  const progressEvents: ArchiveProgress[] = [];
  const result = await readArchiveJson(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Archive preparing"), {
          data: {
            code: "ARCHIVE_PREPARING",
            progress: { bytes: 10, totalBytes: 100 },
          },
        });
      }
      return { blocks: [{ id: "historical" }] };
    },
    undefined,
    progress => {
      progressEvents.push(progress);
    },
  );
  assert.deepEqual(result, { blocks: [{ id: "historical" }] });
  assert.equal(calls, 2);
  assert.deepEqual(progressEvents, [{ bytes: 10, totalBytes: 100 }]);
});

test("leaving the view cancels preparation retries without another RPC request", async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(
    readArchiveJson(
      async () => {
        calls += 1;
        setTimeout(() => controller.abort(), 5);
        throw Object.assign(new Error("Archive preparing"), {
          code: "ARCHIVE_PREPARING",
        });
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("cancelled and failed builds leave polling with an explicit error until the user retries", async () => {
  for (const code of ["ARCHIVE_BUILD_CANCELLED", "ARCHIVE_BUILD_FAILED"]) {
    let calls = 0;
    await assert.rejects(
      readArchiveJson(async () => {
        calls += 1;
        throw Object.assign(new Error("构建已停止"), { code });
      }),
      { message: "构建已停止", code },
    );
    assert.equal(calls, 1);
  }
});
