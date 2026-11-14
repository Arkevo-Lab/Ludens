import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuild, stampBuild } from "../scripts/production.mjs";

test("static export stamp refuses missing, stale, and replaced production builds", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-build-")), root = join(parent, "dashboard");
  try {
    await mkdir(join(root, "out"), { recursive: true });
    await mkdir(join(root, "messages"));
    await writeFile(join(root, "messages/en.json"), JSON.stringify({ title: "Console" }));
    await writeFile(join(parent, "bun.lock"), "initial dependency resolution");

    // Missing out/index.html is rejected before stamping or checking.
    await assert.rejects(stampBuild(root), /ENOENT/);
    await assert.rejects(checkBuild(root), /missing or stale/);

    await writeFile(join(root, "out/index.html"), "<!doctype html><html><body>Ludens</body></html>");
    await assert.rejects(checkBuild(root), /missing or stale/);

    await stampBuild(root);
    await checkBuild(root);

    await writeFile(join(root, "messages/en.json"), JSON.stringify({ title: "Ludens Console" }));
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root);
    await checkBuild(root);

    await writeFile(join(parent, "bun.lock"), "updated dependency resolution");
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root);
    await checkBuild(root);

    await writeFile(join(root, "index.html"), "<!doctype html><html><body>Updated</body></html>");
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root);
    await checkBuild(root);

    await writeFile(join(root, "vite.config.ts"), "export default {};\n");
    await assert.rejects(checkBuild(root), /missing or stale/);
    await stampBuild(root);
    await checkBuild(root);

    await rm(join(root, "out/index.html"));
    await assert.rejects(checkBuild(root), /missing or stale/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
