import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/core/shiori/runtime.ts";

const win32 = process.platform === "win32";
// POSIX uses /bin/sh; Windows runs the same three scenarios through the current Bun/Node executable.
const program = (sh: string, js: string): string[] => win32 ? [process.execPath, "-e", js] : ["/bin/sh", "-c", sh];
const BACKGROUND_HOLDING_PIPES = program("sleep 60 & exit 0", `
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit", windowsHide: true, cwd: require("node:os").tmpdir() }).unref();
  process.exit(0);
`);
const IGNORE_TERM = program("trap '' TERM; while :; do sleep 1; done", `
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`);
const EXIT_ZERO_ON_TERM = program("trap 'exit 0' TERM; while :; do sleep 1; done", `
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
`);
const EXIT_ZERO = program("exit 0", "process.exit(0)");

test("a completed program cannot leave a background process holding output pipes and consuming the remaining budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-pipes-"));
  const runtime = new Runtime(undefined, () => {}, 3);
  try {
    const started = performance.now();
    await runtime.runProgram({ argv: BACKGROUND_HOLDING_PIPES, cwd: root, env: process.env,
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
    await expect(runtime.runProgram({ ...output, argv: IGNORE_TERM })).rejects.toThrow();
    expect(runtime.status()).toMatchObject({ mode: "manual", thinking: false, reason: "time budget" });
    await runtime.runProgram({ ...output, argv: EXIT_ZERO });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);

test("an ordinary program that handles timeout with exit zero is still an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-zero-timeout-"));
  const runtime = new Runtime(undefined, () => {}, 0.1);
  try {
    await expect(runtime.runProgram({ argv: EXIT_ZERO_ON_TERM,
      cwd: root, env: process.env, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") })).rejects.toBeDefined();
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 5000);
