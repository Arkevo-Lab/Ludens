import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeBinary, resolveViteBin, withBunNodePath } from "../client/scripts/build.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = join(repoRoot, "client");
const desktopRoot = join(repoRoot, "desktop");
const LOOPBACK_DEV_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const VALID_DEV_MODES = new Set(["web", "desktop", "server"]);

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

export function resolveBunBinary(
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
) {
  if (env.LUDENS_BUN?.trim()) return env.LUDENS_BUN.trim();
  const binName = platform === "win32" ? "bun.exe" : "bun";
  const pathSep = platform === "win32" ? ";" : delimiter;
  for (const entry of (env.PATH ?? "").split(pathSep).filter(Boolean)) {
    const candidate = join(entry, binName);
    if (exists(candidate)) return candidate;
  }
  const fallbacks = [
    join(home, ".bun", "bin", binName),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]),
  ];
  for (const candidate of fallbacks) {
    if (exists(candidate)) return candidate;
  }
  return binName;
}

export function resolveLudensServerCommand(
  rootDir = repoRoot,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  options = {},
) {
  const explicitBin = env.LUDENS_SERVER_BIN?.trim() || env.LUDENS_APP_SERVER_BIN?.trim();
  if (explicitBin) {
    return { command: explicitBin, argsPrefix: [] };
  }

  const candidateRoots = [rootDir, resolve(rootDir, "..")];
  if (options.preferDist) {
    for (const base of candidateRoots) {
      const distEntry = resolve(base, "server/dist/main.js");
      if (exists(distEntry)) {
        return { command: resolveBunBinary(env, platform, homedir(), exists), argsPrefix: [distEntry] };
      }
    }
  }

  for (const base of candidateRoots) {
    const repoEntry = resolve(base, "server/src/cli/main.ts");
    if (exists(repoEntry)) {
      return { command: resolveBunBinary(env, platform, homedir(), exists), argsPrefix: [repoEntry] };
    }
  }

  for (const base of candidateRoots) {
    const distEntry = resolve(base, "server/dist/main.js");
    if (exists(distEntry)) {
      return { command: resolveBunBinary(env, platform, homedir(), exists), argsPrefix: [distEntry] };
    }
  }

  const binNames =
    platform === "win32"
      ? ["ludens-server.exe", "ludens-server.cmd", "ludens-server.bat", "ludens-server"]
      : ["ludens-server"];
  const pathSep = platform === "win32" ? ";" : delimiter;
  for (const entry of (env.PATH ?? "").split(pathSep).filter(Boolean)) {
    for (const binName of binNames) {
      const candidate = join(entry, binName);
      if (exists(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    }
  }

  for (const base of candidateRoots) {
    const repoBin = resolve(
      base,
      "server/bin",
      platform === "win32" ? "ludens-server.cmd" : "ludens-server",
    );
    if (exists(repoBin)) {
      return { command: repoBin, argsPrefix: [] };
    }
  }

  return {
    command: platform === "win32" ? "ludens-server.cmd" : "ludens-server",
    argsPrefix: [],
  };
}

function quoteWindowsCmdToken(arg) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  if (!/[\s"&|<>()^%!]/.test(arg)) return escaped;
  return `"${escaped.replace(/(\\*)$/, "$1$1")}"`;
}

export function buildServerSpawn(
  command,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const quotedCmd = `"${command.replace(/"/g, '""').replace(/(\\*)$/, "$1$1")}"`;
    const quotedArgs = args.map(quoteWindowsCmdToken).join(" ");
    const cmdLine = quotedArgs ? `"${quotedCmd} ${quotedArgs}"` : `"${quotedCmd}"`;
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", cmdLine],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args };
}

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

function hasListenArg(args) {
  return args.some(arg => arg === "--listen" || arg.startsWith("--listen="));
}

function hasExplicitAuthOrDevArg(args) {
  return args.some(
    arg =>
      arg === "--dev" ||
      arg === "--auth" ||
      arg.startsWith("--auth=") ||
      arg === "--token" ||
      arg.startsWith("--token=") ||
      arg === "--token-env" ||
      arg.startsWith("--token-env="),
  );
}

export function buildDevServerArgs(restArgs = [], argsPrefix = []) {
  return [
    ...argsPrefix,
    "serve",
    ...(hasExplicitAuthOrDevArg(restArgs) ? [] : ["--dev"]),
    ...(hasListenArg(restArgs) ? [] : ["--listen", "ws://127.0.0.1:38080"]),
    ...restArgs,
  ];
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 */
export function parseDevArgs(argv, env = process.env, homeDir = homedir()) {
  let index = 0;
  /** @type {"web" | "desktop" | "server"} */
  let mode = "web";
  if (argv.length > 0 && !argv[0].startsWith("-")) {
    const candidate = argv[0];
    if (!VALID_DEV_MODES.has(candidate)) {
      throw new Error(`Unknown dev mode "${candidate}". Expected web, desktop, or server.`);
    }
    mode = /** @type {"web" | "desktop" | "server"} */ (candidate);
    index = 1;
  }

  let port = env?.PORT || "3015";
  let hostname = "127.0.0.1";
  let realHome = false;
  /** @type {string | undefined} */
  let home = undefined;
  /** @type {string[]} */
  const rest = [];

  for (let i = index; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--real-home") {
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
    } else if (mode !== "server" && (arg === "--port" || arg === "-p")) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      port = argv[++i];
    } else if (mode !== "server" && arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    } else if (mode !== "server" && arg.startsWith("-p=")) {
      port = arg.slice("-p=".length);
    } else if (mode !== "server" && (arg === "--hostname" || arg === "-H")) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      hostname = argv[++i];
    } else if (mode !== "server" && arg.startsWith("--hostname=")) {
      hostname = arg.slice("--hostname=".length);
    } else if (mode !== "server" && arg.startsWith("-H=")) {
      hostname = arg.slice("-H=".length);
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

  return {
    mode,
    port: String(numericPort),
    hostname: normalizedHostname,
    rest,
    ludensHome,
    realHome,
    home,
  };
}

export function buildDevExecutionPlan(argv, env = process.env, homeDir = homedir()) {
  const parsed = parseDevArgs(argv, env, homeDir);
  if (parsed.mode === "server") {
    return {
      mode: "server",
      ludensHome: parsed.ludensHome,
      devOrigin: null,
      spawnsTcpAppServer: true,
      externalServerUrl: null,
      spawnsVite: false,
      buildsDesktop: false,
      spawnsElectron: false,
      desktopDevUrl: null,
      managedServerArgs: null,
      serverArgs: buildDevServerArgs(parsed.rest),
      viteArgs: null,
    };
  }

  const devOrigin = `http://${formatOriginHost(parsed.hostname)}:${parsed.port}`;
  const viteArgs = [
    "--host",
    parsed.hostname,
    "--port",
    parsed.port,
    "--strictPort",
    ...parsed.rest,
  ];

  if (parsed.mode === "desktop") {
    return {
      mode: "desktop",
      ludensHome: parsed.ludensHome,
      devOrigin,
      spawnsTcpAppServer: false,
      externalServerUrl: null,
      spawnsVite: true,
      buildsDesktop: true,
      spawnsElectron: true,
      desktopDevUrl: devOrigin,
      managedServerArgs: null,
      serverArgs: null,
      viteArgs,
    };
  }

  const externalServerUrl = (
    env?.LUDENS_SERVER_URL?.trim() ||
    env?.LUDENS_APP_SERVER_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  const trustedOrigins = buildLoopbackTrustedOrigins(parsed.port, parsed.hostname);

  return {
    mode: "web",
    ludensHome: parsed.ludensHome,
    devOrigin,
    spawnsTcpAppServer: !externalServerUrl,
    externalServerUrl: externalServerUrl || null,
    spawnsVite: true,
    buildsDesktop: false,
    spawnsElectron: false,
    desktopDevUrl: null,
    managedServerArgs: externalServerUrl ? null : buildManagedAppServerArgs(trustedOrigins),
    serverArgs: null,
    viteArgs,
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
  const { command, argsPrefix } = resolveLudensServerCommand(repoRoot, process.env, process.platform);
  const invocation = buildServerSpawn(
    command,
    buildManagedAppServerArgs(trustedOrigins, argsPrefix),
    process.platform,
    process.env,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      LUDENS_HOME: effectiveHome,
    },
    stdio: ["pipe", "pipe", "inherit"],
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  child.stdin?.on("error", () => {});

  try {
    const url = await new Promise((resolvePromise, rejectPromise) => {
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectPromise(new Error("Timed out waiting for ludens-server handshake (15s)"));
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
            `ludens-server exited before ready handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`,
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

async function buildDesktopShell() {
  const child = spawn(
    resolveNodeBinary(process.env),
    [join(desktopRoot, "scripts/build-electron.mjs")],
    {
      cwd: desktopRoot,
      env: withBunNodePath(process.env, clientRoot),
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    throw new Error(`Building @ludens/desktop exited (${code})`);
  }
}

function resolveDesktopCommand(devOrigin, platform = process.platform) {
  const mainEntry = join(desktopRoot, "dist/electron/main.js");
  if (!existsSync(mainEntry)) {
    throw new Error(
      "Desktop bundle desktop/dist/electron/main.js is missing. Run `bun run build:desktop` first.",
    );
  }
  const desktopArgs = ["--server", devOrigin, "--show-window"];
  if (platform === "win32") {
    const exeCandidates = [
      join(desktopRoot, "node_modules/electron/dist/electron.exe"),
      join(repoRoot, "node_modules/electron/dist/electron.exe"),
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

async function runDevServerForeground(rest, effectiveHome) {
  if (!rest.includes("--help") && !rest.includes("-h")) {
    mkdirSync(effectiveHome, { recursive: true });
    console.log(`[ludens-dev] mode=server home=${effectiveHome}`);
  }
  const { command, argsPrefix } = resolveLudensServerCommand(repoRoot, process.env, process.platform);
  const invocation = buildServerSpawn(
    command,
    buildDevServerArgs(rest, argsPrefix),
    process.platform,
    process.env,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      LUDENS_HOME: effectiveHome,
    },
    stdio: "inherit",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });
    process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

async function main() {
  const {
    mode,
    port,
    hostname,
    rest,
    ludensHome: effectiveHome,
  } = parseDevArgs(process.argv.slice(2));

  if (mode === "server") {
    await runDevServerForeground(rest, effectiveHome);
    return;
  }

  const trustedOrigins = buildLoopbackTrustedOrigins(port, hostname);
  const devOrigin = `http://${formatOriginHost(hostname)}:${port}`;

  if (mode === "desktop") {
    await buildDesktopShell();
    resolveDesktopCommand(devOrigin, process.platform);
  }
  mkdirSync(effectiveHome, { recursive: true });

  let serverChild = null;
  let viteChild = null;
  let desktopChild = null;
  let appServerUrl = (
    process.env.LUDENS_SERVER_URL?.trim() ||
    process.env.LUDENS_APP_SERVER_URL?.trim()
  )?.replace(/\/+$/, "");
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
    if (mode === "web" && !appServerUrl) {
      const started = await spawnManagedAppServer(trustedOrigins, effectiveHome);
      serverChild = started.child;
      appServerUrl = started.url;
      serverChild.once("exit", (code, signal) => {
        if (!shuttingDown) {
          console.error(
            `[ludens-dev] ludens-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}); stopping vite`,
          );
          void cleanup().finally(() => {
            process.exit(code ?? 1);
          });
        }
      });
    }

    if (mode === "desktop") {
      console.log(
        `[ludens-dev] mode=desktop home=${effectiveHome} -> vite ${devOrigin} + electron (native UDS ludens-server)`,
      );
    } else {
      console.log(
        `[ludens-dev] mode=web home=${effectiveHome} server=${appServerUrl} -> vite ${devOrigin}`,
      );
    }

    const viteEnv = {
      ...withBunNodePath(process.env, clientRoot),
      LUDENS_HOME: effectiveHome,
    };
    if (mode === "desktop") {
      delete viteEnv.LUDENS_SERVER_URL;
      delete viteEnv.LUDENS_APP_SERVER_URL;
    } else if (appServerUrl) {
      viteEnv.LUDENS_SERVER_URL = appServerUrl;
      viteEnv.LUDENS_APP_SERVER_URL = appServerUrl;
    }

    viteChild = spawn(
      resolveNodeBinary(viteEnv),
      [
        resolveViteBin(clientRoot),
        "--host",
        hostname,
        "--port",
        port,
        "--strictPort",
        ...rest,
      ],
      {
        cwd: clientRoot,
        env: viteEnv,
        stdio: "inherit",
      },
    );

    const viteExitPromise = new Promise((resolvePromise, rejectPromise) => {
      viteChild.once("error", rejectPromise);
      viteChild.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });

    if (mode === "desktop") {
      const ready = await waitForDevOrigin(devOrigin, viteChild, () => shuttingDown);
      if (ready && !shuttingDown) {
        const { command, args: desktopArgs } = resolveDesktopCommand(devOrigin);
        const desktopEnv = {
          ...viteEnv,
          LUDENS_HOME: effectiveHome,
          LUDENS_DESKTOP_DEV_URL: devOrigin,
        };
        delete desktopEnv.ELECTRON_RUN_AS_NODE;
        desktopChild = spawn(command, desktopArgs, {
          cwd: desktopRoot,
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
