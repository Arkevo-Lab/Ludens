import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_RPC_ERROR_CODES } from "@ludens/protocol/app-rpc";
import {
  ensureWorkspaceIdentity,
  readGlobalConfig,
  registerWorkspace,
  validateGlobalConfig,
  writeGlobalConfig,
} from "@ludens/protocol/ludens";
import { NodeUdsRpcClient, WsAppRpcClient } from "../src/daemon/app-rpc-client.ts";
import { parseWorkspaceLaunchConfig } from "../src/query/workspace-init.ts";
import { workspaceSettings, workspaceStudio } from "../src/query/workspaces.ts";
import { startAppServer } from "../src/server/app-server.ts";

async function expectCapabilityRestricted(call: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({
    code: APP_RPC_ERROR_CODES.UNAUTHORIZED,
    data: {
      code: "CAPABILITY_RESTRICTED",
      status: 403,
    },
  });
}

test("desktop (UDS), web-dev (--dev WS), and non-loopback --dev refusal enforce runtime profile contracts", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-runtime-profiles-")));
  const home = join(rootDir, "home");
  const existingWs = join(rootDir, "existing-ws");
  const customWsRoot = join(rootDir, "custom-workspaces");
  const storageDir = join(rootDir, "archive-dir");
  await mkdir(existingWs, { recursive: true });
  await writeFile(join(existingWs, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  await ensureWorkspaceIdentity(existingWs);

  try {
    // Non-loopback --dev must always be refused even when token auth is configured.
    await expect(
      startAppServer({
        home,
        unixSocketPath: false,
        wsListen: { host: "0.0.0.0", port: 0 },
        devMode: true,
        auth: { mode: "token", token: "secret-token" },
      }),
    ).rejects.toThrow("Refusing to enable --dev mode on non-loopback host");

    await expect(
      startAppServer({
        home,
        unixSocketPath: false,
        wsListen: { host: "192.168.1.25", port: 0 },
        devMode: true,
        auth: { mode: "token", token: "secret-token" },
      }),
    ).rejects.toThrow("Refusing to enable --dev mode on non-loopback host");

    // Loopback --dev server exposes web-dev over WS and desktop over UDS.
    const devServer = await startAppServer({
      home,
      wsListen: { host: "127.0.0.1", port: 0 },
      devMode: true,
    });
    const udsClient = new NodeUdsRpcClient({ socketPath: devServer.socketPath! });
    const wsDevClient = new WsAppRpcClient({ url: devServer.wsUrl! });

    try {
      expect(devServer.devMode).toBe(true);
      await udsClient.connect();
      await wsDevClient.connect();

      const udsInit = await udsClient.initialize({ clientInfo: { name: "electron-desktop", version: "1.0.0" } });
      expect(udsInit.runtimeProfile).toBe("desktop");
      expect(udsInit.capabilities).toEqual({
        localFsPaths: true,
        localFileDrivers: true,
        hostProcessOverrides: true,
        hostStorageConfig: true,
      });

      const wsDevInit = await wsDevClient.initialize({ clientInfo: { name: "vite-preview", version: "1.0.0" } });
      expect(wsDevInit.runtimeProfile).toBe("web-dev");
      expect(wsDevInit.capabilities).toEqual({
        localFsPaths: true,
        localFileDrivers: true,
        hostProcessOverrides: true,
        hostStorageConfig: true,
      });

      const status = await wsDevClient.call("daemon/status");
      expect(status.devMode).toBe(true);

      // web-dev WS has full local host capabilities for harness & frontend development.
      const updatedRoot = (await wsDevClient.call("workspaces/mutate", {
        action: "updateRoot",
        workspaceRoot: customWsRoot,
      })) as { config: { workspaceRoot: string } };
      expect(updatedRoot.config.workspaceRoot).toBe(customWsRoot);

      const opened = (await wsDevClient.call("workspaces/mutate", {
        action: "open",
        workspace: existingWs,
      })) as { workspace: string };
      expect(opened.workspace).toBe(existingWs);

      const createdCustom = (await wsDevClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "dev-cua",
          workspace: join(rootDir, "explicit-dev-ws"),
          driver: "cua",
          cuaCommand: "/usr/local/bin/cua-driver",
        },
      })) as { workspace: string };
      expect(createdCustom.workspace).toBe(join(rootDir, "explicit-dev-ws"));

      const probeDir = await wsDevClient.call("storage/test", {
        kind: "directory",
        directory: { path: storageDir },
      });
      expect(probeDir.ok).toBe(true);
    } finally {
      await wsDevClient.close().catch(() => {});
      await udsClient.close().catch(() => {});
      await devServer.close({ emergency: true });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}, 20_000);

