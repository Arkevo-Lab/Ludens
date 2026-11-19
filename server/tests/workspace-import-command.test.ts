import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceIdentity } from "@ludens/protocol/ludens";
import { ludensSocketPath } from "../src/daemon/background-jobs.ts";
import { importWorkspace, openWorkspace } from "../src/query/workspaces.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-import-command-")));
  const home = join(root, "global"), workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "ludens.json"), '{"driver":"cua"}');
  return { root, home, workspace, close: () => rm(root, { recursive: true, force: true }) };
}

async function listening(workspace: string, service: "core" | "baseware") {
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const path = ludensSocketPath(service, hash);
  const server = createServer(socket => socket.end());
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  return () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

test("import and new-id refuse an active workspace without changing its identity or files", async () => {
  const f = await fixture();
  try {
    await ensureWorkspaceIdentity(f.workspace);
    const identityPath = join(f.workspace, ".ludens/workspace.json");
    const before = await readFile(identityPath, "utf8");
    for (const service of ["core", "baseware"] as const) {
      const stop = await listening(f.workspace, service);
      try {
        await expect(importWorkspace({ workspace: f.workspace }, f.home))
          .rejects.toThrow(`Workspace is running (${service})`);
        await expect(openWorkspace(f.workspace, f.home, { newId: true }))
          .rejects.toThrow(`Workspace is running (${service})`);
        expect(await readFile(identityPath, "utf8")).toBe(before);
        expect(await readdir(join(f.workspace, ".ludens"))).toEqual(["workspace.json"]);
      } finally { await stop(); }
    }
  } finally { await f.close(); }
});

test("an active previous workspace is detected through a symlink before importing a moved copy", async () => {
  const f = await fixture();
  try {
    const previous = join(f.root, "previous"), alias = join(f.root, "previous-alias");
    await mkdir(previous);
    await symlink(previous, alias);
    const stop = await listening(previous, "core");
    try {
      await expect(importWorkspace({ workspace: f.workspace, previousWorkspace: alias }, f.home))
        .rejects.toThrow("Workspace is running (core)");
      expect(await readdir(f.workspace)).toEqual(["ludens.json"]);
    } finally { await stop(); }
  } finally { await f.close(); }
});
