import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDriversConfig,
  upsertMachineConfig,
  writeGlobalConfig,
} from "@ludens/protocol/ludens";
import { createWorkspace, basewareOverview } from "../src/query/workspaces";
import { initializeWorkspace } from "../src/query/workspace-init";

describe("in-process workspace initialization & onboarding options", () => {
  test("creates a CUA workspace in-process with model, effort, serviceTier, and machineId binding", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-init-onboarding-")));
    const home = join(root, "home");
    try {
      await writeGlobalConfig(
        {
          version: 1,
          workspaceRoot: join(home, "workspaces"),
          defaults: {
            model: "openai-codex/gpt-5.2",
            effort: "medium",
            serviceTier: "priority",
            seconds: 1200,
            requests: 500,
            pet: false,
          },
        },
        home,
      );

      const startedAt = performance.now();
      const entry = await createWorkspace(
        {
          name: "fast-desktop",
          driver: "cua",
          machineId: "local-desktop",
          model: "anthropic/claude-sonnet-4-5",
          effort: "high",
          serviceTier: null,
          seconds: 900,
          requests: 250,
          pet: true,
        },
        undefined,
        home,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(entry.name).toBe("fast-desktop");
      expect(entry.workspace).toBe(join(home, "workspaces", "fast-desktop"));
      // Pure in-process CUA initialization without spawning `core/bin/ludens` subprocesses.
      expect(elapsedMs).toBeLessThan(250);

      const rawConfig = JSON.parse(await readFile(join(entry.workspace, "ludens.json"), "utf8"));
      expect(rawConfig.driver).toBe("cua");
      expect(rawConfig.model).toBe("anthropic/claude-sonnet-4-5");
      expect(rawConfig.effort).toBe("high");
      expect(rawConfig.serviceTier).toBeUndefined();
      expect(rawConfig.seconds).toBe(900);
      expect(rawConfig.requests).toBe(250);
      expect(rawConfig.pet).toBe(true);
      expect(rawConfig.machines).toEqual({
        active: "local-desktop",
        allowed: ["local-desktop"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds an existing bridge machine from machines.json and registers community driver when requested", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-init-machine-")));
    const home = join(root, "home");
    const driverDir = join(root, "mock-mgba-driver");
    try {
      await mkdir(driverDir, { recursive: true });
      await writeFile(
        join(driverDir, "package.json"),
        JSON.stringify({
          name: "@test/mgba-driver",
          version: "1.2.0",
          description: "Mock mGBA bridge driver",
          type: "module",
          exports: "./index.js",
        }),
      );
      await writeFile(
        join(driverDir, "index.js"),
        `export default {
  id: "mgba",
  version: "1.2.0",
  transport: "bridge",
  defaultPort: 47653,
  needsGame: false,
  launchCommand: ["mgba-qt"],
  launchHint: "Start mGBA with Lua bridge script loaded.",
  async load() { throw new Error("init must not invoke load()"); }
};\n`,
      );

      await upsertMachineConfig(
        {
          id: "gba-leafgreen",
          name: "GBA · LeafGreen",
          driver: "mgba",
          driverPackage: `file:${driverDir}`,
          transport: { kind: "bridge", host: "127.0.0.1", port: 47699 },
          updatedAt: new Date().toISOString(),
        },
        home,
      );

      // Creating from machineId inherits driver + driverPackage automatically even when driver is empty
      const fromMachine = await createWorkspace(
        {
          name: "leafgreen-run",
          driver: "",
          machineId: "gba-leafgreen",
        },
        undefined,
        home,
      );
      const machineCfg = JSON.parse(await readFile(join(fromMachine.workspace, "ludens.json"), "utf8"));
      expect(machineCfg.driver).toBe("mgba");
      expect(machineCfg.driverPackage).toBe(`file:${driverDir}`);
      expect(machineCfg.machines).toEqual({
        active: "gba-leafgreen",
        allowed: ["gba-leafgreen"],
      });

      // Creating from driverPackage with registerDriver: true saves to ~/.ludens/drivers.json
      const fromPackage = await createWorkspace(
        {
          name: "emerald-run",
          driver: "mgba",
          driverPackage: `file:${driverDir}`,
          game: "/roms/emerald.gba",
          port: 47700,
          registerDriver: true,
        },
        undefined,
        home,
      );
      const packageCfg = JSON.parse(await readFile(join(fromPackage.workspace, "ludens.json"), "utf8"));
      expect(packageCfg.game).toBe("/roms/emerald.gba");
      expect(packageCfg.port).toBe(47700);

      const driversReg = await readDriversConfig(home);
      expect(driversReg.drivers.some(d => d.id === "mgba" && d.defaultPort === 47653)).toBe(true);

      const overview = await basewareOverview(fromMachine.id, home);
      expect(overview.binding.active).toBe("gba-leafgreen");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("initializeWorkspace binds workspace to a registered machine when machineId is provided", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ludens-cli-machine-init-")));
    const home = join(root, "home");
    try {
      await initializeWorkspace(
        { name: "cli-desktop", driver: "", machineId: "local-desktop" },
        { home },
      );
      const cfg = JSON.parse(await readFile(join(home, "workspaces", "cli-desktop", "ludens.json"), "utf8"));
      expect(cfg.driver).toBe("cua");
      expect(cfg.machines).toEqual({
        active: "local-desktop",
        allowed: ["local-desktop"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