test("remote WS sessions enforce managed-sandbox capability restrictions across workspaces, drivers, baseware, and storage", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-remote-sandbox-")));
  const home = join(rootDir, "home");
  const outsideWs = join(rootDir, "outside-ws");
  await mkdir(outsideWs, { recursive: true });
  await writeFile(join(outsideWs, "ludens.json"), JSON.stringify({ driver: "cua" }), "utf8");
  await ensureWorkspaceIdentity(outsideWs);

  const secretToken = "remote-cloud-token-123";
  const server = await startAppServer({
    home,
    unixSocketPath: false,
    wsListen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "token", token: secretToken },
  });
  const remoteClient = new WsAppRpcClient({ url: server.wsUrl!, token: secretToken });

  try {
    expect(server.devMode).toBe(false);
    await remoteClient.connect();
    const init = await remoteClient.initialize({
      token: secretToken,
      clientInfo: { name: "mobile-web", version: "1.0.0" },
    });
    expect(init.runtimeProfile).toBe("remote");
    expect(init.capabilities).toEqual({
      localFsPaths: false,
      localFileDrivers: false,
      hostProcessOverrides: false,
      hostStorageConfig: false,
    });

    const daemonStatus = await remoteClient.call("daemon/status");
    expect(daemonStatus.devMode).toBe(false);

    // 1. Managed sandbox operations succeed cleanly
    const createdManaged = (await remoteClient.call("workspaces/mutate", {
      action: "create",
      input: {
        name: "managed-cloud-ws",
        driver: "cua",
        seconds: 1200,
      },
    })) as { id: string; workspace: string };
    expect(createdManaged.workspace).toBe(join(home, "workspaces", "managed-cloud-ws"));

    const updatedSafeStudio = (await remoteClient.call("workspaces/mutate", {
      action: "updateStudioConfig",
      workspaceId: createdManaged.id,
      patch: {
        seconds: 900,
        pet: false,
        storage: { mode: "ephemeral" },
      },
    })) as { config: { seconds: number; storage: { mode: string } } };
    expect(updatedSafeStudio.config.seconds).toBe(900);
    expect(updatedSafeStudio.config.storage.mode).toBe("ephemeral");

    const updatedSafeStorage = await remoteClient.call("storage/update", {
      videoQuality: "compact",
    });
    expect(updatedSafeStorage.config.videoQuality).toBe("compact");

    // 2. workspaces/mutate restrictions
    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "open",
        workspace: outsideWs,
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateRoot",
        workspaceRoot: join(rootDir, "escaped-root"),
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "escape-dir",
          workspace: join(rootDir, "escaped-ws"),
          driver: "cua",
        },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "escape-file-driver",
          driver: "custom",
          driverPackage: "file:/tmp/local-driver",
        },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "escape-cua-cmd",
          driver: "cua",
          cuaCommand: "/bin/sh",
        },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "escape-abs-game",
          driver: "cua",
          game: "/etc/passwd",
        },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "create",
        input: {
          name: "escape-dotdot-game",
          driver: "cua",
          game: "../outside/game.rom",
        },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateStudioConfig",
        workspaceId: createdManaged.id,
        patch: { cuaCommand: "/usr/local/bin/evil" },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateStudioConfig",
        workspaceId: createdManaged.id,
        patch: { driverPackage: "file:./local-driver" },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateStudioConfig",
        workspaceId: createdManaged.id,
        patch: { game: "/abs/path/game.rom" },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateStudioConfig",
        workspaceId: createdManaged.id,
        patch: { game: "roms/../../outside.rom" },
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("workspaces/mutate", {
        action: "updateStudioConfig",
        workspaceId: createdManaged.id,
        patch: { storage: { mode: "directory" } },
      }),
    );

    // 3. drivers/discover restriction
    await expectCapabilityRestricted(() =>
      remoteClient.call("drivers/discover", {
        spec: "file:/tmp/local-driver",
      }),
    );

    // 4. baseware/mutate restrictions
    await expectCapabilityRestricted(() =>
      remoteClient.call("baseware/mutate", {
        action: "registerDriver",
        spec: "file:/tmp/local-driver",
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("baseware/mutate", {
        action: "registerDriver",
        spec: {
          id: "local-drv",
          spec: "file:/tmp/local-driver",
          updatedAt: new Date().toISOString(),
        },
      }),
    );

    for (const action of ["upsertMachine", "probeMachine"] as const) {
      await expectCapabilityRestricted(() =>
        remoteClient.call("baseware/mutate", {
          action,
          machine: {
            id: "file-drv-machine",
            name: "File Driver Machine",
            driver: "custom",
            driverPackage: "file:/tmp/local-driver",
            transport: { kind: "bridge", port: 9001 },
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      await expectCapabilityRestricted(() =>
        remoteClient.call("baseware/mutate", {
          action,
          machine: {
            id: "stdio-cmd-machine",
            name: "Stdio Override",
            driver: "cua",
            transport: { kind: "stdio", command: "/usr/local/bin/custom-cua" },
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      await expectCapabilityRestricted(() =>
        remoteClient.call("baseware/mutate", {
          action,
          machine: {
            id: "ssh-key-machine",
            name: "SSH Key Path",
            driver: "cua",
            transport: { kind: "ssh", host: "10.0.0.10", identityFile: "/Users/admin/.ssh/id_ed25519" },
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      await expectCapabilityRestricted(() =>
        remoteClient.call("baseware/mutate", {
          action,
          machine: {
            id: "ssh-cmd-machine",
            name: "SSH Command Override",
            driver: "cua",
            transport: { kind: "ssh", host: "10.0.0.10", command: "/opt/bin/agent" },
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      await expectCapabilityRestricted(() =>
        remoteClient.call("baseware/mutate", {
          action,
          machine: {
            id: "bridge-escape-game",
            name: "Bridge Escape Game",
            driver: "custom",
            transport: { kind: "bridge", port: 9002, game: "../escape.rom", managed: true },
            updatedAt: new Date().toISOString(),
          },
        }),
      );
    }

    // 5. storage/update, storage/test, and storage/mutate restrictions
    await expectCapabilityRestricted(() =>
      remoteClient.call("storage/update", {
        profiles: [
          {
            id: "host-dir",
            name: "Host Directory",
            kind: "directory",
            directory: { path: join(rootDir, "host-archive") },
          },
        ],
      }),
    );

    await expectCapabilityRestricted(() =>
      remoteClient.call("storage/test", {
        kind: "directory",
        directory: { path: join(rootDir, "host-archive") },
      }),
    );

    await expectCapabilityRestricted(() =>
      (remoteClient as unknown as { call(m: string, p: unknown): Promise<unknown> }).call(
        "storage/mutate",
        {
          action: "updateGlobal",
          config: { mode: "directory" },
        },
      ),
    );
  } finally {
    await remoteClient.close().catch(() => {});
    await server.close({ emergency: true });
    await rm(rootDir, { recursive: true, force: true });
  }
}, 20_000);

test("ludens serve CLI requires token auth on ws:// unless --dev is passed on loopback", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-serve-cli-")));
  const home = join(rootDir, "home");
  const mainCli = resolve(import.meta.dir, "../src/cli/main.ts");

  try {
    // 1. `ludens serve --listen ws://127.0.0.1:0` without --dev or --auth token fails fast with clear operator hint
    const noTokenRes = spawnSync(
      process.execPath,
      [mainCli, "serve", "--listen", "ws://127.0.0.1:0"],
      {
        cwd: rootDir,
        env: { ...process.env, LUDENS_HOME: home },
        encoding: "utf8",
      },
    );
    expect(noTokenRes.status).not.toBe(0);
    expect(noTokenRes.stderr).toContain("--auth token --token-env");
    expect(noTokenRes.stderr).toContain("--dev");

    // 2. `ludens serve --dev --listen ws://0.0.0.0:0` refuses non-loopback --dev
    const badDevHost = spawnSync(
      process.execPath,
      [mainCli, "serve", "--dev", "--listen", "ws://0.0.0.0:0"],
      {
        cwd: rootDir,
        env: { ...process.env, LUDENS_HOME: home },
        encoding: "utf8",
      },
    );
    expect(badDevHost.status).not.toBe(0);
    expect(badDevHost.stderr).toContain("Refusing to enable --dev mode on non-loopback host");

    // 3. `ludens serve --listen ws://127.0.0.1:0 --auth token --token-env LUDENS_SERVE_SECRET` succeeds (`devMode: false`, `remote` profile)
    const tokenChild = spawn(
      process.execPath,
      [
        mainCli,
        "serve",
        "--listen",
        "ws://127.0.0.1:0",
        "--auth",
        "token",
        "--token-env",
        "LUDENS_SERVE_SECRET",
        "--parent-watchdog",
      ],
      {
        cwd: rootDir,
        env: { ...process.env, LUDENS_HOME: home, LUDENS_SERVE_SECRET: "serve-token-xyz" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      const handshakeLine = await new Promise<string>((resolveLine, rejectLine) => {
        let buf = "";
        let errBuf = "";
        const timer = setTimeout(() => rejectLine(new Error(`Handshake timeout: ${errBuf}`)), 8000);
        tokenChild.stderr?.on("data", chunk => {
          errBuf += String(chunk);
        });
        tokenChild.stdout?.on("data", chunk => {
          buf += String(chunk);
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            clearTimeout(timer);
            resolveLine(buf.slice(0, nl).trim());
          }
        });
        tokenChild.once("exit", code => {
          clearTimeout(timer);
          rejectLine(new Error(`serve exited early (${code}): ${errBuf}`));
        });
      });
      const handshake = JSON.parse(handshakeLine) as { authMode: string; devMode: boolean; wsUrl: string };
      expect(handshake.authMode).toBe("token");
      expect(handshake.devMode).toBe(false);

      const client = new WsAppRpcClient({ url: handshake.wsUrl, token: "serve-token-xyz" });
      await client.connect();
      const init = await client.initialize({ token: "serve-token-xyz" });
      expect(init.runtimeProfile).toBe("remote");
      expect(init.capabilities.localFsPaths).toBe(false);
      await client.close();

      const exited = new Promise<number | null>(res => tokenChild.once("exit", res));
      tokenChild.stdin?.end();
      expect(await exited).toBe(0);
    } finally {
      tokenChild.kill("SIGKILL");
    }

    // 4. `ludens app-server --dev --listen ws://127.0.0.1:0 --parent-watchdog` emits `devMode: true` and `web-dev` profile
    const devHome = join(rootDir, "dev-home");
    const devChild = spawn(
      process.execPath,
      [mainCli, "serve", "--dev", "--listen", "ws://127.0.0.1:0", "--parent-watchdog"],
      {
        cwd: rootDir,
        env: { ...process.env, LUDENS_HOME: devHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      const handshakeLine = await new Promise<string>((resolveLine, rejectLine) => {
        let buf = "";
        let errBuf = "";
        const timer = setTimeout(() => rejectLine(new Error(`Handshake timeout: ${errBuf}`)), 8000);
        devChild.stderr?.on("data", chunk => {
          errBuf += String(chunk);
        });
        devChild.stdout?.on("data", chunk => {
          buf += String(chunk);
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            clearTimeout(timer);
            resolveLine(buf.slice(0, nl).trim());
          }
        });
        devChild.once("exit", code => {
          clearTimeout(timer);
          rejectLine(new Error(`dev app-server exited early (${code}): ${errBuf}`));
        });
      });
      const handshake = JSON.parse(handshakeLine) as { authMode: string; devMode: boolean; wsUrl: string; home: string };
      expect(handshake.authMode).toBe("none");
      expect(handshake.devMode).toBe(true);
      expect(handshake.home).toBe(devHome);

      const client = new WsAppRpcClient({ url: handshake.wsUrl });
      await client.connect();
      const init = await client.initialize();
      expect(init.runtimeProfile).toBe("web-dev");
      expect(init.capabilities.localFsPaths).toBe(true);
      await client.close();

      const exited = new Promise<number | null>(res => devChild.once("exit", res));
      devChild.stdin?.end();
      expect(await exited).toBe(0);
    } finally {
      devChild.kill("SIGKILL");
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}, 25_000);

test("legacy dashboard properties in config.json and ludens.json are silently stripped and never written out", async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "ludens-legacy-dashboard-")));
  const home = join(rootDir, "home");
  const wsDir = join(rootDir, "legacy-ws");
  await mkdir(home, { recursive: true });
  await mkdir(wsDir, { recursive: true });

  try {
    // 1. Global ~/.ludens/config.json with legacy `defaults.dashboard`
    const validatedGlobal = validateGlobalConfig({
      version: 1,
      workspaceRoot: join(home, "workspaces"),
      defaults: {
        model: "openai-codex/gpt-6.1-sol",
        dashboard: true,
        pet: false,
      },
    });
    expect("dashboard" in validatedGlobal.defaults).toBe(false);
    expect(validatedGlobal.defaults).toEqual({
      model: "openai-codex/gpt-6.1-sol",
      pet: false,
    });

    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot: join(home, "workspaces"),
        defaults: { seconds: 600, dashboard: false, pet: true },
      }),
      "utf8",
    );
    const loadedGlobal = await readGlobalConfig(home);
    expect("dashboard" in loadedGlobal.defaults).toBe(false);
    await writeGlobalConfig(loadedGlobal, home);
    const rewrittenGlobal = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      defaults: Record<string, unknown>;
    };
    expect("dashboard" in rewrittenGlobal.defaults).toBe(false);

    // 2. Workspace ludens.json with legacy `dashboard`
    const parsedLaunch = parseWorkspaceLaunchConfig(
      { driver: "cua", dashboard: true, pet: false, seconds: 900 },
      { id: "cua", transport: "stdio" },
    );
    expect("dashboard" in parsedLaunch).toBe(false);
    expect(parsedLaunch).toMatchObject({ driver: "cua", pet: false, seconds: 900 });

    await writeFile(
      join(wsDir, "ludens.json"),
      JSON.stringify({ driver: "cua", dashboard: true, pet: true }, null, 2),
      "utf8",
    );
    const identity = await ensureWorkspaceIdentity(wsDir);
    await registerWorkspace(wsDir, home);

    const settings = await workspaceSettings(home);
    const summary = settings.summaries[identity.id]!;
    expect(summary).toBeTruthy();
    expect("dashboard" in (summary as unknown as Record<string, unknown>)).toBe(false);

    const studio = await workspaceStudio(identity.id, home);
    expect(studio.services.jobs.map(j => j.name)).toEqual(["emulator", "baseware", "host", "pet"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
