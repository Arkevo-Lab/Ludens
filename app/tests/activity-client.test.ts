import test from "node:test";
import assert from "node:assert/strict";
import {
  ActivityChangesClient,
  retryArchivePreparing,
  type ActivityChangesRequest,
  type ActivityResponse,
} from "@ludens/protocol/activity";

function page(revision: number, runId = "run-a", generation = "one"): ActivityResponse {
  return { scope: { project: "project", runId, epoch: "epoch" }, mode: "delta", blocks: [],
    cursor: `${generation}:${revision}`, hasMore: false,
    projection: { source: { component: "dashboard" }, throughSeq: revision, revision, generation,
      latestEventAt: null, latestSourceAt: null, generatedAt: "now", durationMs: 0, blockCount: 0 },
    current: { workspace: "/workspace", runId, epoch: "epoch", activity: "running", phase: "Ready",
      intent: null, observationId: null, updatedAt: null, error: null } };
}

test("activity cursor follows accepted pages, and a reset snapshot replaces the generation", async () => {
  const requests: ActivityChangesRequest[] = [];
  let response = { ...page(10), mode: "snapshot" as const };
  const client = new ActivityChangesClient({
    project: "project",
    reader: async request => {
      requests.push(request);
      return response;
    },
  });
  const abort = new AbortController();
  const first = await client.read(abort.signal);
  await client.read(abort.signal);
  assert.equal(requests[1].cursor, undefined);
  first.acknowledge();
  response = { ...page(1, "run-b", "two"), mode: "snapshot" };
  const reset = await client.read(abort.signal);
  assert.equal(requests[2].cursor, "one:10");
  assert.equal(reset.scope.runId, "run-b");
  reset.acknowledge();
  await client.read(abort.signal);
  assert.equal(requests[3].cursor, "two:1");
});

test("fixed selection rejects other scopes; aborting after read prevents cursor acceptance", async () => {
  const requests: ActivityChangesRequest[] = [];
  let response = page(10, "other");
  const client = new ActivityChangesClient({
    project: "project",
    run: "run-a",
    epoch: "epoch",
    reader: async request => {
      requests.push(request);
      return response;
    },
  });
  const first = new AbortController();
  await assert.rejects(client.read(first.signal), /其他运行范围/);
  response = page(10);
  const pending = await client.read(first.signal);
  first.abort(); pending.acknowledge();
  await client.read(new AbortController().signal);
  assert.equal(requests.at(-1)!.cursor, undefined);
  assert.equal(requests.at(-1)!.run, "run-a");
});

test("injected reader surfaces RPC errors and retries ARCHIVE_PREPARING cleanly", async () => {
  let attempts = 0;
  const result = await retryArchivePreparing(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Preparing archive"), { data: { code: "ARCHIVE_PREPARING" } });
      }
      return page(5);
    },
    new AbortController().signal,
  );
  assert.equal(attempts, 2);
  assert.equal(result.projection.revision, 5);

  await assert.rejects(
    retryArchivePreparing(async () => {
      throw new Error("Unknown run");
    }, new AbortController().signal),
    /Unknown run/,
  );
});
