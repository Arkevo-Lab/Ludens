import { describe, expect, test } from "bun:test";
import {
  ActivityChangesClient,
  type ActivityChangesRequest,
  type ActivityResponse,
  acceptsScope,
  retryArchivePreparing,
} from "../src/activity.ts";

function makeResponse(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    scope: { project: "proj-1", runId: "run-1", epoch: "1" },
    mode: "snapshot",
    blocks: [],
    cursor: "cur-1",
    hasMore: false,
    projection: {
      source: { component: "test" },
      throughSeq: 1,
      latestEventAt: "2026-11-14T00:00:00.000Z",
      latestSourceAt: "2026-11-14T00:00:00.000Z",
      generatedAt: "2026-11-14T00:00:00.000Z",
      durationMs: 1,
      blockCount: 0,
      revision: 1,
      generation: "gen-1",
    },
    current: {
      workspace: "proj-1",
      runId: "run-1",
      epoch: "1",
      activity: "running",
      phase: "playing",
      intent: null,
      observationId: null,
      updatedAt: "2026-11-14T00:00:00.000Z",
      error: null,
    },
    ...overrides,
  };
}

describe("ActivityChangesClient", () => {
  test("requires an injected reader or fetcher function", () => {
    expect(() => new ActivityChangesClient({ project: "proj-1" })).toThrow(
      "ActivityChangesClient requires an injected reader function",
    );
  });

  test("acknowledges cursors only when acknowledge() is called and works with reader/fetcher", async () => {
    const requests: ActivityChangesRequest[] = [];
    const responses: ActivityResponse[] = [
      makeResponse({ mode: "snapshot", cursor: "c1" }),
      makeResponse({ mode: "delta", cursor: "c2" }),
      makeResponse({ mode: "delta", cursor: "c3" }),
    ];

    const client = new ActivityChangesClient({
      project: "proj-1",
      run: "run-1",
      epoch: "1",
      limit: 50,
      reader: async (req) => {
        requests.push(req);
        const next = responses.shift();
        if (!next) throw new Error("unexpected call");
        return next;
      },
    });

    const controller = new AbortController();
    const first = await client.read(controller.signal);
    expect(requests[0]).toEqual({
      project: "proj-1",
      run: "run-1",
      epoch: "1",
      limit: 50,
      mode: "changes",
    });

    // Without acknowledge(), cursor stays unset.
    const secondUnacked = await client.read(controller.signal);
    expect(requests[1]?.cursor).toBeUndefined();

    secondUnacked.acknowledge();
    const thirdAcked = await client.read(controller.signal);
    expect(requests[2]?.cursor).toBe("c2");
    expect(thirdAcked.cursor).toBe("c3");
    first.acknowledge(); // stale page acknowledgement must not overwrite newer cursor
  });

  test("supports fetcher alias and validates scope and page mode", async () => {
    const wrongScopeClient = new ActivityChangesClient({
      project: "proj-1",
      run: "run-1",
      fetcher: async () => makeResponse({ scope: { project: "proj-other", runId: "run-1", epoch: "1" } }),
    });
    await expect(wrongScopeClient.read(new AbortController().signal)).rejects.toThrow("日志返回了其他运行范围");

    const wrongModeClient = new ActivityChangesClient({
      project: "proj-1",
      run: "run-1",
      fetcher: async () => makeResponse({ mode: "history" }),
    });
    await expect(wrongModeClient.read(new AbortController().signal)).rejects.toThrow("日志返回了非增量页面");

    expect(acceptsScope({ project: "p", runId: "r", epoch: null }, "p", "r", "all")).toBe(true);
    expect(acceptsScope({ project: "p", runId: "r", epoch: "2" }, "p", "r", "all")).toBe(false);
  });

  test("retryArchivePreparing retries on ARCHIVE_PREPARING errors and stops on abort", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const value = await retryArchivePreparing(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("preparing"), { code: "ARCHIVE_PREPARING" });
      }
      if (attempts === 2) {
        throw Object.assign(new Error("preparing via rpc"), { data: { code: "ARCHIVE_PREPARING" } });
      }
      return "ready";
    }, controller.signal);

    expect(value).toBe("ready");
    expect(attempts).toBe(3);

    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(retryArchivePreparing(async () => "never", aborted.signal)).rejects.toThrow("cancelled");
  });
});
