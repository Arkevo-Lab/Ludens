import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  buildLoopbackTrustedOrigins,
  buildManagedAppServerArgs,
  parseDevArgs,
  resolveDevHome,
} from "../scripts/dev.mjs";
import {
  buildProductionStartArgs,
  buildServerSpawn,
  resolveLudensServerCommand,
} from "../scripts/production.mjs";

test("resolveDevHome defaults to isolated ~/.ludens-dev when no home overrides are set", () => {
  const fakeHome = "/Users/alice";
  assert.equal(resolveDevHome({}, {}, fakeHome), resolve(fakeHome, ".ludens-dev"));
  assert.equal(resolveDevHome({}, { LUDENS_HOME: "   " }, fakeHome), resolve(fakeHome, ".ludens-dev"));
});

test("resolveDevHome follows precedence: --home > --real-home > LUDENS_HOME > ~/.ludens-dev", () => {
  const fakeHome = "/Users/alice";
  const envWithHome = { LUDENS_HOME: "/var/tmp/env-ludens-home" };

  assert.equal(resolveDevHome({}, envWithHome, fakeHome), resolve("/var/tmp/env-ludens-home"));
  assert.equal(
    resolveDevHome({ realHome: true }, envWithHome, fakeHome),
    resolve(fakeHome, ".ludens"),
  );
  assert.equal(
    resolveDevHome({ home: "/custom/dir", realHome: true }, envWithHome, fakeHome),
    resolve("/custom/dir"),
  );
});

test("parseDevArgs supports isolated default, --real-home, --home, LUDENS_HOME, and --desktop", () => {
  const fakeHome = "/Users/bob";

  const isolated = parseDevArgs([], {}, fakeHome);
  assert.equal(isolated.port, "3015");
  assert.equal(isolated.hostname, "127.0.0.1");
  assert.equal(isolated.ludensHome, resolve(fakeHome, ".ludens-dev"));
  assert.equal(isolated.realHome, false);
  assert.equal(isolated.home, undefined);
  assert.equal(isolated.desktop, false);
  assert.deepEqual(isolated.rest, []);

  const fromEnv = parseDevArgs(["--port=3099"], { LUDENS_HOME: "/tmp/harness-home" }, fakeHome);
  assert.equal(fromEnv.port, "3099");
  assert.equal(fromEnv.ludensHome, resolve("/tmp/harness-home"));
  assert.equal(fromEnv.realHome, false);

  const realHome = parseDevArgs(["--real-home", "--desktop"], { LUDENS_HOME: "/tmp/ignored" }, fakeHome);
  assert.equal(realHome.ludensHome, resolve(fakeHome, ".ludens"));
  assert.equal(realHome.realHome, true);
  assert.equal(realHome.desktop, true);
  assert.deepEqual(realHome.rest, []);

  const customSpace = parseDevArgs(["--home", "/custom/dir", "--clearScreen", "false"], {}, fakeHome);
  assert.equal(customSpace.ludensHome, resolve("/custom/dir"));
  assert.equal(customSpace.home, "/custom/dir");
  assert.deepEqual(customSpace.rest, ["--clearScreen", "false"]);

  const customEquals = parseDevArgs(["--home=/another/dir"], {}, fakeHome);
  assert.equal(customEquals.ludensHome, resolve("/another/dir"));
  assert.equal(customEquals.home, "/another/dir");
});

test("parseDevArgs enforces loopback-only hostnames and rejects invalid ports or empty --home", () => {
  const fakeHome = "/Users/bob";

  assert.equal(parseDevArgs(["--hostname", "localhost"], {}, fakeHome).hostname, "localhost");
  assert.equal(parseDevArgs(["--hostname", "[::1]"], {}, fakeHome).hostname, "::1");
  assert.deepEqual(buildLoopbackTrustedOrigins("3015", "::1"), [
    "http://[::1]:3015",
    "http://127.0.0.1:3015",
    "http://localhost:3015",
  ]);

  assert.throws(
    () => parseDevArgs(["--hostname", "0.0.0.0"], {}, fakeHome),
    /Refusing non-loopback dev hostname/,
  );
  assert.throws(
    () => parseDevArgs(["-H", "192.168.1.25"], {}, fakeHome),
    /Refusing non-loopback dev hostname/,
  );
  assert.throws(() => parseDevArgs(["--port", "0"], {}, fakeHome), /Invalid dev port/);
  assert.throws(() => parseDevArgs(["--home"], {}, fakeHome), /Missing value for --home/);
  assert.throws(() => parseDevArgs(["--home=   "], {}, fakeHome), /Missing value for --home/);
});

test("buildManagedAppServerArgs passes serve --dev --listen ws://127.0.0.1:0 --parent-watchdog without legacy --port", () => {
  const args = buildManagedAppServerArgs(
    [
      "http://127.0.0.1:3015",
      "http://localhost:3015",
    ],
    ["/repo/server/src/cli/main.ts"],
  );
  assert.deepEqual(args, [
    "/repo/server/src/cli/main.ts",
    "serve",
    "--dev",
    "--listen",
    "ws://127.0.0.1:0",
    "--parent-watchdog",
    "--trusted-origin",
    "http://127.0.0.1:3015",
    "--trusted-origin",
    "http://localhost:3015",
  ]);
  assert.equal(args.includes("--port"), false);
});

test("buildProductionStartArgs passes --dev on tokenless loopback and --auth token when LUDENS_APP_TOKEN is set", () => {
  const emptyEnv = { NODE_ENV: "test" as const };
  assert.deepEqual(buildProductionStartArgs([], emptyEnv, "/repo/app"), [
    "--listen",
    "ws://127.0.0.1:3015",
    "--dev",
    "--static-dir",
    resolve("/repo/app", "out"),
  ]);

  assert.deepEqual(
    buildProductionStartArgs([], { NODE_ENV: "test" as const, LUDENS_APP_TOKEN: "secret-123" }, "/repo/app"),
    [
      "--listen",
      "ws://127.0.0.1:3015",
      "--auth",
      "token",
      "--token-env",
      "LUDENS_APP_TOKEN",
      "--static-dir",
      resolve("/repo/app", "out"),
    ],
  );

  assert.deepEqual(
    buildProductionStartArgs(["--listen", "ws://0.0.0.0:3015"], emptyEnv, "/repo/app"),
    ["--static-dir", resolve("/repo/app", "out"), "--listen", "ws://0.0.0.0:3015"],
  );
});

test("resolveLudensServerCommand prefers bun + server/src/cli/main.ts over .cmd shim and buildServerSpawn wraps Windows .cmd", () => {
  const spec = resolveLudensServerCommand(
    "/repo/client",
    { PATH: "", LUDENS_BUN: "/opt/bun" },
    "win32",
    p => String(p).endsWith("server/src/cli/main.ts") || String(p).endsWith("server/bin/ludens-server.cmd"),
  );
  assert.equal(spec.command, "/opt/bun");
  assert.equal(spec.argsPrefix.length, 1);
  assert.ok(spec.argsPrefix[0]?.endsWith("server/src/cli/main.ts"));

  const wrapped = buildServerSpawn(
    "C:\\bin\\ludens-server.cmd",
    ["serve", "--dev"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.deepEqual(wrapped, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "C:\\bin\\ludens-server.cmd", "serve", "--dev"],
  });
});
