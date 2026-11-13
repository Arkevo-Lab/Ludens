import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_LOCAL_DESKTOP_MACHINE } from "@ludens/protocol/machines";
import { BUILTIN_CUA_DRIVER_SPEC } from "@ludens/protocol/drivers";
import type { WorkspaceBasewareSnapshot } from "@ludens/core/core/query/workspaces";
import type { CapabilityEntry } from "@ludens/core/core/query/capabilities";
import { BasewareView } from "../features/baseware/baseware-view";
import {
  buildDisplayMachines,
  computeBasewareSummary,
  draftFromDriver,
  draftFromImplicitMachine,
  resolveControllersForMachine,
  validateDriverSpecInput,
  validateMachineDraft,
} from "../features/baseware/baseware-model";
import { ConsoleSidebar, consoleViewIds } from "../shell/console-sidebar";

test("consoleViewIds includes baseware and ConsoleSidebar renders the Baseware navigation item", () => {
  assert.ok(consoleViewIds.includes("baseware"));
  const html = renderToStaticMarkup(
    createElement(ConsoleSidebar, {
      view: "baseware",
      viewLink: id => `?view=${id}`,
      onNavigate() {},
    }),
  );
  assert.match(html, /\?view=baseware/);
  assert.match(html, /aria-current="page"/);
});

test("BasewareView renders flat tabbed device/driver lists and modal detail drawer without summary cards", () => {
  const html = renderToStaticMarkup(
    createElement(BasewareView, {
      project: "my-workspace",
      workspace: "/tmp/my-workspace",
      projects: [{ id: "my-workspace", name: "My Workspace", workspace: "/tmp/my-workspace", runs: [] }],
      ready: true,
      onRetryCatalog() {},
      onNavigate() {},
    }),
  );
  assert.match(html, /data-baseware-view/);
  assert.doesNotMatch(html, /data-baseware-summary/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-baseware-section="machine-pool"/);
  assert.match(html, /role="tabpanel"[^>]*data-baseware-section="machine-pool"/);
  assert.doesNotMatch(html, /<div[^>]*hidden[^>]*data-baseware-section="machine-pool"/);
  assert.match(html, /role="tabpanel"[^>]*hidden=""[^>]*data-baseware-section="driver-library"/);
  assert.match(html, /<dialog[^>]*data-baseware-section="controllers-catalog"/);
  assert.match(html, /data-capability-source="device"/);
  assert.doesNotMatch(html, /<dialog[^>]*role="dialog"/);
  assert.match(html, /data-baseware-add-driver/);
  assert.match(html, /data-baseware-add-machine/);
});

