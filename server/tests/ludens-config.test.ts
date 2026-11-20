import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorkspaceIdentity,
  forgetWorkspace,
  listRegisteredWorkspaces,
  readGlobalConfig,
  readWorkspaceIdentity,
  registerWorkspace,
  renewWorkspaceIdentity,
  updateGlobalConfig,
  writeGlobalConfig,
} from "@ludens/protocol/ludens";
import { defaultDriverCacheRoot, resolveDriver } from "@ludens/baseware/drivers/loader.ts";
import { launchPlan, parseConfig } from "../src/daemon/launcher.ts";
import { initializeWorkspace } from "../src/query/workspace-init.ts";
import {
  openWorkspace,
  updateGlobalDefaults,
  updateWorkspaceRoot,
} from "../src/query/workspaces.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-layout-")));
  const home = join(root, "application"), cwd = join(root, "caller");
  await mkdir(cwd);
  return { root, home, cwd, close: () => rm(root, { recursive: true, force: true }) };
}

test("new workspaces use the configured parent or an explicit path and snapshot global defaults", async () => {
  const f = await fixture();
  try {
    expect((await readGlobalConfig(f.home)).workspaceRoot).toBe(join(f.home, "workspaces"));
    await expect(initializeWorkspace({ name: "", driver: "cua" }, { home: f.home })).rejects.toThrow();
    expect(await readdir(f.cwd)).toEqual([]);
    const parent = join(f.root, "chosen parent");
    await updateWorkspaceRoot(parent, f.home);
    await updateGlobalDefaults({ compactionThreshold: 70100, pet: true }, f.home);
    const first = await initializeWorkspace({ name: "first", driver: "cua", pet: false }, { home: f.home });
    expect(first.workspace).toBe(join(parent, "first"));
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ compactionThreshold: 70100, pet: false });
    await updateGlobalDefaults({ compactionThreshold: 99900 }, f.home);
    const second = await initializeWorkspace({ name: "second", driver: "cua" }, { home: f.home });
    expect(JSON.parse(await readFile(second.configPath, "utf8"))).toMatchObject({ compactionThreshold: 99900, pet: true });
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ compactionThreshold: 70100, pet: false });
    const outside = join(f.root, "external folder");
    const explicit = await initializeWorkspace({ name: "external", workspace: outside, driver: "cua" }, { home: f.home });
    expect(explicit.workspace).toBe(outside);
    const prefix = await initializeWorkspace({ name: "prefix", workspace: join(f.root, "prefix"), driver: "cua" }, { home: f.home });
    expect(prefix.workspace).toBe(join(f.root, "prefix"));
    expect((await listRegisteredWorkspaces(f.home)).length).toBe(4);
    await expect(initializeWorkspace({ name: "../escape", driver: "cua" }, { home: f.home })).rejects.toThrow();
    await expect(initializeWorkspace({ name: "first", driver: "cua" }, { home: f.home })).rejects.toThrow(/EEXIST|已存在/);
  } finally { await f.close(); }
});

test("invalid global settings never overwrite the saved configuration", async () => {
  const f = await fixture();
  try {
    expect(await readGlobalConfig(f.home)).toEqual({ version: 1, workspaceRoot: join(f.home, "workspaces"), defaults: {} });
    await writeGlobalConfig({ version: 1, workspaceRoot: f.cwd, defaults: { model: "fixture/model", compactionThreshold: 50000 } }, f.home);
    const before = await readFile(join(f.home, "config.json"), "utf8");
    for (const patch of [{ pet: "yes" }, { compactionThreshold: 0 }, { compactionThreshold: 1.5 }, { seconds: 60 }, { requests: 10 }]) {
      await expect(updateGlobalDefaults(patch, f.home)).rejects.toThrow();
      expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(before);
    }
    await writeFile(
      join(f.home, "config.json"),
      JSON.stringify({ version: 1, workspaceRoot: f.cwd, defaults: { model: "fixture/model", dashboard: true, pet: false } }, null, 2),
      "utf8",
    );
    const loadedLegacy = await readGlobalConfig(f.home);
    expect(loadedLegacy.defaults).toEqual({ model: "fixture/model", pet: false });
    expect("dashboard" in loadedLegacy.defaults).toBe(false);
    await updateGlobalConfig(cfg => ({ ...cfg, defaults: { ...cfg.defaults, compactionThreshold: 12000 } }), f.home);
    const savedRaw = JSON.parse(await readFile(join(f.home, "config.json"), "utf8")) as { defaults: Record<string, unknown> };
    expect("dashboard" in savedRaw.defaults).toBe(false);
    expect(savedRaw.defaults).toEqual({ model: "fixture/model", pet: false, compactionThreshold: 12000 });
  } finally { await f.close(); }
});

