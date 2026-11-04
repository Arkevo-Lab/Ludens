import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/core/shiori/runtime.ts";

test("a completed program cannot leave a background process holding output pipes and consuming the remaining budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-pipes-"));
  const runtime = new Runtime(undefined, () => {}, 3);
  try {
    const started = performance.now();
    await runtime.runProgram({ argv: ["/bin/sh", "-c", "sleep 60 & exit 0"], cwd: root, env: process.env,
      stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, agent: false });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("program budget cancellation drains a process that ignores TERM and leaves the Runtime reusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-timeout-"));
  const runtime = new Runtime(undefined, () => {}, 0.1);
  const output = { cwd: root, env: process.env, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") };
  try {
    await expect(runtime.runProgram({ ...output, argv: ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"] })).rejects.toThrow();
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, reason: "time budget" });
    await runtime.runProgram({ ...output, argv: ["/bin/sh", "-c", "exit 0"] });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);

test("an ordinary program that handles timeout with exit zero is still an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-zero-timeout-"));
  const runtime = new Runtime(undefined, () => {}, 0.1);
  try {
    await expect(runtime.runProgram({ argv: ["/bin/sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
      cwd: root, env: process.env, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") })).rejects.toBeDefined();
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);
