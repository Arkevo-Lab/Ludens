import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectionEnv, ConnectionTarget } from "../lib/connection-target";
import { createMediaResolver, resolveMediaUrl } from "../lib/media-resolver";

const browserEnv: ConnectionEnv = {
  hasDesktopRpc: false,
  location: {
    protocol: "https:",
    host: "console.ludens.dev",
    pathname: "/",
    search: "",
    hash: "",
  },
};

const desktopEnv: ConnectionEnv = {
  hasDesktopRpc: true,
  location: {
    protocol: "ludens-app:",
    host: "console",
    pathname: "/",
    search: "",
    hash: "",
  },
};

test("resolveMediaUrl maps relative /media paths and logical MediaResolveParams to ludens-media://local in electron-local mode without mt=", () => {
  const target: ConnectionTarget = { kind: "electron-local" };

  assert.equal(
    resolveMediaUrl("/media?kind=replay&project=demo&run=run-1&call=7&media=0", target, "ignored-ticket", desktopEnv),
    "ludens-media://local/media?kind=replay&project=demo&run=run-1&call=7&media=0",
  );

  assert.equal(
    resolveMediaUrl(
      { kind: "asset", project: "demo", run: "run-1", id: "obs/1 a" },
      target,
      "ignored-ticket",
      desktopEnv,
    ),
    "ludens-media://local/media?kind=asset&project=demo&run=run-1&id=obs%2F1+a",
  );

  assert.equal(
    resolveMediaUrl(
      { kind: "replay", project: "demo", run: "run-1", mode: "media", record: "rec-1", sequence: 7, media: 0, asset: "a-0" },
      target,
      undefined,
      desktopEnv,
    ),
    "ludens-media://local/media?kind=replay&project=demo&run=run-1&mode=media&record=rec-1&sequence=7&media=0&asset=a-0",
  );
});

test("resolveMediaUrl resolves remote and same-origin media against mediaBaseUrl with URL-encoded media ticket", () => {
  const remoteTarget: ConnectionTarget = { kind: "remote", url: "https://daemon.local:8443/prefix", token: "auth" };
  const resolver = createMediaResolver(remoteTarget, "tk+1/a=", browserEnv);

  assert.equal(
    resolver.resolve("/media?kind=replay&project=demo&run=run-1&call=4"),
    "https://daemon.local:8443/prefix/media?kind=replay&project=demo&run=run-1&call=4&mt=tk%2B1%2Fa%3D",
  );

  // Does not duplicate mt= when already provided on the relative path.
  assert.equal(
    resolver.resolve("/media?kind=asset&id=1&mt=existing"),
    "https://daemon.local:8443/prefix/media?kind=asset&id=1&mt=existing",
  );

  const sameOriginResolver = createMediaResolver({ kind: "same-origin" }, "same-tk", browserEnv);
  assert.equal(
    sameOriginResolver.resolve({ kind: "asset", project: "p", run: "r", id: "img-1" }),
    "https://console.ludens.dev/media?kind=asset&project=p&run=r&id=img-1&mt=same-tk",
  );
});

test("resolveMediaUrl preserves safe absolute/data/blob URLs and rejects unsafe or legacy paths", () => {
  const target: ConnectionTarget = { kind: "same-origin" };

  assert.equal(resolveMediaUrl("data:image/png;base64,iVBORw0=", target, "tk", browserEnv), "data:image/png;base64,iVBORw0=");
  assert.equal(resolveMediaUrl("blob:https://console.ludens.dev/1234", target, "tk", browserEnv), "blob:https://console.ludens.dev/1234");
  assert.equal(
    resolveMediaUrl("ludens-media://local/media?kind=asset&id=1", { kind: "electron-local" }, undefined, desktopEnv),
    "ludens-media://local/media?kind=asset&id=1",
  );
  assert.equal(resolveMediaUrl("https://cdn.example/frame.webp", target, "tk", browserEnv), "https://cdn.example/frame.webp");

  assert.equal(resolveMediaUrl("javascript:alert(1)", target, "tk", browserEnv), undefined);
  assert.equal(resolveMediaUrl("//evil.example/payload.png", target, "tk", browserEnv), undefined);
  assert.equal(resolveMediaUrl("/api/media?id=legacy", target, "tk", browserEnv), undefined);
  assert.equal(resolveMediaUrl("", target, "tk", browserEnv), undefined);
  assert.equal(resolveMediaUrl(null, target, "tk", browserEnv), undefined);

  // Returns undefined cleanly when endpoints are unconfigured or same-origin lacks HTTP origin
  assert.equal(
    resolveMediaUrl("/media?kind=asset&id=1", { kind: "remote", url: "" }, "tk", browserEnv),
    undefined,
  );
  assert.equal(
    resolveMediaUrl("/media?kind=asset&id=1", { kind: "same-origin" }, "tk", desktopEnv),
    undefined,
  );
});
