import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { driverCreationHref } from "../lib/driver-onboarding";
import { isPlainNavigationClick } from "../lib/dashboard-navigation";
import { CapabilitiesView } from "../features/capabilities/capabilities-view";

test("driver handoff URLs preserve the package literally but never transmit trusted metadata", () => {
  for (const spec of ["github:org/repo#rev", "file:/tmp/a driver's folder/$(echo x)&verified=true&driver=cua.ts"]) {
    const url = new URL(driverCreationHref(spec), "http://localhost");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("view"), "workspaces");
    assert.equal(url.searchParams.get("create"), "1");
    assert.equal(url.searchParams.get("driverPackage"), spec);
    assert.deepEqual([...url.searchParams.keys()], ["view", "create", "driverPackage"]);
  }
});

test("only unmodified primary activation is intercepted for an in-memory handoff", () => {
  const event = { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(isPlainNavigationClick(event), true);
  for (const patch of [{ button: 1 }, { button: 2 }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }])
    assert.equal(isPlainNavigationClick({ ...event, ...patch }), false);
});

test("capabilities overview stays available without a usable workspace catalog", () => {
  const html = renderToStaticMarkup(createElement(CapabilitiesView, { project: "", ready: true, workspace: null,
    onRetryCatalog() {}, onNavigate() {} }));
  assert.match(html, /aria-label="capabilitiesView\.overviewLabel"/);
  assert.match(html, /view=workspaces&amp;create=1/);
  assert.match(html, /view=workspaces"/);
  assert.doesNotMatch(html, /data-capability-runtime/);
  const connected = renderToStaticMarkup(createElement(CapabilitiesView, { project: "my workspace", workspace: "/tmp/my-ws", ready: true,
    onRetryCatalog() {}, onNavigate() {} }));
  assert.match(connected, /data-capability-runtime/);
});
