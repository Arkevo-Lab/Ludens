import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_TARGET_STORAGE_KEY,
  SAME_ORIGIN_TOKEN_SESSION_KEY,
  clearStoredConnectionTarget,
  consumeUrlHashBootstrap,
  loadStoredConnectionTarget,
  normalizeRemoteUrl,
  resolveConnectionEndpoints,
  resolveInitialConnectionTarget,
  saveConnectionTarget,
  type ConnectionEnv,
} from "../lib/connection-target";

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

test("normalizeRemoteUrl normalizes http(s), ws(s), bare hosts, and /rpc suffix while rejecting bad inputs", () => {
  assert.deepEqual(normalizeRemoteUrl("http://127.0.0.1:4000"), {
    ok: true,
    canonicalUrl: "http://127.0.0.1:4000",
    httpOrigin: "http://127.0.0.1:4000",
    wsUrl: "ws://127.0.0.1:4000/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("https://daemon.example.com/proxy/rpc/"), {
    ok: true,
    canonicalUrl: "https://daemon.example.com/proxy",
    httpOrigin: "https://daemon.example.com",
    wsUrl: "wss://daemon.example.com/proxy/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("wss://ludens.dev:8443/rpc"), {
    ok: true,
    canonicalUrl: "https://ludens.dev:8443",
    httpOrigin: "https://ludens.dev:8443",
    wsUrl: "wss://ludens.dev:8443/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("ws://localhost:3015/"), {
    ok: true,
    canonicalUrl: "http://localhost:3015",
    httpOrigin: "http://localhost:3015",
    wsUrl: "ws://localhost:3015/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("127.0.0.1:3100"), {
    ok: true,
    canonicalUrl: "http://127.0.0.1:3100",
    httpOrigin: "http://127.0.0.1:3100",
    wsUrl: "ws://127.0.0.1:3100/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("remote.ludens.example"), {
    ok: true,
    canonicalUrl: "https://remote.ludens.example",
    httpOrigin: "https://remote.ludens.example",
    wsUrl: "wss://remote.ludens.example/rpc",
  });

  assert.deepEqual(normalizeRemoteUrl("   "), { ok: false, error: "empty" });
  assert.deepEqual(normalizeRemoteUrl("ftp://files.example"), {
    ok: false,
    error: "unsupported-protocol",
  });
  assert.deepEqual(normalizeRemoteUrl("javascript:alert(1)"), {
    ok: false,
    error: "unsupported-protocol",
  });
  assert.deepEqual(normalizeRemoteUrl("http://"), { ok: false, error: "invalid-url" });
});

test("consumeUrlHashBootstrap extracts #token= and #remote= and immediately scrubs location.hash via history.replaceState", () => {
  const replaceCalls: Array<{ state: unknown; title: string; url?: string | URL | null }> = [];
  const location = {
    protocol: "https:",
    host: "console.example.com",
    pathname: "/console",
    search: "?view=live&project=demo",
    hash: "#token=secret-abc&remote=https%3A%2F%2Fedge.example%3A9443",
  };
  const history = {
    replaceState(state: unknown, title: string, url?: string | URL | null) {
      replaceCalls.push({ state, title, url });
      location.hash = "";
    },
  };

  const result = consumeUrlHashBootstrap({ location, history });
  assert.deepEqual(result, {
    token: "secret-abc",
    remote: "https://edge.example:9443",
    scrubbed: true,
  });
  assert.equal(replaceCalls.length, 1);
  assert.equal(replaceCalls[0].url, "/console?view=live&project=demo");
  assert.equal(location.hash, "");

  // Non-bootstrap fragments stay untouched.
  const untouchedCalls: number[] = [];
  const nonBootstrap = consumeUrlHashBootstrap({
    location: { ...location, hash: "#section-architecture" },
    history: {
      replaceState() {
        untouchedCalls.push(1);
      },
    },
  });
  assert.deepEqual(nonBootstrap, { scrubbed: false });
  assert.equal(untouchedCalls.length, 0);
});

