import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../messages/en.json";
import { LocaleProvider } from "../lib/locale";
import type { Project } from "../lib/types";
import type { WorkspaceStudioSnapshot } from "../lib/workspaces";
import type { PetFollow } from "../features/pet/pet-follow";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const { SettingsView } = nodeRequire("../features/workspaces/settings-view") as typeof import("../features/workspaces/settings-view");
const { ConnectionSettings } = nodeRequire("../features/workspaces/connection-settings") as typeof import("../features/workspaces/connection-settings");
const {
  ModelAndBudgetPanel,
  ServicesAndShioriPanel,
  WorkspaceStudioView,
} = nodeRequire("../features/workspaces/workspace-studio-view") as typeof import("../features/workspaces/workspace-studio-view");

const PROJECTS: Project[] = [
  {
    id: "switch2-diablo3",
    name: "Switch2 Diablo3",
    workspace: "/tmp/switch2-diablo3",
    runs: [],
  },
];

const MOCK_FOLLOW: PetFollow = {
  state: null,
  pending: false,
  reading: false,
  readError: "",
  writeError: "",
  requested: undefined,
  lastReadAt: null,
  lastSaved: undefined,
  canWrite: false,
  follow: async () => {},
  refresh: () => {},
};

function makeStudioSnapshot(): WorkspaceStudioSnapshot {
  return {
    id: "switch2-diablo3",
    name: "Switch2 Diablo3",
    workspace: "/tmp/switch2-diablo3",
    config: {
      driver: "switch2",
      driverPackage: "file:/tmp/ludens-switch2-driver",
      port: 18765,
      model: "openai-codex/gpt-6.1-sol",
      serviceTier: "priority",
      effort: "high",
      seconds: 1800,
      requests: 1000,
      compactionThreshold: 48000,
      dashboard: true,
      pet: false,
      diagnostics: "normal",
    },
    defaults: {
      model: "openai-codex/gpt-6.1-sol",
      seconds: 1800,
      requests: 1000,
      dashboard: true,
      pet: false,
    },
    services: {
      hostSocket: "/tmp/switch2-diablo3/.ludens/host.sock",
      hostSocketExists: false,
      jobs: [
        {
          name: "baseware",
          scope: "workspace",
          target: "switch2-diablo3",
          registered: true,
          pid: null,
          state: "stopped",
          lastExitCode: 0,
          logPath: "/tmp/switch2-diablo3/.ludens/logs/baseware.log",
          logTail: [],
        },
        {
          name: "host",
          scope: "workspace",
          target: "switch2-diablo3",
          registered: true,
          pid: null,
          state: "stopped",
          lastExitCode: 0,
          logPath: "/tmp/switch2-diablo3/.ludens/logs/host.log",
          logTail: [],
        },
      ],
    },
    shiori: {
      model: "openai-codex/gpt-6.1-sol",
      currentSessionFile: ".ludens/shiori/sessions/session-1.jsonl",
      sessions: [],
      memory: {
        exists: true,
        path: "/tmp/switch2-diablo3/MEMORY.md",
        content: "# Memory\n",
        updatedAt: null,
      },
    },
  };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;");

test("SettingsView renders 4 flat left-rail categories, GlobalDefaults browse trigger, and omits old jump strip", () => {
  const defaultHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(SettingsView, { follow: MOCK_FOLLOW, projects: PROJECTS }),
    ),
  );

  assert.doesNotMatch(defaultHtml, /settings-jump-strip|data-settings-jump-nav/);
  assert.match(defaultHtml, /class="settings-workspace-nav"/);
  const navButtons = defaultHtml.match(/data-slot="settings-nav-item"/g) ?? [];
  assert.equal(navButtons.length, 4);
  for (const label of [
    en.settings.categories.general,
    en.settings.categories.defaults,
    en.settings.categories.transport,
    en.settings.categories.pet,
  ]) {
    assert.ok(defaultHtml.includes(escapeHtml(label)), `Expected category label "${label}" in SettingsView`);
  }

  const defaultsHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(SettingsView, {
        follow: MOCK_FOLLOW,
        projects: PROJECTS,
        initialCategory: "defaults",
      }),
    ),
  );
  assert.match(defaultsHtml, /data-browse-models="global-defaults"/);
  assert.doesNotMatch(defaultsHtml, /data-slot="card"/);
});

