import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSettings, updateWorkspaceRoot, openWorkspace, removeWorkspace, createWorkspace } from "../lib/workspaces";
import { readGlobalConfig, writeGlobalConfig, registeredWorkspace, registerWorkspace, forgetWorkspace,
  withPetTargetLock } from "@ludens/protocol/ludens";
import { setPetTarget, petState } from "../lib/pet-state";
import { registerFixture } from "./fixtures/registry";
import { DashboardWorker } from "@ludens/core/core/query/dashboard-worker";

test("workspace management preserves defaults, missing registrations, files, and the import boundary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-management-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), parent = join(root, "new-workspaces");
  try {
    await writeGlobalConfig({ version: 1, workspaceRoot: join(home, "workspaces"), defaults: { seconds: 77, pet: false } }, home);
    const registered = await registerFixture(home, "fixture", workspace);
    await writeFile(join(workspace, "keep.txt"), "retained");
    await setPetTarget(registered.id, false, home);
    const updated = await updateWorkspaceRoot(parent, home);
    assert.equal(updated.config.workspaceRoot, parent);
    assert.deepEqual(updated.config.defaults, { seconds: 77, pet: false });
    await assert.rejects(updateWorkspaceRoot("relative", home), /绝对路径/);
    const old = join(root, "old-directory"); await mkdir(old);
    await assert.rejects(openWorkspace(old, home), /import/);
    await assert.rejects(readFile(join(old, ".ludens/workspace.json")), { code: "ENOENT" });
    assert.deepEqual((await removeWorkspace(registered.id, home)).removed, registered);
    assert.deepEqual((await workspaceSettings(home)).workspaces, []);
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "retained");
    assert.equal((await petState(home)).target, null);
    assert.equal((await openWorkspace(workspace, home)).id, registered.id);
    assert.equal((await petState(home)).target, null);
    await rm(workspace, { recursive: true });
    assert.equal((await workspaceSettings(home)).workspaces[0].available, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("committed root/removal results do not depend on catalog or consumer reads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-committed-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), destination = join(root, "new-root");
  try {
    const registered = await registerFixture(home, "selected", workspace);
    await setPetTarget(registered.id, false, home);
    // These make the old post-commit workspaceSettings/petState reads fail.
    await writeFile(join(home, "registry/unrelated.json"), "{");
    await writeFile(join(home, "pet/consumer.json"), "{");
    const saved = await updateWorkspaceRoot(destination, home);
    assert.equal(saved.config.workspaceRoot, destination);
    assert.equal((await readGlobalConfig(home)).workspaceRoot, destination);
    const removed = await removeWorkspace(registered.id, home);
    assert.deepEqual(removed, { removed: registered });
    await assert.rejects(registeredWorkspace(registered.id, home), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    assert.deepEqual(await removeWorkspace(registered.id, home), { removed: null });
    await assert.rejects(workspaceSettings(home), SyntaxError, "the independent refresh still reports its genuine failure");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("removal returns the current registration for Undo and preserves an unrelated offline target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removed-entry-")));
  const home = join(root, "home"), original = join(root, "original"), moved = join(root, "moved"), other = join(root, "other");
  try {
    const stale = await registerFixture(home, "selected", original);
    const unrelated = await registerFixture(home, "other", other);
    await setPetTarget(unrelated.id, false, home);
    const rawTarget = await readFile(join(home, "pet/target.json"), "utf8");
    await rm(other, { recursive: true });
    await rename(original, moved);
    const current = await registerWorkspace(moved, home);
    assert.notEqual(current.workspace, stale.workspace);
    const result = await removeWorkspace(stale.id, home);
    assert.deepEqual(result.removed, current, "Undo gets the removed path, not a stale UI row");
    assert.equal(await readFile(join(home, "pet/target.json"), "utf8"), rawTarget);
    assert.deepEqual(await registeredWorkspace(unrelated.id, home), unrelated);
    await openWorkspace(result.removed!.workspace, home);
    assert.equal(await readFile(join(home, "pet/target.json"), "utf8"), rawTarget);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unreadable target blocks removal before unlink and permits explicit recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-blocked-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    const path = join(home, "pet/target.json"), original = await readFile(path, "utf8");
    await writeFile(path, "{");
    await assert.rejects(removeWorkspace(entry.id, home), error => {
      assert.equal((error as any).code, "WORKSPACE_REMOVAL_BLOCKED");
      assert.match((error as Error).message, /仍在列表中/); return true;
    });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    await rm(path); await mkdir(path);
    await assert.rejects(forgetWorkspace(entry.id, home), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    await rm(path, { recursive: true }); await writeFile(path, original);
    assert.deepEqual(await forgetWorkspace(entry.id, home), entry, "shared CLI primitive has the same safe order");
    assert.equal(JSON.parse(await readFile(path, "utf8")), null);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null, "shared re-registration does not revive follow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed target write leaves registration and the original target intact", { skip: process.getuid?.() === 0 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-write-failure-")));
  const home = join(root, "home"), workspace = join(root, "workspace"), pet = join(home, "pet");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    const target = await readFile(join(pet, "target.json"), "utf8");
    // The readable target remains in place; publishing its null replacement is
    // denied. The registry lives in a separate, still writable directory.
    await chmod(pet, 0o500);
    await assert.rejects(removeWorkspace(entry.id, home), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.deepEqual(await registeredWorkspace(entry.id, home), entry);
    assert.equal(await readFile(join(pet, "target.json"), "utf8"), target);
    await chmod(pet, 0o700);
    assert.deepEqual((await removeWorkspace(entry.id, home)).removed, entry);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null);
  } finally { await chmod(pet, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("a queued follow revalidates after removal and cannot revive its target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-removal-race-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  try {
    const entry = await registerFixture(home, "selected", workspace);
    await setPetTarget(entry.id, false, home);
    let releaseTarget!: () => void, targetLocked!: () => void;
    const targetReady = new Promise<void>(resolve => { targetLocked = resolve; });
    const targetHold = withPetTargetLock(home, async () => { targetLocked(); await new Promise<void>(resolve => { releaseTarget = resolve; }); });
    await targetReady;
    const removing = removeWorkspace(entry.id, home);
    // Wait until deletion owns its registry lock and is blocked on the target.
    let locked = false;
    for (let attempt = 0; attempt < 100 && !locked; attempt++) {
      locked = await readFile(join(home, `registry/${entry.id}.json.lock`)).then(() => false, error => error.code === "EISDIR");
      if (!locked) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(locked, "removal reached the ordered lock boundary");
    const following = setPetTarget(entry.id, false, home);
    const rejected = assert.rejects(following, /未找到已登记/);
    releaseTarget(); await targetHold;
    assert.deepEqual((await removing).removed, entry); await rejected;
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    await registerWorkspace(workspace, home);
    assert.equal((await petState(home)).target, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent follow of another workspace survives removal", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-other-follow-race-")));
  const home = join(root, "home");
  try {
    const removed = await registerFixture(home, "removed", join(root, "removed"));
    const other = await registerFixture(home, "other", join(root, "other"));
    await setPetTarget(removed.id, false, home);
    let releaseTarget!: () => void, targetLocked!: () => void;
    const ready = new Promise<void>(resolve => { targetLocked = resolve; });
    const held = withPetTargetLock(home, async () => { targetLocked(); await new Promise<void>(resolve => { releaseTarget = resolve; }); });
    await ready;
    const operations = Promise.all([removeWorkspace(removed.id, home), setPetTarget(other.id, false, home)]);
    releaseTarget(); await held; await operations;
    assert.equal((await petState(home)).target?.project, other.id);
    assert.deepEqual(await registeredWorkspace(other.id, home), other);
    await registerWorkspace(removed.workspace, home);
    assert.equal((await petState(home)).target?.project, other.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creating through the CLI uses the global default or explicit directory without starting services", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-create-"))), home = join(root, "home");
  const inherited = { LUDENS_WORKSPACE: process.env.LUDENS_WORKSPACE, LUDENS_SOCKET: process.env.LUDENS_SOCKET,
    BASEWARE_DRIVER_PACKAGES: process.env.BASEWARE_DRIVER_PACKAGES, BASEWARE_SOCKET: process.env.BASEWARE_SOCKET };
  try {
    Object.assign(process.env, { LUDENS_WORKSPACE: join(root, "unrelated-workspace"), LUDENS_SOCKET: join(root, "unrelated-ludens.sock"),
      BASEWARE_DRIVER_PACKAGES: "/nonexistent/inherited-driver", BASEWARE_SOCKET: join(root, "unrelated-baseware.sock") });
    const before = await readGlobalConfig(home);
    await writeGlobalConfig({ ...before, defaults: { seconds: 79, requests: 13, pet: false } }, home);
    const created = await createWorkspace({ name: "one", driver: "cua" }, undefined, home);
    assert.equal(created.workspace, join(home, "workspaces/one"));
    assert.deepEqual((await workspaceSettings(home)).workspaces.map(entry => entry.id), [created.id]);
    const config = JSON.parse(await readFile(join(created.workspace, "ludens.json"), "utf8"));
    assert.equal(config.seconds, 79); assert.equal(config.requests, 13); assert.equal(config.pet, false);
    await assert.rejects(readFile(join(created.workspace, "logs/background/host.plist")), { code: "ENOENT" });
    const explicit = join(root, "custom path");
    assert.equal((await createWorkspace({ name: "two", workspace: explicit, driver: "cua" }, undefined, home)).workspace, explicit);
    await assert.rejects(createWorkspace({ name: "../escape", driver: "cua" }, undefined, home), /名称/);
    await assert.rejects(createWorkspace({ name: "bad", driver: "cua", extra: "unexpected" }, undefined, home), /字段/);
    await assert.rejects(createWorkspace({ name: "one", driver: "cua" }, undefined, home), /exist|已有|EEXIST/i);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("worker reports its actual home", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ludens-api-home-")));
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  try {
    const response = await worker.call("workspaceSettings", []);
    assert.equal(response.home, home);
    assert.equal(response.config.workspaceRoot, join(home, "workspaces"));
    assert.deepEqual(response.workspaces, []);
  } finally { await worker.close(); await rm(home, { recursive: true, force: true }); }
});

test("worker preserves committed result contracts when independent settings reads fail", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-worker-commit-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  const entry = await registerFixture(home, "selected", workspace);
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  try {
    await setPetTarget(entry.id, false, home);
    await writeFile(join(home, "registry/unrelated.json"), "{");
    await writeFile(join(home, "pet/consumer.json"), "{");
    const updated = await worker.call("updateWorkspaceRoot", [join(root, "new-default")]);
    assert.deepEqual(updated, { config: await readGlobalConfig(home) });
    const removed = await worker.call("removeWorkspace", [entry.id]);
    assert.deepEqual(removed, { removed: entry });
    await assert.rejects(worker.call("workspaceSettings", []));
    assert.equal(JSON.parse(await readFile(join(home, "pet/target.json"), "utf8")), null);
    await registerWorkspace(workspace, home);
    await writeFile(join(home, "pet/target.json"), "{");
    await assert.rejects(worker.call("removeWorkspace", [entry.id]), { code: "WORKSPACE_REMOVAL_BLOCKED" });
    assert.equal((await registeredWorkspace(entry.id, home)).workspace, workspace);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker reads and updates global and workspace model connection transport configs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-worker-conn-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  const entry = await registerFixture(home, "conn-ws", workspace);
  await writeFile(join(workspace, "ludens.json"), JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.1-sol" }, null, 2));
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: home } });
  try {
    const globalResult = await worker.call("updateGlobalConnection", [{
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    }]);
    assert.deepEqual(globalResult.config.defaults.connection, {
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    });

    const initial = await worker.call("workspaceConnection", [entry.id]);
    assert.equal(initial.id, entry.id);
    assert.deepEqual(initial.connection, {});
    assert.deepEqual(initial.defaults, {
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    });

    const updated = await worker.call("updateWorkspaceConnection", [entry.id, {
      openaiWebsockets: "off",
      imageUrls: { enabled: false },
    }]);
    assert.deepEqual(updated.connection, {
      openaiWebsockets: "off",
      imageUrls: { enabled: false },
    });

    const defaultsResult = await worker.call("updateGlobalDefaults", [{
      model: "openai-codex/gpt-5.4",
      seconds: 240,
      requests: 30,
      compactionThreshold: 48000,
      pet: false,
    }]);
    assert.equal(defaultsResult.config.defaults.model, "openai-codex/gpt-5.4");
    assert.equal(defaultsResult.config.defaults.seconds, 240);
    assert.equal(defaultsResult.config.defaults.requests, 30);
    assert.equal(defaultsResult.config.defaults.compactionThreshold, 48000);
    assert.equal(defaultsResult.config.defaults.pet, false);
    assert.deepEqual(defaultsResult.config.defaults.connection, {
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    });

    const settingsSnap = await worker.call("workspaceSettings", []);
    assert.ok(settingsSnap.summaries[entry.id]);
    assert.equal(settingsSnap.summaries[entry.id]?.driver, "cua");

    await mkdir(join(workspace, ".ludens/shiori/sessions"), { recursive: true });
    const sessionA = join(workspace, ".ludens/shiori/sessions/2026-11-06_a.jsonl");
    await writeFile(sessionA, '{"type":"session"}\n');

    const studioInitial = await worker.call("workspaceStudio", [entry.id]);
    assert.equal(studioInitial.id, entry.id);
    assert.equal(studioInitial.config?.driver, "cua");
    assert.equal(studioInitial.services.jobs.length, 5);
    assert.equal(studioInitial.shiori.sessions.length, 1);

    const studioUpdated = await worker.call("updateWorkspaceStudioConfig", [entry.id, {
      model: "anthropic/claude-sonnet-4-6",
      seconds: 300,
      requests: 25,
      compactionThreshold: 24000,
      diagnostics: "full",
      pet: true,
    }]);
    assert.equal(studioUpdated.config?.model, "anthropic/claude-sonnet-4-6");
    assert.equal(studioUpdated.config?.seconds, 300);
    assert.equal(studioUpdated.config?.requests, 25);
    assert.equal(studioUpdated.config?.compactionThreshold, 24000);
    assert.equal(studioUpdated.config?.diagnostics, "full");
    assert.equal(studioUpdated.config?.pet, true);

    const afterSelect = await worker.call("updateWorkspaceShiori", [entry.id, {
      kind: "selectSession",
      sessionFile: ".ludens/shiori/sessions/2026-11-06_a.jsonl",
    }]);
    assert.equal(afterSelect.currentSessionFile, ".ludens/shiori/sessions/2026-11-06_a.jsonl");

    const afterMemory = await worker.call("updateWorkspaceShiori", [entry.id, {
      kind: "saveMemory",
      content: "# Custom Memory\nVerified note.\n",
    }]);
    assert.equal(afterMemory.memory.content, "# Custom Memory\nVerified note.\n");

    const afterReset = await worker.call("updateWorkspaceShiori", [entry.id, {
      kind: "newSession",
    }]);
    assert.equal(afterReset.currentSessionFile, null);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