function makeSwitch2Snapshot(): WorkspaceBasewareSnapshot {
  return {
    workspaceId: "switch2-diablo3",
    workspaceName: "Switch2 Diablo3",
    workspacePath: "/Users/ame/.ludens/workspaces/switch2-diablo3",
    binding: { active: "workspace-default", allowed: ["workspace-default"] },
    implicitMachine: {
      id: "workspace-default",
      name: "Switch2 Diablo3 (switch2)",
      driver: "switch2",
      driverPackage: "file:/Users/ame/2610dev/playness/ludens-switch2-driver",
      transport: { kind: "bridge", host: "127.0.0.1", port: 18765 },
      updatedAt: "2026-11-13T00:00:00.000Z",
    },
    activeMachine: {
      id: "workspace-default",
      name: "Switch2 Diablo3 (switch2)",
      driver: "switch2",
      driverPackage: "file:/Users/ame/2610dev/playness/ludens-switch2-driver",
      transport: { kind: "bridge", host: "127.0.0.1", port: 18765 },
      updatedAt: "2026-11-13T00:00:00.000Z",
    },
    daemon: {
      hostSocket: null,
      basewareSocket: "/tmp/bw.sock",
      basewareSocketExists: true,
      status: {
        serviceId: "bw-switch2",
        mode: "connected",
        connected: true,
        epoch: "ep-1",
        activeMachineId: "primary",
        mountedMachines: [
          {
            id: "primary",
            label: "Switch 2 Bridge",
            driver: "switch2",
            transport: "bridge",
            connected: true,
            reason: "ok",
            isPrimary: true,
            controllers: ["pad.press", "screen.capture"],
          },
        ],
      },
      emulatorJob: null,
      basewareJob: null,
    },
    machines: [
      {
        ...BUILTIN_LOCAL_DESKTOP_MACHINE,
        usedByWorkspaceIds: [],
      },
    ],
    drivers: [
      {
        key: "switch2::file:/Users/ame/2610dev/playness/ludens-switch2-driver",
        id: "switch2",
        spec: "file:/Users/ame/2610dev/playness/ludens-switch2-driver",
        sourceKind: "file",
        registrationStatus: "unregistered",
        available: true,
        localPath: "/Users/ame/2610dev/playness/ludens-switch2-driver",
        packageName: "@ludens-community/driver-switch2",
        name: "@ludens-community/driver-switch2",
        version: "0.1.0",
        description: "Nintendo Switch 2 capture card driver",
        transport: "bridge",
        defaultPort: 18765,
        usedByMachineIds: ["workspace-default"],
        usedByWorkspaceIds: ["switch2-diablo3"],
        usedByCurrentWorkspace: true,
        updatedAt: "2026-11-13T00:00:00.000Z",
      },
      {
        key: "cua::builtin:cua",
        id: "cua",
        spec: BUILTIN_CUA_DRIVER_SPEC,
        sourceKind: "builtin",
        registrationStatus: "builtin",
        available: true,
        name: "Built-in Desktop CUA",
        usedByMachineIds: ["local-desktop"],
        usedByWorkspaceIds: [],
        usedByCurrentWorkspace: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

test("baseware-model maps live daemon 'primary' onto implicit 'workspace-default' and keeps orthogonal states", () => {
  const snapshot = makeSwitch2Snapshot();
  const display = buildDisplayMachines(snapshot);

  assert.equal(display.length, 2);
  const inline = display[0]!;
  assert.equal(inline.id, "workspace-default");
  assert.equal(inline.registrationStatus, "unregistered");
  assert.equal(inline.workspaceAdditionStatus, "primary");
  assert.equal(inline.isMounted, true);
  assert.equal(inline.isImplicit, true);

  const localDesktop = display[1]!;
  assert.equal(localDesktop.id, "local-desktop");
  assert.equal(localDesktop.registrationStatus, "builtin");
  assert.equal(localDesktop.workspaceAdditionStatus, "not-added");
  assert.equal(localDesktop.isMounted, false);

  const summary = computeBasewareSummary(snapshot);
  assert.equal(summary.totalDrivers, 2);
  assert.equal(summary.registeredDrivers, 1);
  assert.equal(summary.unregisteredDrivers, 1);
  assert.equal(summary.activeTarget?.id, "workspace-default");
  assert.equal(summary.addedMachinesCount, 1);
  assert.equal(summary.mountedMachinesCount, 1);

  const caps: CapabilityEntry[] = [
    { id: "controller/primary/screen.capture", kind: "device", description: "Capture frame", requiresControl: false, readOnly: true },
    { id: "controller/primary/pad.press", kind: "device", description: "Press button", requiresControl: true, readOnly: false },
  ];
  const resolved = resolveControllersForMachine(caps, inline, snapshot);
  assert.deepEqual(resolved.map(c => c.id), ["controller/screen.capture", "controller/pad.press"]);
  assert.deepEqual(resolveControllersForMachine(caps, localDesktop, snapshot), []);
});

test("baseware-model drafts and validators enforce valid specs, ports, and reserved workspace-default ID", () => {
  const snapshot = makeSwitch2Snapshot();
  const fromDriver = draftFromDriver(snapshot.drivers[0]!, ["local-desktop"]);
  assert.equal(fromDriver.id, "switch2");
  assert.equal(fromDriver.driver, "switch2");
  assert.equal(fromDriver.driverPackage, "file:/Users/ame/2610dev/playness/ludens-switch2-driver");
  assert.equal(fromDriver.transportKind, "bridge");
  assert.equal(fromDriver.bridgePort, "18765");

  const promoted = draftFromImplicitMachine(snapshot.implicitMachine!, snapshot.workspaceId, ["local-desktop"]);
  assert.equal(promoted.id, "switch2-diablo3");
  assert.equal(promoted.bindMode, "primary");
  assert.equal(validateMachineDraft(promoted, false).valid, true);

  assert.equal(validateMachineDraft({ ...promoted, id: "workspace-default" }, false).errors.id, "reservedId");
  assert.equal(validateMachineDraft({ ...promoted, bridgePort: "70000" }, false).errors.bridgePort, "invalidPort");
  assert.equal(validateDriverSpecInput("").error, "required");
  assert.equal(validateDriverSpecInput("has spaces").error, "invalidFormat");
  assert.equal(validateDriverSpecInput("file:/opt/driver").valid, true);
  assert.equal(validateDriverSpecInput("file:/opt/My Drivers/switch2").valid, true);
  assert.equal(validateDriverSpecInput("https://github.com/org/repo.git#main").valid, true);
  assert.equal(validateDriverSpecInput("git@github.com:org/repo.git#v1").valid, true);
});
