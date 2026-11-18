import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LocaleProvider } from "../lib/locale";
import { WorkspaceCreateForm } from "../features/workspaces/workspace-create-form";
import { WorkspacePicker } from "../features/workspaces/workspace-picker";
import { DesktopQuickSwitcher, filterQuickSwitcherItems } from "../shell/desktop-quick-switcher";

function renderWithProvider(node: ReactNode): string {
  return renderToStaticMarkup(createElement(LocaleProvider, null, node));
}

test("zh.json and en.json keep exact key parity across onboarding namespaces", () => {
  for (const ns of [
    "workspaceSetup",
    "workspaceLibrary",
    "workspacePicker",
    "workspaceRunEmpty",
    "shioriCockpit",
    "desktopChrome",
  ] as const) {
    assert.deepEqual(
      Object.keys(zh[ns]).sort(),
      Object.keys(en[ns]).sort(),
      `i18n key parity mismatch in namespace ${ns}`,
    );
  }
});

test("WorkspaceCreateForm renders 3-mode target selector, model readiness row, and dual Create / Create & Launch CTAs", () => {
  const html = renderWithProvider(
    createElement(WorkspaceCreateForm, {
      defaultRoot: "/Users/demo/.ludens/workspaces",
      globalDefaults: {
        model: "openai-codex/gpt-6.1-sol",
        effort: "medium",
      },
      existingWorkspaces: [],
      pending: false,
      error: "",
      onSubmit() {},
      onCancel() {},
    }),
  );

  assert.match(html, /data-target-mode="machine"/);
  assert.match(html, /data-target-mode="driver"/);
  assert.match(html, /data-target-mode="package"/);
  assert.match(html, /data-machine-card="local-desktop"/);
  assert.match(html, /gpt-6\.1-sol/);
  assert.match(html, /Create only/);
  assert.match(html, /Create &amp; launch into Live/);
});

test("WorkspaceCreateForm renders post-create launch recovery card when service startup needs user attention", () => {
  const html = renderWithProvider(
    createElement(WorkspaceCreateForm, {
      defaultRoot: "/Users/demo/.ludens/workspaces",
      pending: false,
      error: "",
      launchRecovery: {
        entry: {
          id: "ws-gba",
          name: "gba-leafgreen",
          workspace: "/Users/demo/.ludens/workspaces/gba-leafgreen",
          updatedAt: "2026-11-18T00:00:00.000Z",
        },
        error: "ECONNREFUSED 127.0.0.1:47653",
      },
      onSubmit() {},
      onRetryLaunch() {},
      onEnterExistingWorkspace() {},
      onConfigureWorkspace() {},
      onCancel() {},
    }),
  );

  assert.match(html, /data-testid="workspace-launch-recovery"/);
  assert.match(html, /gba-leafgreen/);
  assert.match(html, /ECONNREFUSED 127\.0\.0\.1:47653/);
  assert.match(html, /Retry launch &amp; enter/);
  assert.match(html, /Enter Live \(standby\)/);
});

test("WorkspacePicker remains interactive when projects list is empty if create/manage footer actions are wired", () => {
  const html = renderWithProvider(
    createElement(WorkspacePicker, {
      variant: "sidebar",
      projects: [],
      value: "",
      onChange() {},
      onCreateWorkspace() {},
      onManageWorkspaces() {},
    }),
  );

  assert.doesNotMatch(html, /aria-disabled="true"/);
});

test("DesktopQuickSwitcher includes Create New Workspace action and matches Chinese & English search queries", () => {
  const html = renderWithProvider(
    createElement(DesktopQuickSwitcher, {
      open: true,
      onOpenChange() {},
      platform: "darwin",
      projects: [],
      currentProject: "",
      currentView: "live",
      viewLink: v => `/?view=${v}`,
      onNavigate() {},
      onSelectWorkspace() {},
      sidebarCollapsed: false,
      onToggleSidebar() {},
      canGoBack: false,
      canGoForward: false,
      onGoBack() {},
      onGoForward() {},
      onReload() {},
    }),
  );

  assert.match(html, /data-qs-item="action:create-workspace"/);
  assert.match(html, /Create New Workspace/);
  assert.match(html, /data-qs-item="action:connection-target"/);
  assert.match(html, /Switch Connection Target \/ Remote Server/);

  const matched = filterQuickSwitcherItems(
    [
      {
        id: "action:create-workspace",
        group: "actions",
        title: zh.desktopChrome.actionCreateWorkspace,
        subtitle: zh.desktopChrome.actionCreateWorkspaceSubtitle,
        keywords: "new create workspace project init 新建 工作区 项目",
        icon: "plus",
        onSelect() {},
      },
    ],
    "新建 项目",
  );
  assert.equal(matched.length, 1);
});
