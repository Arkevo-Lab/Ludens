import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyWorkspaceDraft,
  findExistingWorkspaceConflict,
  initialWorkspaceSetup,
  normalizedWorkspacePath,
  switchWorkspaceEnvironment,
  switchWorkspaceTargetMode,
  workspaceCreateInput,
  workspaceDriverCapabilities,
  workspaceLocation,
} from "../features/workspaces/workspace-create-model";
import {
  isSelectedModelAuthenticated,
  resolveCreationModelDefaults,
} from "../features/workspaces/use-workspace-creation-catalog";
import type { AvailableModelsCatalog } from "../components/model-picker-dialog";
import type { DiscoveredDriver } from "../lib/drivers";
import type { BasewareDriverOverviewItem, BasewareMachineRuntimeStatus } from "../lib/workspaces";

const root = "/Users/example/workspaces";
const desktop = { ...emptyWorkspaceDraft, name: "My workspace" };
const driver: DiscoveredDriver = {
  id: "example", spec: "github:example/driver#v1", version: "1.0", transport: "bridge", defaultPort: 47663,
  needsGame: true, launchCommand: ["example-emulator"],
};

test("a creation URL only prefills a package; matching in-memory discovery can carry verification", () => {
  const fromUrl = initialWorkspaceSetup({ driverPackage: ` ${driver.spec} ` });
  assert.equal(fromUrl.draft.environment, "community");
  assert.equal(fromUrl.draft.driverPackage, driver.spec);
  assert.equal(fromUrl.driver, null);
  assert.equal(workspaceCreateInput(root, { ...fromUrl.draft, name: "demo" }, fromUrl.driver).ok, false);
  const verified = initialWorkspaceSetup({ driverPackage: driver.spec, driver });
  assert.equal(workspaceCreateInput(root, { ...verified.draft, name: "demo" }, verified.driver).ok, true);
  assert.equal(initialWorkspaceSetup({ driverPackage: "other", driver }).driver, null);
  assert.deepEqual(initialWorkspaceSetup({ driverPackage: "" }).draft, emptyWorkspaceDraft);
});

test("desktop creation only needs a folder name and leaves the default root to the server", () => {
  assert.deepEqual(workspaceCreateInput(root, desktop, null), { ok: true, input: { name: "My workspace", driver: "cua" } });
  assert.equal(workspaceLocation(root, desktop).path, `${root}/My workspace`);
  assert.equal(workspaceCreateInput(root, { ...desktop, name: "../other" }, null).ok, false);
});

test("a custom final directory determines the displayed and submitted folder name without losing the draft", () => {
  const draft = { ...desktop, targetDirectory: " /Volumes/work/old/../Different name/ " };
  assert.deepEqual(workspaceLocation(root, draft), { path: "/Volumes/work/Different name", name: "Different name", custom: true });
  assert.deepEqual(workspaceCreateInput(root, draft, null), {
    ok: true, input: { name: "Different name", driver: "cua", workspace: "/Volumes/work/Different name" },
  });
  assert.equal(workspaceLocation(root, { ...draft, targetDirectory: "" }).name, "My workspace");
  for (const targetDirectory of ["relative/path", "/", "/work/../", "/bad\0path"])
    assert.equal(workspaceCreateInput(root, { ...desktop, targetDirectory }, null).ok, false);
  assert.equal(normalizedWorkspacePath("/a/./b/../c"), "/a/c");
});

test("a changed community package cannot reuse an old verification", () => {
  const draft = { ...desktop, environment: "community" as const, driverPackage: driver.spec };
  assert.equal(workspaceCreateInput(root, draft, null).ok, false);
  assert.equal(workspaceCreateInput(root, { ...draft, driverPackage: `${driver.spec}2` }, driver).ok, false);
  assert.deepEqual(workspaceCreateInput(root, draft, driver), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec },
  });
});

test("driver capabilities determine submitted fields; needsGame never makes a game path mandatory", () => {
  const draft = { ...desktop, environment: "community" as const, driverPackage: driver.spec, game: " games/demo.bin ", cuaCommand: "/old/cua" };
  assert.deepEqual(workspaceCreateInput(root, draft, driver), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec, game: "games/demo.bin" },
  });
  const manual = { ...driver, launchCommand: undefined };
  assert.equal(workspaceDriverCapabilities("community", manual).supportsGame, false);
  assert.deepEqual(workspaceCreateInput(root, draft, manual), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec },
  });
  const stdio = { ...driver, transport: "stdio", defaultPort: undefined };
  assert.deepEqual(workspaceCreateInput(root, draft, stdio), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec, cuaCommand: "/old/cua" },
  });
  assert.equal(workspaceCreateInput(root, { ...draft, game: "" }, driver).ok, true);
  assert.equal(workspaceCreateInput(root, draft, { ...driver, defaultPort: undefined }).ok, false);
});

