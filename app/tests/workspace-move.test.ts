import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFixture } from "./fixtures/registry";
import { registerWorkspace, renewWorkspaceIdentity } from "@ludens/protocol/ludens";
import { catalog, clearCatalogCache, controlState, openRun } from "../lib/data";
import { eventFiles } from "../lib/event-files";
import { LogIndex, closeLogIndexes } from "../lib/log-index";
import { petState, setPetTarget } from "../lib/pet-state";

test("moved workspaces keep registered history and follow targets while cached absolute pointers rebuild", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-move-")));
  const home = join(root, "home"), before = join(root, "before"), after = join(root, "after");
  try {
    await registerFixture(home, "fixture", before);
    const run = join(before, "logs/run"), device = join(before, "logs/baseware/device");
    await mkdir(run, { recursive: true }); await mkdir(join(device, "events"), { recursive: true });
    const manifest = { runId: "run", workspace: before, workspaceId: "fixture", drivers: [],
      eventSources: [{ sourceId: "device", root: device, format: "baseware-events-v1", recordingId: "run", windows: [{ afterSeq: 0, throughSeq: 1 }] }] };
    await writeFile(join(run, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(run, "events.jsonl"), "");
    await writeFile(join(device, "source.json"), JSON.stringify({ sourceId: "device", format: "baseware-events-v1" }));
    await writeFile(join(device, "events/one.jsonl"), "");
    await setPetTarget("fixture", false, home);
    const indexPath = join(run, ".fixture-index"), index = new LogIndex(run, indexPath);
    index.setMeta("cold:ready", "1"); index.close();
    await rename(before, after);
    await registerWorkspace(after, home); clearCatalogCache();
    assert.deepEqual((await catalog(home))[0].runs.map(run => run.id), ["run"]);
    const opened = await openRun("fixture", "run", home);
    assert.equal(opened.archiveWorkspace, after); opened.release();
    assert.equal((await petState(home)).target?.workspace, after);
    const files = await eventFiles(join(after, "logs/run"));
    assert.equal(files[1].path, join(after, "logs/baseware/device/events/one.jsonl"));
    const movedIndex = new LogIndex(join(after, "logs/run"), join(after, "logs/run/.fixture-index"));
    assert.equal(movedIndex.meta("cold:ready"), undefined); movedIndex.close();
    assert.equal(JSON.parse(await readFile(join(after, "logs/run/manifest.json"), "utf8")).workspace, before);
  } finally { await closeLogIndexes(); clearCatalogCache(); await rm(root, { recursive: true, force: true }); }
});

test("an explicitly renewed copy reads inherited archives but cannot control the original host", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-copy-")));
  const home = join(root, "home"), original = join(root, "original"), copied = join(root, "copied");
  try {
    await registerFixture(home, "original", original);
    const run = join(original, "logs/run"); await mkdir(run, { recursive: true });
    await writeFile(join(run, "manifest.json"), JSON.stringify({ runId: "run", workspace: original,
      workspaceId: "original", socket: "/unused/original.sock", drivers: [] }));
    await cp(original, copied, { recursive: true });
    const identity = await renewWorkspaceIdentity(copied, home);
    await registerWorkspace(copied, home); clearCatalogCache();
    assert.ok(identity.historyIds?.includes("original"));
    const opened = await openRun(identity.id, "run", home);
    assert.equal(opened.archiveWorkspace, copied); opened.release();
    const control = await controlState(identity.id, "run", "old-epoch", home);
    assert.equal(control.live, null); assert.equal(control.controlAllowed, false);
    assert.equal(JSON.parse(await readFile(join(copied, "logs/run/manifest.json"), "utf8")).workspaceId, "original");
    await writeFile(join(copied, "logs/run/manifest.json"), JSON.stringify({ runId: "run", workspace: original,
      workspaceId: "foreign", drivers: [] }));
    await assert.rejects(openRun(identity.id, "run", home), /身份/);
  } finally { await closeLogIndexes(); clearCatalogCache(); await rm(root, { recursive: true, force: true }); }
});