test("concurrent config edits keep independently changed fields", async () => {
  const f = await fixture();
  const entry = import.meta.resolve("@ludens/protocol/ludens");
  const child = Bun.spawn([process.execPath, "--eval", `
    import { updateGlobalConfig } from ${JSON.stringify(entry)};
    await updateGlobalConfig(async config => {
      console.log("locked");
      await Bun.stdin.text();
      return { ...config, defaults: { ...config.defaults, compactionThreshold: 70100 } };
    }, ${JSON.stringify(f.home)});
  `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const error = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    const edits = Promise.all([
      updateGlobalDefaults({ pet: true }, f.home),
      updateGlobalDefaults({ effort: "high" }, f.home),
    ]);
    await Bun.sleep(150);
    child.stdin.end();
    expect(await child.exited, await error).toBe(0);
    await edits;
    expect((await readGlobalConfig(f.home)).defaults).toEqual({ compactionThreshold: 70100, pet: true, effort: "high" });
    const before = await readFile(join(f.home, "config.json"), "utf8");
    await expect(updateGlobalConfig(() => { throw new Error("cancelled edit"); }, f.home)).rejects.toThrow("cancelled edit");
    expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(before);
    expect((await readdir(f.home)).filter(name => name.includes(".lock"))).toEqual([]);
  } finally { child.kill(); await child.exited; await f.close(); }
});

test("exited lock owners are recovered without competing recoverers deleting a new owner's lock", async () => {
  const f = await fixture();
  const entry = import.meta.resolve("@ludens/protocol/ludens");
  const crashed = Bun.spawn([process.execPath, "--eval", `
    import { updateGlobalConfig } from ${JSON.stringify(entry)};
    await updateGlobalConfig(async config => { console.log("locked"); await Bun.stdin.text(); return config; }, ${JSON.stringify(f.home)});
  `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const workers: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const reader = crashed.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    crashed.kill("SIGKILL"); await crashed.exited;
    expect(() => process.kill(crashed.pid, 0)).toThrow();
    expect(await readdir(join(f.home, "config.json.lock"))).toHaveLength(1);
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { updateGlobalConfig } from ${JSON.stringify(entry)};
        await updateGlobalConfig(async config => {
          await Bun.sleep(25);
          return { ...config, defaults: { ...config.defaults, compactionThreshold: (config.defaults.compactionThreshold ?? 0) + 1 } };
        }, ${JSON.stringify(f.home)});
      `], { cwd: f.cwd, env: { ...process.env, LUDENS_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
      workers.push(child);
      return { code: await child.exited, stderr: await new Response(child.stderr).text() };
    }));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    expect((await readGlobalConfig(f.home)).defaults.compactionThreshold).toBe(8);
    expect((await readdir(f.home)).filter(name => name.includes(".lock"))).toEqual([]);

    const workspace = join(f.root, "workspace"); await mkdir(workspace);
    const identity = await ensureWorkspaceIdentity(workspace);
    const staleRegistryLock = join(f.home, "registry", `${identity.id}.json.lock`);
    await mkdir(staleRegistryLock, { recursive: true });
    await writeFile(join(staleRegistryLock, `owner-${crashed.pid}-${randomUUID()}`), "");
    expect((await registerWorkspace(workspace, f.home)).id).toBe(identity.id);
    expect((await readdir(join(f.home, "registry"))).filter(name => name.includes(".lock"))).toEqual([]);
  } finally {
    crashed.kill(); await crashed.exited;
    for (const child of workers) { child.kill(); await child.exited; }
    await f.close();
  }
});

test("workspace identity survives moves and index loss; unavailable and forgotten entries never delete data", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), moved = join(f.root, "moved");
    await mkdir(original);
    const [one, two] = await Promise.all([ensureWorkspaceIdentity(original), ensureWorkspaceIdentity(original)]);
    expect(one.id).toBe(two.id);
    await writeFile(join(original, "ludens.json"), '{"driver":"cua"}');
    await writeFile(join(original, "important.txt"), "preserved");
    await registerWorkspace(original, f.home);
    await rename(original, moved);
    expect(await listRegisteredWorkspaces(f.home)).toMatchObject([{ id: one.id, available: false }]);
    const reopened = await openWorkspace(moved, f.home);
    expect(reopened).toMatchObject({ id: one.id, workspace: moved });
    await forgetWorkspace(one.id, f.home);
    expect(await listRegisteredWorkspaces(f.home)).toEqual([]);
    expect(await readFile(join(moved, "important.txt"), "utf8")).toBe("preserved");
    await rm(f.home, { recursive: true });
    expect((await registerWorkspace(moved, f.home)).id).toBe(one.id);
  } finally { await f.close(); }
});

test("new-id checks owned target cleanup before changing identity or resume state", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), copied = join(f.root, "copied");
    await mkdir(original);
    const identity = await ensureWorkspaceIdentity(original);
    await registerWorkspace(original, f.home);
    const selector = join(original, ".ludens/shiori/current-session.json");
    await mkdir(join(original, ".ludens/shiori"), { recursive: true });
    await writeFile(selector, JSON.stringify({ sessionFile: "sessions/keep.jsonl" }));
    const identityPath = join(original, ".ludens/workspace.json"), registration = join(f.home, `registry/${identity.id}.json`);
    const before = await Promise.all([identityPath, selector, registration].map(path => readFile(path, "utf8")));
    await mkdir(join(f.home, "pet"));
    const targetPath = join(f.home, "pet/target.json"); await writeFile(targetPath, "{");
    await expect(openWorkspace(original, f.home, { newId: true })).rejects.toThrow("仍在列表中");
    expect(await Promise.all([identityPath, selector, registration].map(path => readFile(path, "utf8")))).toEqual(before);
    await cp(original, copied, { recursive: true });
    await openWorkspace(copied, f.home, { newId: true });
    expect(await Promise.all([identityPath, selector, registration].map(path => readFile(path, "utf8")))).toEqual(before);
    expect(await readFile(targetPath, "utf8")).toBe("{");
    await writeFile(targetPath, JSON.stringify({ project: identity.id, workspace: original, revision: "fixture", updatedAt: new Date().toISOString() }));
    await openWorkspace(original, f.home, { newId: true });
    expect((await readWorkspaceIdentity(original)).id).not.toBe(identity.id);
    expect(await Bun.file(selector).exists()).toBe(false);
    expect(await Bun.file(registration).exists()).toBe(false);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toBeNull();
  } finally { await f.close(); }
});

test("independent copies require a new identity and retain explicit archive ownership", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), copy = join(f.root, "copy");
    await mkdir(original);
    const first = await ensureWorkspaceIdentity(original);
    await writeFile(join(original, "ludens.json"), '{"driver":"cua"}');
    await mkdir(join(original, ".ludens/shiori"), { recursive: true });
    await writeFile(join(original, ".ludens/shiori/current-session.json"), JSON.stringify({ sessionFile: "sessions/old.jsonl" }));
    await registerWorkspace(original, f.home);
    await cp(original, copy, { recursive: true });
    await expect(openWorkspace(copy, f.home)).rejects.toThrow("--new-id");
    await openWorkspace(copy, f.home, { newId: true });
    const second = await readWorkspaceIdentity(copy);
    expect(second.id).not.toBe(first.id);
    expect(second.historyIds).toEqual([first.id]);
    expect((await readWorkspaceIdentity(original)).id).toBe(first.id);
    expect(await Bun.file(join(copy, ".ludens/shiori/current-session.json")).exists()).toBe(false);
    expect(await Bun.file(join(original, ".ludens/shiori/current-session.json")).exists()).toBe(true);
    expect((await listRegisteredWorkspaces(f.home)).length).toBe(2);
    const third = await renewWorkspaceIdentity(copy, f.home);
    expect(third.historyIds).toEqual([second.id, first.id]);
  } finally { await f.close(); }
});

test("a workspace-relative community package remains portable in saved configuration", async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, "with-driver");
    await mkdir(join(workspace, "driver"), { recursive: true });
    await writeFile(join(workspace, "driver/index.ts"), 'export default { id: "fixture", transport: "bridge", defaultPort: 45678, load() { throw new Error("must not load"); } };');
    await initializeWorkspace(
      { name: "with-driver", workspace, driver: "fixture", driverPackage: "file:./driver/index.ts" },
      { home: f.home },
    );
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).driverPackage).toBe("file:./driver/index.ts");
    const moved = join(f.root, "moved-driver");
    await rename(workspace, moved);
    const raw = JSON.parse(await readFile(join(moved, "ludens.json"), "utf8")) as Record<string, unknown>;
    const resolvedPkg = `file:${join(moved, "driver", "index.ts")}`;
    const manifest = await resolveDriver("fixture", resolvedPkg, defaultDriverCacheRoot());
    const plan = await launchPlan(parseConfig(raw, manifest), moved, undefined, undefined, manifest);
    expect(plan.commands.baseware).toContain(resolvedPkg);
  } finally { await f.close(); }
});

test("concurrent first registration cannot silently claim two copies of the same workspace", async () => {
  const f = await fixture();
  try {
    const one = join(f.root, "one"), two = join(f.root, "two");
    await mkdir(one);
    await ensureWorkspaceIdentity(one);
    await cp(one, two, { recursive: true });
    const results = await Promise.allSettled([registerWorkspace(one, f.home), registerWorkspace(two, f.home)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await listRegisteredWorkspaces(f.home)).toHaveLength(1);
    expect((await readdir(join(f.home, "registry"))).some(name => name.endsWith(".lock"))).toBe(false);
  } finally { await f.close(); }
});
