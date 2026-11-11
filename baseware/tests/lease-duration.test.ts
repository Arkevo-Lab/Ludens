import { expect, test } from "bun:test";
import { BasewareCore } from "../src/core.ts";
import type { Capabilities } from "../src/contracts.ts";

const capabilities: Capabilities = { controllers: [{ tool: { name: "motor", inputSchema: { type: "object" } }, requiresControl: true,
  async acquire() {}, async release() {}, async execute() { return { result: { content: [] }, id: crypto.randomUUID(), status: "completed", exitCode: 0, stdout: "", stderr: "", timing: { clock: "device", requestedAtMs: 0, receivedAtMs: 1 } }; } }] };

test("lease_duration retimes a live lease without releasing controllers and rejects stale epochs", async () => {
  const events: string[] = [];
  const core = new BasewareCore({ capabilities, drivers: [{ id: "fake", version: "1" }], record: type => events.push(type) });
  const epoch = crypto.randomUUID();
  try {
    await core.acquire(epoch, null, { id: "owner" });
    expect(core.status()).toMatchObject({ mode: "auto", epoch, remainingSeconds: null });

    // Unbounded -> bounded: a finite countdown appears without any controller churn.
    await core.execute("motor", {}, epoch, new AbortController().signal);
    const timed = core.setLeaseDuration(epoch, 60);
    expect(timed).toMatchObject({ mode: "auto", epoch, remainingSeconds: 60 });
    expect(core.status().mode).toBe("auto");

    // Integration exception: only a real platform-clock wait can prove the cleared timer never fires.
    const cleared = core.setLeaseDuration(epoch, null);
    expect(cleared).toMatchObject({ mode: "auto", epoch, remainingSeconds: null });
    await Bun.sleep(20);
    expect(core.status()).toMatchObject({ mode: "auto", epoch, remainingSeconds: null });

    // The update never releases controllers; only a wrong epoch is rejected.
    expect(() => core.setLeaseDuration("wrong-epoch", 10)).toThrow("STALE_EPOCH");
    expect(core.status().mode).toBe("auto");
    expect(events.filter(type => type === "baseware_control").length).toBeGreaterThanOrEqual(3);
  } finally { await core.close(); }
});
