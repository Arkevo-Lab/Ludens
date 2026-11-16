import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionTargetDialog } from "../components/connection-target-dialog";
import { LocaleProvider } from "../lib/locale";
import { LudensRpcProvider } from "../lib/ludens-rpc";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

test("ConnectionTargetDialog uses native <dialog> without redundant ARIA attributes and respects modern-web-guidance", () => {
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(
        LudensRpcProvider,
        null,
        createElement(ConnectionTargetDialog, {
          open: true,
          onOpenChange: () => {},
        }),
      ),
    ),
  );

  assert.match(html, /<dialog\b/);
  assert.match(html, /class="connection-target-dialog"/);
  assert.match(html, /closedby="any"/);
  assert.match(html, /aria-labelledby="/);

  // Per modern-web-guidance dialog rules: never add role="dialog" or aria-modal onto native <dialog>
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal=/);

  // Remote URL input + password token input + visibility toggle + action buttons render cleanly
  assert.match(html, /type="password"/);
  assert.match(html, /inputMode="url"/i);
  assert.match(html, /type="submit"/);
});

test("ConnectionTargetDialog surfaces electron-local vs same-origin options based on environment capabilities", () => {
  const globalAny = globalThis as { window?: unknown; location?: unknown };
  const prevWindow = globalAny.window;
  const prevLocation = globalAny.location;

  try {
    const browserLoc = {
      protocol: "https:",
      host: "console.example.com",
      pathname: "/",
      search: "",
      hash: "",
    };
    globalAny.location = browserLoc;
    globalAny.window = {
      location: browserLoc,
      ludens: {
        rpc: {
          send: () => {},
          onMessage: () => () => {},
        },
      },
    };

    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(
          LudensRpcProvider,
          null,
          createElement(ConnectionTargetDialog, {
            open: true,
            onOpenChange: () => {},
          }),
        ),
      ),
    );

    assert.match(html, /value="electron-local"/);
    assert.match(html, /value="same-origin"/);
    assert.match(html, /value="remote"/);
    assert.match(html, /console\.example\.com/);
  } finally {
    globalAny.window = prevWindow;
    globalAny.location = prevLocation;
  }
});

test("app/globals.css preserves native <dialog> top-layer scroll containment and open-scoped display rules", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  assert.match(css, /dialog:modal\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(css, /dialog::backdrop\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*contain/s);
  assert.match(css, /dialog\.connection-target-dialog\[open\]\s*\{[^}]*display:\s*flex/s);
  assert.doesNotMatch(css, /\bdialog(?:\.connection-target-dialog)?\s*\{[^}]*\bdisplay\s*:/);
});
