import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunBinary, resolveViteBin, withBunNodePath } from "./production.mjs";

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

export function parseDevArgs(argv) {
  let port = process.env.PORT || "3015";
  let hostname = "127.0.0.1";
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
  return { port: String(numericPort), hostname: normalizedHostname, rest };
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

async function spawnManagedAppServer(trustedOrigins) {
  const bun = resolveBunBinary();
  const cliEntry = join(directory, "../core/src/cli/main.ts");
  const originFlags = (Array.isArray(trustedOrigins) ? trustedOrigins : [trustedOrigins]).flatMap(
    origin => ["--trusted-origin", origin],
  );
  const child = spawn(
    bun,
    [
      cliEntry,
      "app-server",
      "--port",
      "0",
      "--parent-watchdog",
      ...originFlags,
    ],
    {
      cwd: resolve(directory, ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
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
          new Error(`ludens app-server exited before ready handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`),
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

async function main() {
  const { port, hostname, rest } = parseDevArgs(process.argv.slice(2));
  const trustedOrigins = buildLoopbackTrustedOrigins(port, hostname);
  const devOrigin = `http://${formatOriginHost(hostname)}:${port}`;

  let serverChild = null;
  let viteChild = null;
  let appServerUrl = process.env.LUDENS_APP_SERVER_URL?.trim().replace(/\/+$/, "");
  let shuttingDown = false;
  let cleanupPromise = null;

  const cleanup = () => {
    shuttingDown = true;
    cleanupPromise ??= (async () => {
      if (viteChild && viteChild.exitCode === null && viteChild.signalCode === null) {
        try {
          viteChild.kill("SIGTERM");
        } catch {}
      }
      await Promise.all([
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
      const started = await spawnManagedAppServer(trustedOrigins);
      serverChild = started.child;
      appServerUrl = started.url;
      console.log(`[ludens-dev] app-server=${appServerUrl} -> vite ${devOrigin}`);
      serverChild.once("exit", (code, signal) => {
        if (!shuttingDown) {
          console.error(`[ludens-dev] app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}); stopping vite`);
          void cleanup().finally(() => {
            process.exit(code ?? 1);
          });
        }
      });
    }

    const env = {
      ...withBunNodePath(process.env, directory),
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

    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      viteChild.once("error", rejectPromise);
      viteChild.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });
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
