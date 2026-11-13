import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardWorker } from "@ludens/core/core/query/dashboard-worker";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("discoverDriver accepts a valid file package and rejects invalid specs through the real worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-discover-"));
  const driver = join(root, "driver.ts");
  await writeFile(driver, `export default { id: "fixture", transport: "bridge", defaultPort: 47111,
    version: "1.0", launchHint: "hint", async load() { throw new Error("discover must not call load()"); } };`);
  const worker = new DashboardWorker();
  try {
    const value = await worker.call("discoverDriver", [`  file:${driver}  `]);
    assert.deepEqual(value, { spec: `file:${driver}`, id: "fixture", version: "1.0", transport: "bridge", defaultPort: 47111, launchHint: "hint" });
    await assert.rejects(worker.call("discoverDriver", [""]), /包地址/);
    await assert.rejects(worker.call("discoverDriver", [`file:${join(root, "missing.ts")}`]), /Driver path not found/);
    await assert.rejects(worker.call("discoverDriver", ["bogus!!!"]), /spec/);
    await assert.rejects(worker.call("discoverDriver", ["file:relative/driver.ts"]), /绝对路径/);
    await assert.rejects(worker.call("discoverDriver", [null as unknown as string]), /字符串/);
    assert.equal(worker.pendingCount, 0);
  } finally {
    await worker.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["request cancellation", "worker shutdown", "successful import"] as const) {
  test(`discovery cleans its process group after ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-discover-process-"));
    const driver = join(root, "driver.ts"), marker = join(root, "pids.json");
    await writeFile(driver, `
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
child.unref();
${mode === "successful import" ? "" : "process.on('SIGTERM', () => {});"}
await Bun.write(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
${mode === "successful import" ? "" : "await new Promise(() => { setInterval(() => {}, 1000); });"}
export default { id: "process-fixture", version: "1", load() { throw new Error("must not call load"); } };
`);
    const worker = new DashboardWorker(), abort = new AbortController();
    let pids: number[] = [];
    try {
      const pending = worker.call("discoverDriver", [`file:${driver}`], abort.signal);
      const rejected = mode === "successful import" ? undefined : assert.rejects(pending, mode === "request cancellation" ? { name: "AbortError" } : /closing/);
      await waitFor(() => access(marker).then(() => true, () => false));
      pids = JSON.parse(await readFile(marker, "utf8"));
      if (mode === "request cancellation") {
        assert.equal((await worker.call("diagnostics", [])).activeRequests, 1);
        abort.abort(); await rejected;
      } else if (mode === "worker shutdown") {
        await worker.close(); await rejected;
      } else {
        assert.equal((await pending).id, "process-fixture");
      }
      await waitFor(async () => pids.every(pid => !alive(pid)));
      assert.equal(worker.pendingCount, 0);
    } finally {
      abort.abort(); await worker.close();
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
}
