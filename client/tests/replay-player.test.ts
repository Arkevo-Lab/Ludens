import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../lib/locale";
import type { ReplayOverview } from "@ludens/protocol/replay-types";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const SAMPLE_OVERVIEW: ReplayOverview = {
  project: "ws-demo",
  run: "run-001",
  epoch: "epoch-1",
  cycles: [{ epoch: "epoch-1", startedAt: "2026-11-11T12:00:00.000Z" }],
  startAt: 1_700_000_000_000,
  endAt: 1_700_000_120_000,
  capabilities: ["switch2:Perception.sample", "switch2:Audio.probe"],
  coverage: { bytes: 820, totalBytes: 1000, complete: false },
};

test("replayRulerRatios adapts between 3 ticks on narrow lanes (<420px) and 5 ticks on wider lanes", async () => {
  const { replayRulerRatios } = await import("../features/replay/timeline-player");
  assert.deepEqual(replayRulerRatios(0), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(replayRulerRatios(420), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(replayRulerRatios(760), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(replayRulerRatios(419), [0, 0.5, 1]);
  assert.deepEqual(replayRulerRatios(320), [0, 0.5, 1]);
});

test("TimelinePlayer delegates controls to unified TopbarSlot, keeps 2-band ruler, and removes redundant studio topbar & inspector close button", async () => {
  const { TimelinePlayer } = await import("../features/replay/timeline-player");

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(TimelinePlayer, {
        project: "ws-demo",
        run: "run-001",
        epoch: "epoch-1",
        initialOverview: SAMPLE_OVERVIEW,
        runPicker: createElement("div", { "data-test-run-picker": "true" }, "Latest run"),
        onPosition() {},
        onEvidence() {},
      }),
    ),
  );

  // Secondary studio topbar and duplicate close button are removed in favor of unified single-row topbar
  assert.doesNotMatch(html, /replay-studio-topbar/);
  assert.doesNotMatch(html, /replay-readonly-pill/);
  assert.doesNotMatch(html, /replay-inspector-close/);

  // Two-band non-overlapping time ruler: upper .replay-ruler-tick + lower .replay-time-axis-track with hairlines & cap
  assert.match(html, /class="replay-time-axis"/);
  assert.match(html, /class="replay-ruler-tick mono"/);
  assert.match(html, /class="replay-time-axis-track"/);
  assert.match(html, /class="replay-ruler-hairline"/);
  assert.match(html, /class="replay-playhead-cap"/);

  // Right inspector dock header + 2-row compact ReplayEventSearch
  assert.match(html, /replay-inspector-header/);
  assert.match(html, /replay-inspector-tablist[^"]*h-\[46px\]/);
  assert.match(html, /replay-search-row-top/);
  assert.match(html, /replay-search-row-bottom/);
  assert.match(html, /replay-track-pills/);
});

test("TimelinePlayer renders clean preparing state without duplicate studio topbar", async () => {
  const { TimelinePlayer } = await import("../features/replay/timeline-player");

  const preparingHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(TimelinePlayer, {
        project: "ws-demo",
        run: "run-001",
        runPicker: createElement("div", { "data-run-slot": "1" }),
        onPosition() {},
        onEvidence() {},
      }),
    ),
  );
  assert.doesNotMatch(preparingHtml, /replay-studio-topbar/);
  assert.match(preparingHtml, /empty-state/);
});

test("ReplayTimeJump and timeline-player.css enforce full-width stretch, unclipped frame-meta actions, lifted 42dvh cap, and <1100px overlay drawer", async () => {
  const { ReplayTimeJump } = await import("../features/replay/replay-time-jump");
  const jumpHtml = renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(ReplayTimeJump, { elapsed: 23_400, duration: 120_000, onJump() {} })),
  );
  assert.match(jumpHtml, /replay-timecode-group/);
  assert.match(jumpHtml, /replay-timecode-trigger/);
  assert.match(jumpHtml, /aria-expanded="false"/);

  const css = readFileSync(
    join(import.meta.dirname, "../features/replay/timeline-player.css"),
    "utf8",
  );

  // 1. Full-width flex stretch on .page-content.replay-page (reclaiming 284px dead gutters)
  assert.match(css, /\.console-main:has\(\.replay-page\)\s+\.page-content\.replay-page[\s\S]*?width:\s*100%/);
  assert.match(css, /\.console-main:has\(\.replay-page\)\s+\.page-content\.replay-page[\s\S]*?margin:\s*0/);
  assert.match(css, /\.console-main:has\(\.replay-page\)\s+\.page-content\.replay-page[\s\S]*?max-width:\s*none/);

  // 2. Single 46px non-wrapping .replay-studio-topbar (no phantom wrapped border)
  assert.match(css, /\.replay-studio-topbar\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.replay-studio-topbar\s*\{[^}]*height:\s*46px/);
  assert.match(css, /\.replay-studio-topbar\s*\{[^}]*min-height:\s*46px/);
  assert.match(css, /\.replay-studio-topbar\s*\{[^}]*overflow:\s*hidden/);

  // 3. Unclipped frame inspect + preview jump actions & lifted 42dvh video cap
  assert.match(css, /\.replay-frame-inspect-btn\s*\{[^}]*flex:\s*1 1 0%/);
  assert.match(css, /\.replay-frame-inspect-btn\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.replay-frame-inspect-btn\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.replay-preview-actions\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.replay-preview-actions\s*\{[^}]*white-space:\s*nowrap/);
  assert.doesNotMatch(css, /42dvh/);

  // 4. Condensed 30px timeline header & 24px two-band ruler
  assert.match(css, /\.replay-timeline-header\s*\{[^}]*height:\s*30px/);
  assert.match(css, /\.replay-time-axis\s*\{[^}]*height:\s*24px/);
  assert.match(css, /\.replay-ruler-tick\s*\{[^}]*top:\s*1px/);
  assert.match(css, /\.replay-time-axis-track\s*\{[^}]*bottom:\s*0;\s*height:\s*8px/);

  // 5. Inline dock at >=1100px + right-side overlay drawer at <1100px + single-line scrollable track pills
  assert.match(css, /@media\s*\(max-width:\s*1099px\)/);
  assert.match(css, /\.replay-track-pills\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.replay-track-pills\s*\{[^}]*overflow-x:\s*auto/);
});