test("ConnectionSettings renders flat rows without scope dropdown or 3-column guide wall, and discloses CLI in workspace mode", () => {
  const globalHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ConnectionSettings, {
        projects: PROJECTS,
        initialScope: "global",
      }),
    ),
  );
  assert.doesNotMatch(globalHtml, /data-connection-guide/);
  assert.doesNotMatch(globalHtml, /data-slot="card"/);
  assert.ok(globalHtml.includes(en.connectionSettings.scopeLockedGlobal));
  assert.ok(!globalHtml.includes(en.connectionSettings.scopeLabel));
  assert.ok(!globalHtml.includes(en.connectionSettings.scopeGlobal));
  assert.equal((globalHtml.match(/<select\b/g) ?? []).length, 3);
  assert.doesNotMatch(globalHtml, /<details\b/);

  const workspaceHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ConnectionSettings, {
        projects: PROJECTS,
        initialScope: "switch2-diablo3",
      }),
    ),
  );
  assert.doesNotMatch(workspaceHtml, /data-connection-guide/);
  assert.doesNotMatch(workspaceHtml, /data-slot="card"/);
  assert.ok(workspaceHtml.includes(en.connectionSettings.scopeLockedWorkspace));
  assert.ok(!workspaceHtml.includes(en.connectionSettings.scopeLabel));
  assert.ok(!workspaceHtml.includes(en.connectionSettings.scopeGlobal));
  assert.equal((workspaceHtml.match(/<select\b/g) ?? []).length, 3);
  assert.match(workspaceHtml, /<details class="settings-disclosure"/);
  assert.ok(workspaceHtml.includes(escapeHtml(en.connectionSettings.advancedCliTitle)));
  assert.match(workspaceHtml, /data-connection-reload-command/);
});

test("WorkspaceStudioView renders all 6 categories including Target Device, keeps model picker trigger, and discloses Services diagnostics", () => {
  const studioHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(WorkspaceStudioView, {
        project: "switch2-diablo3",
        projects: PROJECTS,
        ready: true,
        onRetryCatalog() {},
        navigate() {},
      }),
    ),
  );

  assert.match(studioHtml, /class="settings-workspace-nav"/);
  const navButtons = studioHtml.match(/data-slot="settings-nav-item"/g) ?? [];
  assert.equal(navButtons.length, 6);
  for (const label of [
    en.workspaceStudio.tabs.device,
    en.workspaceStudio.tabs.model,
    en.workspaceStudio.tabs.connection,
    en.workspaceStudio.tabs.perception,
    en.workspaceStudio.tabs.services,
    en.workspaceStudio.tabs.simulator,
  ]) {
    assert.ok(studioHtml.includes(escapeHtml(label)), `Expected studio category "${label}"`);
  }
  assert.match(studioHtml, new RegExp(`aria-current="page"[^>]*>[\\s\\S]*?${en.workspaceStudio.tabs.device}`));
  assert.doesNotMatch(studioHtml, /data-slot="card"/);

  const snapshot = makeStudioSnapshot();
  const modelHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ModelAndBudgetPanel, {
        studio: snapshot,
        isZh: false,
        workspaceRunning: false,
        onSaved() {},
        onOpenDevice() {},
        onOpenSimulator() {},
        onOpenConnection() {},
      }),
    ),
  );
  assert.match(modelHtml, /data-browse-models="workspace-studio"/);
  assert.doesNotMatch(modelHtml, /data-slot="card"/);

  const servicesHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ServicesAndShioriPanel, {
        studio: snapshot,
        isZh: false,
        onRefresh() {},
        onOpenBaseware() {},
        onStudioUpdated() {},
        onShioriUpdated() {},
      }),
    ),
  );
  assert.match(servicesHtml, /<details class="settings-disclosure"/);
  assert.ok(servicesHtml.includes(escapeHtml(en.workspaceStudio.servicesSection.advancedDiagnostics)));
  assert.doesNotMatch(servicesHtml, /data-slot="card"/);
});