test("save/load/clear ConnectionTarget stores remote in localStorage and keeps same-origin tokens out of localStorage", () => {
  const localStorage = makeMemoryStorage();
  const sessionStorage = makeMemoryStorage();
  const env: ConnectionEnv = {
    hasDesktopRpc: false,
    localStorage,
    sessionStorage,
  };

  saveConnectionTarget({ kind: "remote", url: "http://127.0.0.1:4100/rpc", token: "tok-1" }, env);
  assert.deepEqual(loadStoredConnectionTarget(env), {
    kind: "remote",
    url: "http://127.0.0.1:4100",
    token: "tok-1",
  });
  assert.match(localStorage.getItem(CONNECTION_TARGET_STORAGE_KEY) ?? "", /http:\/\/127\.0\.0\.1:4100/);

  saveConnectionTarget({ kind: "same-origin", token: "sess-tok" }, env);
  assert.equal(localStorage.getItem(CONNECTION_TARGET_STORAGE_KEY), JSON.stringify({ kind: "same-origin" }));
  assert.equal(sessionStorage.getItem(SAME_ORIGIN_TOKEN_SESSION_KEY), "sess-tok");
  assert.deepEqual(loadStoredConnectionTarget(env), {
    kind: "same-origin",
    token: "sess-tok",
  });

  clearStoredConnectionTarget(env);
  assert.equal(loadStoredConnectionTarget(env), null);
  assert.equal(localStorage.getItem(CONNECTION_TARGET_STORAGE_KEY), null);
  assert.equal(sessionStorage.getItem(SAME_ORIGIN_TOKEN_SESSION_KEY), null);

  localStorage.setItem(CONNECTION_TARGET_STORAGE_KEY, "{not-json");
  assert.equal(loadStoredConnectionTarget(env), null);
});

test("resolveInitialConnectionTarget and resolveConnectionEndpoints handle desktop, same-origin, remote, and unconfigured states", () => {
  const localStorage = makeMemoryStorage();
  const sessionStorage = makeMemoryStorage();
  const desktopInitial = resolveInitialConnectionTarget({
    hasDesktopRpc: true,
    location: { protocol: "ludens-app:", host: "console", pathname: "/", search: "", hash: "" },
    localStorage,
    sessionStorage,
  });
  assert.deepEqual(desktopInitial, {
    target: { kind: "electron-local" },
    hashBootstrapped: false,
  });
  assert.deepEqual(
    resolveConnectionEndpoints(desktopInitial.target, { hasDesktopRpc: true }),
    {
      ok: true,
      kind: "electron-local",
      transport: "ipc",
      mediaBaseUrl: "ludens-media://local",
      displayTarget: "Desktop IPC",
    },
  );
  assert.equal(
    resolveConnectionEndpoints({ kind: "electron-local" }, { hasDesktopRpc: false }).ok,
    false,
  );

  // Browser hash token bootstrap on same-origin scrubs hash and populates WS token
  const replaceUrls: unknown[] = [];
  const browserLoc = {
    protocol: "https:",
    host: "ludens.local:8443",
    pathname: "/",
    search: "",
    hash: "#token=boot-tok",
  };
  const browserInitial = resolveInitialConnectionTarget({
    hasDesktopRpc: false,
    location: browserLoc,
    history: {
      replaceState: (_s, _t, u) => {
        replaceUrls.push(u);
        browserLoc.hash = "";
      },
    },
    localStorage: makeMemoryStorage(),
    sessionStorage,
  });
  assert.deepEqual(browserInitial, {
    target: { kind: "same-origin", token: "boot-tok" },
    hashBootstrapped: true,
  });
  assert.deepEqual(replaceUrls, ["/"]);
  assert.deepEqual(
    resolveConnectionEndpoints(browserInitial.target, { location: browserLoc }),
    {
      ok: true,
      kind: "same-origin",
      transport: "ws",
      wsUrl: "wss://ludens.local:8443/rpc",
      httpOrigin: "https://ludens.local:8443",
      mediaBaseUrl: "https://ludens.local:8443",
      token: "boot-tok",
      displayTarget: "ludens.local:8443",
    },
  );

  // Standalone file:// origin with no stored remote is clearly reported as unconfigured
  const unconfiguredInitial = resolveInitialConnectionTarget({
    hasDesktopRpc: false,
    location: { protocol: "file:", host: "", pathname: "/index.html", search: "", hash: "" },
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
  });
  assert.deepEqual(unconfiguredInitial, {
    target: { kind: "remote", url: "" },
    hashBootstrapped: false,
  });
  assert.deepEqual(resolveConnectionEndpoints(unconfiguredInitial.target), {
    ok: false,
    kind: "remote",
    error: "unconfigured",
    displayTarget: "Remote",
  });
});
