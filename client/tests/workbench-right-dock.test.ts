import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clampWorkbenchDockWidth,
  WorkbenchRightDock,
  type UseWorkbenchRightDockResult,
} from "../components/workbench-right-dock";

function makeDockState(overrides: Partial<UseWorkbenchRightDockResult> = {}): UseWorkbenchRightDockResult {
  return {
    dockId: "dock-test-id",
    isOverlay: false,
    dockOpen: true,
    inlineOpen: true,
    drawerOpen: false,
    mainInert: false,
    resizing: false,
    resolvedWidthPx: 420,
    customWidthPx: null,
    isExpandedWidth: false,
    backdropPresence: { mounted: false, state: "closed" },
    toggleButtonRef: { current: null },
    openDock() {},
    closeDock() {},
    toggleDock() {},
    setCustomWidthPx() {},
    resetCustomWidth() {},
    toggleWidthPreset() {},
    handleResizeStart() {},
    ...overrides,
  };
}

test("clampWorkbenchDockWidth respects min dock width and preserves minimum main pane width", () => {
  assert.equal(clampWorkbenchDockWidth(200, 1280, 320, 360), 320);
  assert.equal(clampWorkbenchDockWidth(520, 1280, 320, 360), 520);
  assert.equal(clampWorkbenchDockWidth(1100, 1280, 320, 360), 920);
  assert.equal(clampWorkbenchDockWidth(500, 500, 320, 360), 320);
});

test("WorkbenchRightDock switches cleanly between inline resizable split column and <1100px dialog overlay drawer", () => {
  const inlineHtml = renderToStaticMarkup(
    createElement(
      WorkbenchRightDock,
      {
        dock: makeDockState({ isOverlay: false, dockOpen: true }),
        ariaLabel: "Inspector",
        resizeAriaLabel: "Resize panel",
      },
      createElement("div", { "data-body": "inline" }, "content"),
    ),
  );
  assert.match(inlineHtml, /data-workbench-dock=""/);
  assert.match(inlineHtml, /data-dock-state="open"/);
  assert.match(inlineHtml, /role="separator"/);
  assert.doesNotMatch(inlineHtml, /role="dialog"/);
  assert.doesNotMatch(inlineHtml, /data-dock-backdrop/);

  const overlayHtml = renderToStaticMarkup(
    createElement(
      WorkbenchRightDock,
      {
        dock: makeDockState({
          isOverlay: true,
          dockOpen: true,
          drawerOpen: true,
          mainInert: true,
          backdropPresence: { mounted: true, state: "open" },
        }),
        ariaLabel: "Inspector",
      },
      createElement("div", { "data-body": "overlay" }, "content"),
    ),
  );
  assert.match(overlayHtml, /data-dock-backdrop=""/);
  assert.match(overlayHtml, /role="dialog"/);
  assert.match(overlayHtml, /aria-modal="true"/);
  assert.match(overlayHtml, /data-overlay="true"/);
  assert.doesNotMatch(overlayHtml, /role="separator"/);
});

test("Unified workbench-right-dock.css and activity-feed.css prevent CSS Grid 0px-column drawer collapse under 1100px", () => {
  const dockCss = readFileSync(
    join(import.meta.dirname, "../components/workbench-right-dock.css"),
    "utf8",
  );
  const activityCss = readFileSync(
    join(import.meta.dirname, "../features/live/activity-feed.css"),
    "utf8",
  );

  // Critical regression guard: absolute overlay drawer must reset grid-area: auto and avoid 100vw
  assert.match(
    dockCss,
    /@media\s*\(max-width:\s*1099px\)[\s\S]*?\.workbench-right-dock:not\(\[data-immersive="true"\]\)\s*\{[^}]*grid-area:\s*auto;[^}]*position:\s*absolute;/,
  );
  assert.doesNotMatch(dockCss, /100vw/);
  assert.match(
    activityCss,
    /@media\s*\(max-width:\s*1099px\)[\s\S]*?\.codex-workbench\[data-dock-open\]:not\(\[data-immersive="true"\]\)\s*\{[^}]*grid-template-areas:\s*"chat"\s*"composer";/,
  );
});
