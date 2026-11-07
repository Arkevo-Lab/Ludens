import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasewareView } from "../features/baseware/baseware-view";
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

test("BasewareView renders topology summary, workspace machine binding section, global machine pool, and relocated device controllers card", () => {
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
  assert.match(html, /data-baseware-summary/);
  assert.match(html, /data-baseware-section="workspace-binding"/);
  assert.match(html, /data-baseware-section="machine-pool"/);
  assert.match(html, /data-baseware-section="controllers-catalog"/);
  assert.match(html, /data-capability-source="device"/);
  assert.match(html, /data-baseware-preset="gba-mgba"/);
  assert.match(html, /data-baseware-preset="ssh-cua"/);
  assert.match(html, /data-baseware-preset="http-mcp"/);
});
