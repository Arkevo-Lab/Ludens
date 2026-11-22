import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  buildDevExecutionPlan,
  buildDevServerArgs,
  buildLoopbackTrustedOrigins,
  buildManagedAppServerArgs,
  buildServerSpawn,
  parseDevArgs,
  resolveDesktopCommand,
  resolveDevHome,
  resolveLudensServerCommand,
} from "../../scripts/dev.mjs";
import { buildSelfhostArgs } from "../../scripts/selfhost.mjs";

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

test("parseDevArgs supports web, desktop, and server modes with isolated default and --real-home", () => {
  const fakeHome = "/Users/bob";

  const isolated = parseDevArgs([], {}, fakeHome);
  assert.equal(isolated.mode, "web");
  assert.equal(isolated.port, "3015");
  assert.equal(isolated.hostname, "127.0.0.1");
  assert.equal(isolated.ludensHome, resolve(fakeHome, ".ludens-dev"));
  assert.equal(isolated.realHome, false);
  assert.equal(isolated.home, undefined);
  assert.deepEqual(isolated.rest, []);

  const webFromEnv = parseDevArgs(["web", "--port=3099"], { LUDENS_HOME: "/tmp/harness-home" }, fakeHome);
  assert.equal(webFromEnv.mode, "web");
  assert.equal(webFromEnv.port, "3099");
  assert.equal(webFromEnv.ludensHome, resolve("/tmp/harness-home"));
  assert.equal(webFromEnv.realHome, false);

  const desktopIsolated = parseDevArgs(["desktop"], {}, fakeHome);
  assert.equal(desktopIsolated.mode, "desktop");
  assert.equal(desktopIsolated.ludensHome, resolve(fakeHome, ".ludens-dev"));
  assert.equal(desktopIsolated.realHome, false);

  const desktopReal = parseDevArgs(["desktop", "--real-home"], { LUDENS_HOME: "/tmp/ignored" }, fakeHome);
  assert.equal(desktopReal.mode, "desktop");
  assert.equal(desktopReal.ludensHome, resolve(fakeHome, ".ludens"));
  assert.equal(desktopReal.realHome, true);
  assert.deepEqual(desktopReal.rest, []);

  const serverIsolated = parseDevArgs(["server", "--listen", "ws://127.0.0.1:48080"], {}, fakeHome);
  assert.equal(serverIsolated.mode, "server");
  assert.equal(serverIsolated.ludensHome, resolve(fakeHome, ".ludens-dev"));
  assert.deepEqual(serverIsolated.rest, ["--listen", "ws://127.0.0.1:48080"]);

  const serverReal = parseDevArgs(["server", "--real-home"], {}, fakeHome);
  assert.equal(serverReal.mode, "server");
  assert.equal(serverReal.ludensHome, resolve(fakeHome, ".ludens"));
  assert.equal(serverReal.realHome, true);

  const customSpace = parseDevArgs(["web", "--home", "/custom/dir", "--clearScreen", "false"], {}, fakeHome);
  assert.equal(customSpace.ludensHome, resolve("/custom/dir"));
  assert.equal(customSpace.home, "/custom/dir");
  assert.deepEqual(customSpace.rest, ["--clearScreen", "false"]);

  const customEquals = parseDevArgs(["--home=/another/dir"], {}, fakeHome);
  assert.equal(customEquals.ludensHome, resolve("/another/dir"));
  assert.equal(customEquals.home, "/another/dir");
});

test("buildDevExecutionPlan ensures desktop mode never spawns an extra TCP ludens-server", () => {
  const fakeHome = "/Users/bob";

  const webPlan = buildDevExecutionPlan(["web", "--port", "3120"], {}, fakeHome);
  assert.equal(webPlan.mode, "web");
  assert.equal(webPlan.spawnsTcpAppServer, true);
  assert.equal(webPlan.spawnsVite, true);
  assert.equal(webPlan.buildsDesktop, false);
  assert.equal(webPlan.spawnsElectron, false);
  assert.equal(webPlan.ludensHome, resolve(fakeHome, ".ludens-dev"));

  const desktopPlan = buildDevExecutionPlan(["desktop", "--port", "3120"], {}, fakeHome);
  assert.equal(desktopPlan.mode, "desktop");
  assert.equal(desktopPlan.spawnsTcpAppServer, false);
  assert.equal(desktopPlan.managedServerArgs, null);
  assert.equal(desktopPlan.buildsDesktop, true);
  assert.equal(desktopPlan.spawnsVite, true);
  assert.equal(desktopPlan.spawnsElectron, true);
  assert.equal(desktopPlan.desktopDevUrl, "http://127.0.0.1:3120");
  assert.equal(desktopPlan.ludensHome, resolve(fakeHome, ".ludens-dev"));

  const serverPlan = buildDevExecutionPlan(["server"], {}, fakeHome);
  assert.equal(serverPlan.mode, "server");
  assert.equal(serverPlan.spawnsTcpAppServer, true);
  assert.equal(serverPlan.spawnsVite, false);
  assert.equal(serverPlan.spawnsElectron, false);
  assert.deepEqual(serverPlan.serverArgs, ["serve", "--dev", "--listen", "ws://127.0.0.1:38080"]);
  assert.equal(serverPlan.ludensHome, resolve(fakeHome, ".ludens-dev"));

  assert.deepEqual(
    buildDevServerArgs(["--listen", "ws://127.0.0.1:49000", "--trusted-origin", "http://localhost:3015"]),
    ["serve", "--dev", "--listen", "ws://127.0.0.1:49000", "--trusted-origin", "http://localhost:3015"],
  );
});

