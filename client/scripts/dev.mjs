import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLudensServerCommand, resolveViteBin, withBunNodePath } from "./production.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK_DEV_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function formatOriginHost(hostname) {
  const trimmed = hostname.trim();
  if (trimmed === "::1") return "[::1]";
  return trimmed;
}

export function buildLoopbackTrustedOrigins(port, hostname) {
  const primary = `http://${formatOriginHost(hostname)}:${port}`;
  const set = new Set([
    primary,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return [...set];
}

/**
 * @typedef {object} ParsedDevArgs
 * @property {string} port
 * @property {string} hostname
 * @property {string[]} rest
 * @property {string} ludensHome
 * @property {boolean} realHome
 * @property {string | undefined} home
 * @property {boolean} desktop
 */

/**
 * @param {{ home?: string, realHome?: boolean }} [options]
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 * @returns {string}
 */
export function resolveDevHome(options = {}, env = process.env, homeDir = homedir()) {
  const explicitHome = typeof options?.home === "string" ? options.home.trim() : "";
  if (explicitHome) {
    return resolve(explicitHome);
  }
  if (options?.realHome) {
    return resolve(homeDir, ".ludens");
  }
  const envHome = typeof env?.LUDENS_HOME === "string" ? env.LUDENS_HOME.trim() : "";
  if (envHome) {
    return resolve(envHome);
  }
  return resolve(homeDir, ".ludens-dev");
}

/**
 * @param {string | string[]} trustedOrigins
 * @param {string[]} [argsPrefix]
 * @returns {string[]}
 */
export function buildManagedAppServerArgs(trustedOrigins, argsPrefix = []) {
  const originFlags = (Array.isArray(trustedOrigins) ? trustedOrigins : [trustedOrigins]).flatMap(
    origin => ["--trusted-origin", origin],
  );
  return [
    ...argsPrefix,
    "serve",
    "--dev",
    "--listen",
    "ws://127.0.0.1:0",
    "--parent-watchdog",
    ...originFlags,
  ];
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 * @returns {ParsedDevArgs}
 */
export function parseDevArgs(argv, env = process.env, homeDir = homedir()) {
  const hasExplicitEnvOrHomeArgs = arguments.length > 1;
  let port = env?.PORT || "3015";
  let hostname = "127.0.0.1";
  let realHome = false;
  /** @type {string | undefined} */
  let home = undefined;
  let desktop = false;
  /** @type {string[]} */
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      port = argv[++i];
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    } else if (arg.startsWith("-p=")) {
      port = arg.slice("-p=".length);
    } else if (arg === "--hostname" || arg === "-H") {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      hostname = argv[++i];
    } else if (arg.startsWith("--hostname=")) {
      hostname = arg.slice("--hostname=".length);
    } else if (arg.startsWith("-H=")) {
      hostname = arg.slice("-H=".length);
    } else if (arg === "--real-home") {
      realHome = true;
    } else if (arg === "--home") {
      if (i + 1 >= argv.length || !argv[i + 1]?.trim()) {
        throw new Error("Missing value for --home");
      }
      home = argv[++i];
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value.trim()) {
        throw new Error("Missing value for --home");
      }
      home = value;
    } else if (arg === "--desktop") {
      desktop = true;
    } else {
      rest.push(arg);
    }
  }

  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`Invalid dev port: ${port}`);
  }
  const normalizedHost = hostname.trim().toLowerCase();
  if (!LOOPBACK_DEV_HOSTS.has(normalizedHost)) {
    throw new Error(
      `Refusing non-loopback dev hostname "${hostname}". Use 127.0.0.1, localhost, or ::1.`,
    );
  }
  const normalizedHostname = normalizedHost === "[::1]" ? "::1" : normalizedHost;
  const ludensHome = resolveDevHome({ home, realHome }, env, homeDir);

  if (!hasExplicitEnvOrHomeArgs && !realHome && home === undefined && !desktop) {
    const base = { port: String(numericPort), hostname: normalizedHostname, rest };
    Object.defineProperties(base, {
      ludensHome: { value: ludensHome, configurable: true },
      realHome: { value: false, configurable: true },
      home: { value: undefined, configurable: true },
      desktop: { value: false, configurable: true },
    });
    return /** @type {ParsedDevArgs} */ (base);
  }

  return {
    port: String(numericPort),
    hostname: normalizedHostname,
    rest,
    ludensHome,
    realHome,
    home,
    desktop,
  };
}

function forceKillProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function waitForExit(child, timeoutMs = 6_500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      forceKillProcessTree(child);
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function terminateAppServerChild(child, timeoutMs = 6_500) {
  if (!child) return;
  try {
    child.stdin?.end();
    child.stdin?.destroy();
  } catch {}
  if (process.platform !== "win32" && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  await waitForExit(child, timeoutMs);
}

async function spawnManagedAppServer(trustedOrigins, effectiveHome) {
  mkdirSync(effectiveHome, { recursive: true });
  const { command, argsPrefix } = resolveLudensServerCommand(directory, process.env, process.platform);
  const child = spawn(command, buildManagedAppServerArgs(trustedOrigins, argsPrefix), {
    cwd: resolve(directory, ".."),
    env: {
      ...process.env,
      LUDENS_HOME: effectiveHome,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin?.on("error", () => {});

  try {
    const url = await new Promise((resolvePromise, rejectPromise) => {
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectPromise(new Error("Timed out waiting for ludens app-server handshake (15s)"));
      }, 15_000);

      const onError = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };

      const onExit = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(
          new Error(
            `ludens app-server exited before ready handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      };

      const onData = chunk => {
        if (settled) {
          process.stdout.write(chunk);
          return;
        }
        buffer += chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line);
              if (parsed && parsed.ready === true && typeof parsed.url === "string") {
                settled = true;
                clearTimeout(timer);
                child.off("error", onError);
                child.off("exit", onExit);
                if (buffer.length > 0) {
                  process.stdout.write(buffer);
                  buffer = "";
                }
                resolvePromise(parsed.url.replace(/\/+$/, ""));
                return;
              }
            } catch {
              process.stdout.write(`${line}\n`);
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      };

      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout?.on("data", onData);
    });

    return { child, url };
  } catch (error) {
    await terminateAppServerChild(child, 2_500);
    throw error;
  }
}

function resolveDesktopCommand(devOrigin, clientRoot = directory, platform = process.platform) {
  const desktopRoot = resolve(clientRoot, "../desktop");
  const mainEntry = join(desktopRoot, "dist/electron/main.js");
  if (!existsSync(mainEntry)) {
    throw new Error(
      "Desktop bundle ../desktop/dist/electron/main.js is missing. Run `bun --cwd desktop run build` first (or `bun --cwd desktop run dev`).",
    );
  }
  const desktopArgs = ["--server", devOrigin, "--show-window"];
  if (platform === "win32") {
    const exeCandidates = [
      join(desktopRoot, "node_modules/electron/dist/electron.exe"),
      resolve(desktopRoot, "../node_modules/electron/dist/electron.exe"),
    ];
    for (const candidate of exeCandidates) {
      if (existsSync(candidate)) {
        return { command: candidate, args: [mainEntry, ...desktopArgs] };
      }
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/c", join(desktopRoot, "bin/ludens-app.cmd"), ...desktopArgs],
    };
  }
  return {
    command: join(desktopRoot, "bin/ludens-app"),
    args: desktopArgs,
  };
}

async function waitForDevOrigin(devOrigin, viteChild, isShuttingDown, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isShuttingDown() || viteChild.exitCode !== null || viteChild.signalCode !== null) {
      return false;
    }
    try {
      const response = await fetch(devOrigin, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel().catch(() => {});
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 120));
    }
  }
  throw new Error(`Timed out waiting for Vite dev server at ${devOrigin} (${timeoutMs}ms)`);
}

async function main() {
  const {
    port,
    hostname,
    rest,
    ludensHome: effectiveHome,
    desktop,
  } = parseDevArgs(process.argv.slice(2));
  const trustedOrigins = buildLoopbackTrustedOrigins(port, hostname);
  const devOrigin = `http://${formatOriginHost(hostname)}:${port}`;

  if (desktop) {
    resolveDesktopCommand(devOrigin, directory, process.platform);
  }
  mkdirSync(effectiveHome, { recursive: true });

  let serverChild = null;
  let viteChild = null;
  let desktopChild = null;
  let appServerUrl = process.env.LUDENS_APP_SERVER_URL?.trim().replace(/\/+$/, "");
  let shuttingDown = false;
  let cleanupPromise = null;

  const cleanup = () => {
    shuttingDown = true;
    cleanupPromise ??= (async () => {
      if (desktopChild && desktopChild.exitCode === null && desktopChild.signalCode === null) {
        try {
          desktopChild.kill("SIGTERM");
        } catch {}
      }
      if (viteChild && viteChild.exitCode === null && viteChild.signalCode === null) {
        try {
          viteChild.kill("SIGTERM");
        } catch {}
      }
      await Promise.all([
        waitForExit(desktopChild, 4_000),
        waitForExit(viteChild, 4_000),
        terminateAppServerChild(serverChild, 6_500),
      ]);
    })();
    return cleanupPromise;
  };

  const onSignal = signal => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    if (!appServerUrl) {
      const started = await spawnManagedAppServer(trustedOrigins, effectiveHome);
      serverChild = started.child;
      appServerUrl = started.url;
      serverChild.once("exit", (code, signal) => {
        if (!shuttingDown) {
          console.error(
            `[ludens-dev] app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}); stopping vite`,
          );
          void cleanup().finally(() => {
            process.exit(code ?? 1);
          });
        }
      });
    }
    console.log(
      `[ludens-dev] mode=web-dev home=${effectiveHome} app-server=${appServerUrl} -> vite ${devOrigin}`,
    );

    const env = {
      ...withBunNodePath(process.env, directory),
      LUDENS_HOME: effectiveHome,
      LUDENS_APP_SERVER_URL: appServerUrl,
    };

    viteChild = spawn(
      process.execPath,
      [
        resolveViteBin(directory),
        "--host",
        hostname,
        "--port",
        port,
        "--strictPort",
        ...rest,
      ],
      {
        cwd: directory,
        env,
        stdio: "inherit",
      },
    );

    const viteExitPromise = new Promise((resolvePromise, rejectPromise) => {
      viteChild.once("error", rejectPromise);
      viteChild.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });

    if (desktop) {
      const ready = await waitForDevOrigin(devOrigin, viteChild, () => shuttingDown);
      if (ready && !shuttingDown) {
        const { command, args: desktopArgs } = resolveDesktopCommand(devOrigin, directory);
        const desktopEnv = { ...env };
        delete desktopEnv.ELECTRON_RUN_AS_NODE;
        desktopChild = spawn(command, desktopArgs, {
          cwd: directory,
          env: desktopEnv,
          stdio: "inherit",
        });
        desktopChild.once("error", error => {
          if (!shuttingDown) {
            console.error(`[ludens-dev] desktop shell failed: ${error.message}`);
            void cleanup().finally(() => {
              process.exit(1);
            });
          }
        });
        desktopChild.once("exit", code => {
          if (!shuttingDown) {
            void cleanup().finally(() => {
              process.exit(code ?? 0);
            });
          }
        });
      }
    }

    const exitCode = await viteExitPromise;
    await cleanup();
    process.exitCode = exitCode;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