test("switching environments clears device options and never submits a hidden community package", () => {
  const community = { ...desktop, environment: "community" as const, driverPackage: driver.spec, game: "/game", cuaCommand: "/driver" };
  const switched = switchWorkspaceEnvironment(community, "desktop");
  assert.equal(switched.game, ""); assert.equal(switched.cuaCommand, "");
  assert.deepEqual(workspaceCreateInput(root, switched, driver), { ok: true, input: { name: desktop.name, driver: "cua" } });
  assert.deepEqual(workspaceCreateInput(root, { ...community, environment: "desktop" }, driver), {
    ok: true, input: { name: desktop.name, driver: "cua", cuaCommand: "/driver" },
  });
});

test("3-mode target selector builds rich payload for machine pool, installed driver, and package registration", () => {
  const gbaMachine: BasewareMachineRuntimeStatus = {
    id: "gba-mgba",
    name: "GBA · LeafGreen",
    driver: "mgba",
    driverPackage: "file:/drivers/mgba",
    transport: { kind: "bridge", port: 47653, host: "127.0.0.1" },
    updatedAt: "2026-11-07T00:00:00.000Z",
    usedByWorkspaceIds: [],
  };

  const machineDraft = switchWorkspaceTargetMode(
    { ...desktop, model: "anthropic/claude-sonnet-4-5", effort: "high", serviceTier: null },
    "machine",
    { defaultMachine: gbaMachine },
  );
  assert.deepEqual(
    workspaceCreateInput(root, machineDraft, null, { machines: [gbaMachine] }),
    {
      ok: true,
      input: {
        name: "My workspace",
        driver: "mgba",
        machineId: "gba-mgba",
        driverPackage: "file:/drivers/mgba",
        model: "anthropic/claude-sonnet-4-5",
        effort: "high",
        serviceTier: null,
      },
    },
  );

  const catalogDriver: BasewareDriverOverviewItem = {
    key: "mgba::file:/drivers/mgba",
    id: "mgba",
    spec: "file:/drivers/mgba",
    sourceKind: "file",
    registrationStatus: "registered",
    available: true,
    transport: "bridge",
    defaultPort: 47653,
    needsGame: true,
    usedByMachineIds: [],
    usedByWorkspaceIds: [],
    usedByCurrentWorkspace: false,
    updatedAt: "2026-11-07T00:00:00.000Z",
  };
  const driverModeDraft = {
    ...switchWorkspaceTargetMode(desktop, "driver", { defaultDriver: catalogDriver }),
    game: "/roms/leafgreen.gba",
    port: "47701",
  };
  assert.deepEqual(
    workspaceCreateInput(root, driverModeDraft, null, { catalogDriver }),
    {
      ok: true,
      input: {
        name: "My workspace",
        driver: "mgba",
        driverPackage: "file:/drivers/mgba",
        game: "/roms/leafgreen.gba",
        port: 47701,
      },
    },
  );
  assert.equal(
    workspaceCreateInput(root, { ...driverModeDraft, port: "99999" }, null, { catalogDriver }).ok,
    false,
  );

  const pkgDraft = {
    ...switchWorkspaceTargetMode(desktop, "package"),
    driverPackage: driver.spec,
    registerDriver: true,
  };
  assert.deepEqual(workspaceCreateInput(root, pkgDraft, driver), {
    ok: true,
    input: {
      name: "My workspace",
      driver: driver.id,
      driverPackage: driver.spec,
      registerDriver: true,
    },
  });
});

test("detects duplicate workspace path conflicts and resolves authenticated model defaults", () => {
  const conflict = findExistingWorkspaceConflict(
    [
      {
        id: "ws-existing",
        name: "My workspace",
        workspace: "/Users/example/workspaces/My workspace",
        updatedAt: "2026-11-18T00:00:00.000Z",
        available: true,
      },
    ],
    root,
    desktop,
  );
  assert.equal(conflict?.id, "ws-existing");
  assert.equal(findExistingWorkspaceConflict([], root, desktop), null);

  const catalog: AvailableModelsCatalog = {
    models: [
      {
        provider: "openai-codex",
        id: "gpt-6.2-sol",
        fullId: "openai-codex/gpt-6.2-sol",
        name: "GPT 6.2",
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 16000,
        authenticated: false,
        supportedServiceTiers: [],
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        fullId: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 16000,
        authenticated: true,
        supportedServiceTiers: [],
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    ],
    providers: [
      { id: "openai-codex", count: 1, authenticated: false },
      { id: "anthropic", count: 1, authenticated: true },
    ],
  };

  // When global default has no explicit model, prefers first authenticated model
  const resolvedAuto = resolveCreationModelDefaults({}, catalog);
  assert.equal(resolvedAuto.model, "anthropic/claude-sonnet-4-5");
  assert.equal(resolvedAuto.authenticated, true);
  assert.equal(isSelectedModelAuthenticated("openai-codex/gpt-6.2-sol", catalog), false);
  assert.equal(isSelectedModelAuthenticated("anthropic/claude-sonnet-4-5", catalog), true);
});
