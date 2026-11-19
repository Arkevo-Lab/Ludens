import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PixelMark, pixelMarkStates } from "../components/ui/pixel-mark";

const count = (html: string, cls: string) => html.split(`class="${cls}"`).length - 1;

test("PixelMark at rest draws the ring as one outline, the 5-cell hollow L and one loose pixel", () => {
  const html = renderToStaticMarkup(createElement(PixelMark));
  assert.equal(count(html, "pm-c"), 1);
  assert.match(html, /<path class="pm-c"/);
  assert.equal(count(html, "pm-h"), 5);
  assert.equal(count(html, "pm-p"), 1);
  assert.match(html, /data-state="idle"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /data-loading|data-filled|data-assemble|role="img"/);
});

test("PixelMark exposes every state and motion flag as attributes for the stylesheet", () => {
  for (const state of pixelMarkStates) {
    assert.match(renderToStaticMarkup(createElement(PixelMark, { state })), new RegExp(`data-state="${state}"`));
  }
  const html = renderToStaticMarkup(createElement(PixelMark, { loading: true, filled: true, assemble: true, size: 48, className: "x" }));
  assert.equal(count(html, "pm-c"), 13, "moving marks split the ring into its 13 cells");
  assert.match(html, /data-loading="true"/);
  assert.match(html, /data-filled="true"/);
  assert.match(html, /data-assemble="true"/);
  assert.match(html, /width="48" height="48"/);
  assert.match(html, /class="pixel-mark x"/);
});

test("PixelMark is named only when given a label", () => {
  const html = renderToStaticMarkup(createElement(PixelMark, { label: "Ludens" }));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Ludens"/);
  assert.doesNotMatch(html, /aria-hidden/);
});
