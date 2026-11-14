import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  prefersReducedMotion,
  prefersSmoothScrollBehavior,
  useAnimatedNativeDialog,
  useAnimatedPresence,
} from "../components/use-motion-preferences";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function readAppFile(relativePath: string): string {
  return readFileSync(join(appDir, relativePath), "utf8");
}

function PresenceHarness({ open }: { open: boolean }) {
  const presence = useAnimatedPresence(open);
  return createElement("div", {
    "data-mounted": String(presence.mounted),
    "data-state": presence.state,
  });
}

function DialogPayloadHarness({ payload }: { payload: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const retained = useAnimatedNativeDialog(ref, payload);
  return createElement("dialog", {
    ref,
    "data-payload": retained ?? "none",
  });
}

test("motion preference helpers are SSR-safe and preserve initial states", () => {
  assert.equal(prefersReducedMotion(), false);
  assert.equal(prefersSmoothScrollBehavior(), "smooth");

  const openHtml = renderToStaticMarkup(createElement(PresenceHarness, { open: true }));
  assert.match(openHtml, /data-mounted="true"/);
  assert.match(openHtml, /data-state="open"/);

  const closedHtml = renderToStaticMarkup(createElement(PresenceHarness, { open: false }));
  assert.match(closedHtml, /data-mounted="false"/);
  assert.match(closedHtml, /data-state="closed"/);

  const activeDialogHtml = renderToStaticMarkup(createElement(DialogPayloadHarness, { payload: "item-1" }));
  assert.match(activeDialogHtml, /data-payload="item-1"/);

  const emptyDialogHtml = renderToStaticMarkup(createElement(DialogPayloadHarness, { payload: null }));
  assert.match(emptyDialogHtml, /data-payload="none"/);
});

test("globals.css defines unified motion tokens and surgical reduced-motion overrides", () => {
  const css = readAppFile("app/globals.css");

  assert.match(css, /--ease-out-expo:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
  assert.match(css, /--duration-fast:\s*140ms/);
  assert.match(css, /--duration-mode:\s*300ms/);

  const reducedIndex = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.notEqual(reducedIndex, -1, "Expected @media (prefers-reduced-motion: reduce) block in globals.css");
  const reducedBlock = css.slice(reducedIndex);

  assert.match(reducedBlock, /--duration-fast:\s*0\.01ms;/);
  assert.match(reducedBlock, /scroll-behavior:\s*auto\s*!important;/);
  assert.doesNotMatch(
    reducedBlock,
    /\*\s*\{[^}]*transition:\s*none\s*!important[^}]*animation:\s*none\s*!important/s,
    "Reduced-motion overrides should target specific selectors rather than nuking all styles with *",
  );
});

test("native <dialog> styles use @starting-style, allow-discrete, and [data-closing='true']", () => {
  const contentionCss = readAppFile("components/device-contention-dialog.css");
  assert.match(contentionCss, /@starting-style/);
  assert.match(contentionCss, /transition-behavior:\s*allow-discrete;/);
  assert.match(contentionCss, /\[open\]\[data-closing="true"\]/);

  const basewareCss = readAppFile("features/baseware/baseware-view.css");
  assert.match(basewareCss, /@starting-style/);
  assert.match(basewareCss, /transition-behavior:\s*allow-discrete;/);
  assert.match(basewareCss, /\[data-closing="true"\]/);
  assert.match(basewareCss, /\.baseware-drawer[\s\S]*?translateX\(100%\)/);
  assert.match(basewareCss, /\.baseware-drawer\[open\][\s\S]*?translateX\(0\)/);
});

test("ReplayCursor positions via compositor cqi transform with container-type: inline-size", () => {
  const timelineCss = readAppFile("features/replay/timeline-player.css");
  assert.match(timelineCss, /\.replay-time-axis-track\s*\{[\s\S]*?container-type:\s*inline-size;/);
  assert.match(timelineCss, /\.replay-track-lane\s*\{[\s\S]*?container-type:\s*inline-size;/);

  const timelineTsx = readAppFile("features/replay/timeline-player.tsx");
  const cursorMatch = timelineTsx.match(/function ReplayCursor\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(cursorMatch, "Expected ReplayCursor component in timeline-player.tsx");
  assert.match(cursorMatch[0], /translateX\(\$\{pct\}cqi\)/);
  assert.doesNotMatch(cursorMatch[0], /\bleft:/);
});

test("Companion Pet keeps #body.pressed squish transform and defers .activity bubble cleanup", () => {
  const petCss = readAppFile("public/companion/pet.css");
  assert.match(petCss, /#body\.pressed\s*\{\s*transform:\s*scale\(1\.04,\s*\.94\);?\s*\}/);

  const petJs = readAppFile("public/companion/pet.js");
  assert.match(petJs, /activityClassTimer\s*=\s*setTimeout\(/);
  assert.match(petJs, /bubble\.classList\.remove\('open'\)/);
  assert.match(petJs, /bubble\.classList\.remove\('activity'\)/);
});
