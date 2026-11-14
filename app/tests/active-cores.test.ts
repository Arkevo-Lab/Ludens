import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PET_AUTO_TARGET, type PetState } from "../lib/pet";
import { LocaleProvider } from "../lib/locale";
import type { Project } from "../lib/types";
import {
  deriveActiveCores,
  stopWorkspaceCore,
  type ActiveCoreItem,
} from "../shell/use-active-cores";
import { ConsoleSidebar } from "../shell/console-sidebar";
import type { PetFollow } from "../features/pet/use-pet-follow";
import { isValidPetTargetReceipt } from "../features/pet/use-pet-follow";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

test("deriveActiveCores filters online Cores and sorts SOS > auto > consolidating > manual", () => {
  const projects: Project[] = [
    { id: "ws-off", name: "Offline", workspace: "/tmp/off", runs: [], core: { online: false, pendingOutbound: 9 } },
    { id: "ws-man", name: "Beta Manual", workspace: "/tmp/man", runs: [], core: { online: true, mode: "manual", launchedBy: "app" } },
    { id: "ws-con", name: "Alpha Consolidating", workspace: "/tmp/con", runs: [], core: { online: true, mode: "manual", consolidating: true, launchedBy: "cli" } },
    { id: "ws-auto", name: "Zeta Auto", workspace: "/tmp/auto", runs: [], core: { online: true, mode: "auto", launchedBy: "app" } },
    { id: "ws-sos-1", name: "Delta SOS", workspace: "/tmp/sos1", runs: [], core: { online: true, mode: "manual", pendingOutbound: 1, launchedBy: "cli" } },
    { id: "ws-sos-2", name: "Gamma SOS", workspace: "/tmp/sos2", runs: [], core: { online: true, mode: "auto", pendingOutbound: 3, launchedBy: "app" } },
  ];

  const derived = deriveActiveCores(projects);
  assert.deepEqual(
    derived.map(item => item.projectId),
    ["ws-sos-2", "ws-sos-1", "ws-auto", "ws-con", "ws-man"],
  );
  assert.equal(derived[0].pendingOutbound, 3);
  assert.equal(derived[1].launchedBy, "cli");
});

test("stopWorkspaceCore posts { project, service: 'host', action: 'stop' } to /api/workspaces/service", async () => {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  await stopWorkspaceCore("ws-alpha", {
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/workspaces/service");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    project: "ws-alpha",
    service: "host",
    action: "stop",
  });
});

test("ConsoleSidebar renders active Cores list (expanded + rail) and empty state with accessible controls", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ConsoleSidebar, {
        view: "live",
        viewLink: id => `?view=${id}`,
        onNavigate() {},
        activeCores: [],
      }),
    ),
  );
  assert.match(emptyHtml, /data-active-cores=""/);
  assert.match(emptyHtml, /暂无运行中的 Core|No active Cores/);

  const activeCores: ActiveCoreItem[] = [
    {
      projectId: "ws-diablo",
      name: "Diablo III",
      mode: "auto",
      consolidating: false,
      launchedBy: "app",
      pendingOutbound: 2,
    },
    {
      projectId: "ws-zelda",
      name: "Zelda",
      mode: "manual",
      consolidating: false,
      launchedBy: "cli",
      pendingOutbound: 0,
    },
  ];

  const expandedHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ConsoleSidebar, {
        view: "live",
        viewLink: id => `?view=${id}`,
        onNavigate() {},
        activeCores,
        activeProjectId: "ws-diablo",
        onOpenCore() {},
        onStopCore() {},
      }),
    ),
  );
  assert.match(expandedHtml, /<ul role="list" class="sidebar-active-cores-list">/);
  assert.match(expandedHtml, /Diablo III/);
  assert.match(expandedHtml, /Zelda/);
  assert.match(expandedHtml, /🆘/);
  assert.match(expandedHtml, /App/);
  assert.match(expandedHtml, /CLI/);
  assert.match(expandedHtml, /sidebar-active-core-stop/);
  assert.match(expandedHtml, /■/);

  const railHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ConsoleSidebar, {
        view: "live",
        viewLink: id => `?view=${id}`,
        onNavigate() {},
        collapsed: true,
        activeCores,
        activeProjectId: "ws-diablo",
        onOpenCore() {},
      }),
    ),
  );
  assert.match(railHtml, /data-active-cores-rail=""/);
  assert.match(railHtml, /sidebar-active-cores-pill/);
  assert.match(railHtml, /Diablo III/);
});

test("PetFollowSettings selects PET_AUTO_TARGET when targetConfigured === false and shows autoFollowBadge & hint", async () => {
  const { PetFollowSettings } = await import("../features/pet/pet-follow");
  const autoState: PetState = {
    target: null,
    targetConfigured: false,
    consumer: null,
    connected: true,
    autoFollowing: true,
  };
  const follow: PetFollow = {
    state: autoState,
    pending: false,
    reading: false,
    readError: "",
    writeError: "",
    requested: undefined,
    lastReadAt: null,
    lastSaved: undefined,
    canWrite: true,
    follow: async () => {},
    refresh: () => {},
  };
  const projects: Project[] = [
    { id: "ws-1", name: "Game 1", workspace: "/tmp/game1", available: true, runs: [] },
  ];

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(PetFollowSettings, { follow, projects }),
    ),
  );
  assert.match(html, /value="!auto"/);
  assert.match(html, /<option\b[^>]*value="!auto"[^>]*selected=""/);
  assert.match(html, /data-pet-auto-follow="true"/);
  assert.match(html, /自动追踪当前正在运行的工作区 Core|Automatically follows the active workspace Core/);

  assert.equal(isValidPetTargetReceipt(PET_AUTO_TARGET, { target: null }), true);
  assert.equal(
    isValidPetTargetReceipt("ws-1", {
      target: {
        project: "ws-1",
        workspace: "/tmp/game1",
        revision: "rev-1",
        updatedAt: "2026-11-13T12:00:00Z",
      },
    }),
    true,
  );
  assert.equal(isValidPetTargetReceipt("ws-1", { target: null }), false);
});
