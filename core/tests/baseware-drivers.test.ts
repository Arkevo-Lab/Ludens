import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_CUA_DRIVER_SPEC,
  driverRegistryKey,
  ensureWorkspaceIdentity,
  readDriversConfig,
  registerWorkspace,
  removeDriverConfig,
  upsertDriverConfig,
  upsertMachineConfig,
} from "@ludens/protocol/ludens";
import {
  basewareOverview,
  registerBasewareDriver,
  removeBasewareDriver,
  upsertBasewareMachine,
} from "../src/core/query/workspaces.ts";

test("drivers.json CRUD validates IDs, reserves built-in cua, and blocks workspace-default in machines.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "ludens-drivers-crud-"));
  try {
    const initial = await readDriversConfig(home);
    expect(initial.drivers).toEqual([]);

    await expect(
      upsertDriverConfig({ id: "cua", spec: BUILTIN_CUA_DRIVER_SPEC, updatedAt: new Date().toISOString() }, home),
    ).rejects.toThrow(/built-in cua/);

    await expect(
      upsertMachineConfig({
        id: "workspace-default",
        name: "Reserved",
        driver: "cua",
        transport: { kind: "stdio", command: "cua-driver" },
        updatedAt: new Date().toISOString(),
      }, home),
    ).rejects.toThrow(/reserved/);

    const saved = await upsertDriverConfig({
      id: "switch2",
      spec: "file:/opt/drivers/switch2",
      name: "@ludens-community/driver-switch2",
      version: "0.1.0",
      description: "Switch 2 capture driver",
      transport: "bridge",
      defaultPort: 18765,
      updatedAt: "2026-11-13T00:00:00.000Z",
    }, home);
    expect(saved.drivers).toHaveLength(1);
    expect(saved.drivers[0]?.id).toBe("switch2");
    expect(driverRegistryKey("switch2", "file:/opt/drivers/switch2")).toBe("switch2::file:/opt/drivers/switch2");

    const loaded = await readDriversConfig(home);
    expect(loaded.drivers).toHaveLength(1);
    expect(loaded.drivers[0]?.defaultPort).toBe(18765);

    const removed = await removeDriverConfig({ id: "switch2" }, home);
    expect(removed.removed).toHaveLength(1);
    expect(removed.registry.drivers).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("basewareOverview surfaces workspace file: driver packages and inline workspace-default node, supports register/unregister and promote-to-global", async () => {
  const root = await mkdtemp(join(tmpdir(), "ludens-baseware-drivers-"));
  const home = join(root, "home");
  const driverDir = join(root, "ludens-switch2-driver");
  const wsDir = join(root, "switch2-diablo3");

  try {
    await mkdir(home, { recursive: true });
    await mkdir(driverDir, { recursive: true });
    await mkdir(wsDir, { recursive: true });

    await writeFile(
      join(driverDir, "package.json"),
      JSON.stringify({
        name: "@ludens-community/driver-switch2",
        version: "0.1.0",
        description: "Nintendo Switch 2 capture card + controller bridge driver",
        main: "./index.ts",
      }, null, 2),
    );
    await writeFile(
      join(driverDir, "index.ts"),
      `export default {
        id: "switch2",
        version: "0.1.0",
        transport: "bridge",
        defaultPort: 18765,
        needsGame: false,
        launchHint: "Start switch2 daemon on :18765",
        async load() { throw new Error("discover must not call load()"); },
      };`,
    );

    await writeFile(
      join(wsDir, "ludens.json"),
      JSON.stringify({
        driver: "switch2",
        driverPackage: `file:${driverDir}`,
        port: 18765,
        model: "openai-codex/gpt-5.4",
      }, null, 2),
    );
    await ensureWorkspaceIdentity(wsDir);
    const entry = await registerWorkspace(wsDir, home);

    const initial = await basewareOverview(entry.id, home);
    expect(initial.workspaceId).toBe(entry.id);
    expect(initial.binding).toEqual({ active: "workspace-default", allowed: ["workspace-default"] });
    expect(initial.implicitMachine).not.toBeNull();
    expect(initial.implicitMachine?.id).toBe("workspace-default");
    expect(initial.implicitMachine?.driver).toBe("switch2");
    expect(initial.implicitMachine?.transport).toEqual({ kind: "bridge", host: "127.0.0.1", port: 18765 });
    expect(initial.activeMachine?.id).toBe("workspace-default");

    const discovered = initial.drivers.find(item => item.id === "switch2");
    expect(discovered).toBeDefined();
    expect(discovered?.registrationStatus).toBe("unregistered");
    expect(discovered?.sourceKind).toBe("file");
    expect(discovered?.available).toBe(true);
    expect(discovered?.version).toBe("0.1.0");
    expect(discovered?.packageName).toBe("@ludens-community/driver-switch2");
    expect(discovered?.usedByCurrentWorkspace).toBe(true);
    expect(discovered?.usedByWorkspaceIds).toEqual([entry.id]);
    expect(discovered?.usedByMachineIds).toEqual(["workspace-default"]);

    // 1) Register the discovered driver into global ~/.ludens/drivers.json
    const reg = await registerBasewareDriver({ spec: `file:${driverDir}`, workspaceId: entry.id }, undefined, home);
    expect(reg.driver.id).toBe("switch2");
    expect(reg.driver.transport).toBe("bridge");
    expect(reg.driver.defaultPort).toBe(18765);
    const afterRegDriver = reg.snapshot.drivers.find(item => item.id === "switch2");
    expect(afterRegDriver?.registrationStatus).toBe("registered");
    expect(afterRegDriver?.usedByCurrentWorkspace).toBe(true);

    // 2) Unregistering from global keeps it visible as unregistered because workspace still references it
    const unreg = await removeBasewareDriver({
      id: "switch2",
      spec: `file:${driverDir}`,
      workspaceId: entry.id,
    }, home);
    expect(unreg.removed).toHaveLength(1);
    const afterUnregDriver = unreg.snapshot.drivers.find(item => item.id === "switch2");
    expect(afterUnregDriver?.registrationStatus).toBe("unregistered");
    expect(afterUnregDriver?.usedByCurrentWorkspace).toBe(true);

    // 2.5) Adding a secondary node with bindMode: "allowed" keeps workspace-default as active primary
    const secondary = await upsertBasewareMachine({
      id: "secondary-cua",
      name: "Secondary CUA",
      driver: "cua",
      transport: { kind: "stdio", command: "cua-driver" },
      updatedAt: new Date().toISOString(),
    }, home, {
      workspaceId: entry.id,
      bindMode: "allowed",
    });
    expect(secondary.snapshot?.binding).toEqual({
      active: "workspace-default",
      allowed: ["workspace-default", "secondary-cua"],
    });

    // 3) Promote inline workspace-default node to global ~/.ludens/machines.json and bind as primary
    const promoted = await upsertBasewareMachine({
      id: "switch2-capture",
      name: "Switch 2 Capture Deck",
      driver: "switch2",
      driverPackage: `file:${driverDir}`,
      transport: { kind: "bridge", host: "127.0.0.1", port: 18765 },
      updatedAt: new Date().toISOString(),
    }, home, {
      workspaceId: entry.id,
      bindMode: "primary",
    });

    expect(promoted.machine.id).toBe("switch2-capture");
    expect(promoted.snapshot?.implicitMachine).toBeNull();
    expect(promoted.snapshot?.binding).toEqual({
      active: "switch2-capture",
      allowed: ["switch2-capture", "secondary-cua"],
    });
    expect(promoted.snapshot?.activeMachine?.id).toBe("switch2-capture");
    const driverAfterPromote = promoted.snapshot?.drivers.find(item => item.id === "switch2");
    expect(driverAfterPromote?.usedByMachineIds).toContain("switch2-capture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