test("parseDevArgs enforces loopback-only hostnames and rejects invalid modes, ports, or empty --home", () => {
  const fakeHome = "/Users/bob";

  assert.equal(parseDevArgs(["web", "--hostname", "localhost"], {}, fakeHome).hostname, "localhost");
  assert.equal(parseDevArgs(["desktop", "--hostname", "[::1]"], {}, fakeHome).hostname, "::1");
  assert.deepEqual(buildLoopbackTrustedOrigins("3015", "::1"), [
    "http://[::1]:3015",
    "http://127.0.0.1:3015",
    "http://localhost:3015",
  ]);

  assert.throws(
    () => parseDevArgs(["unknown-mode"], {}, fakeHome),
    /Unknown dev mode/,
  );
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

test("buildSelfhostArgs serves client/dist with --dev on tokenless loopback and --auth token when LUDENS_APP_TOKEN is set", () => {
  const emptyEnv = { NODE_ENV: "test" as const };
  assert.deepEqual(buildSelfhostArgs([], emptyEnv, "/repo"), [
    "--listen",
    "ws://127.0.0.1:3015",
    "--dev",
    "--static-dir",
    resolve("/repo", "client/dist"),
  ]);

  assert.deepEqual(
    buildSelfhostArgs([], { NODE_ENV: "test" as const, LUDENS_APP_TOKEN: "secret-123" }, "/repo"),
    [
      "--listen",
      "ws://127.0.0.1:3015",
      "--auth",
      "token",
      "--token-env",
      "LUDENS_APP_TOKEN",
      "--static-dir",
      resolve("/repo", "client/dist"),
    ],
  );

  assert.deepEqual(
    buildSelfhostArgs(["--listen", "ws://0.0.0.0:3015"], emptyEnv, "/repo"),
    ["--static-dir", resolve("/repo", "client/dist"), "--listen", "ws://0.0.0.0:3015"],
  );
});

test("resolveLudensServerCommand prefers bun + server/src/cli/main.ts over .cmd shim and buildServerSpawn wraps Windows .cmd", () => {
  const spec = resolveLudensServerCommand(
    "/repo",
    { PATH: "", LUDENS_BUN: "/opt/bun" },
    "win32",
    p => String(p).endsWith("server/src/cli/main.ts") || String(p).endsWith("server/bin/ludens-server.cmd"),
  );
  assert.equal(spec.command, "/opt/bun");
  assert.equal(spec.argsPrefix.length, 1);
  assert.ok(spec.argsPrefix[0]?.endsWith("server/src/cli/main.ts"));

  const wrapped = buildServerSpawn(
    "C:\\Program Files\\Ludens\\ludens-server.cmd",
    ["serve", "--dev", "--static-dir", "C:\\My App\\"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.deepEqual(wrapped, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `""C:\\Program Files\\Ludens\\ludens-server.cmd" serve --dev --static-dir "C:\\My App\\\\""`,
    ],
    windowsVerbatimArguments: true,
  });
});

test("resolveDesktopCommand passes --parent-watchdog on POSIX and win32 without requiring built bundle", () => {
  const devOrigin = "http://127.0.0.1:3015";
  const expectedArgs = ["--server", devOrigin, "--show-window", "--parent-watchdog"];
  const onlyMainExists = (p: unknown) =>
    String(p).replace(/\\/g, "/").endsWith("desktop/dist/electron/main.js");

  for (const platform of ["darwin", "linux"] as const) {
    const cmd = resolveDesktopCommand(devOrigin, platform, onlyMainExists);
    assert.ok(cmd.command.replace(/\\/g, "/").endsWith("desktop/bin/ludens-app"));
    assert.deepEqual(cmd.args, expectedArgs);
  }

  const winExe = resolveDesktopCommand(
    devOrigin,
    "win32",
    p => {
      const normalized = String(p).replace(/\\/g, "/");
      return (
        normalized.endsWith("desktop/dist/electron/main.js") ||
        normalized.endsWith("desktop/node_modules/electron/dist/electron.exe")
      );
    },
  );
  assert.ok(winExe.command.replace(/\\/g, "/").endsWith("desktop/node_modules/electron/dist/electron.exe"));
  assert.ok(winExe.args[0]?.replace(/\\/g, "/").endsWith("desktop/dist/electron/main.js"));
  assert.deepEqual(winExe.args.slice(1), expectedArgs);

  const winCmdFallback = resolveDesktopCommand(devOrigin, "win32", onlyMainExists);
  assert.equal(winCmdFallback.args[0], "/c");
  assert.ok(winCmdFallback.args[1]?.replace(/\\/g, "/").endsWith("desktop/bin/ludens-app.cmd"));
  assert.deepEqual(winCmdFallback.args.slice(2), expectedArgs);

  assert.throws(
    () => resolveDesktopCommand(devOrigin, "darwin", () => false),
    /Desktop bundle desktop\/dist\/electron\/main\.js is missing/,
  );
});
