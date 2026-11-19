import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ludensHome,
  readWorkspaceIdentity,
  type RegisteredWorkspace,
} from "@ludens/protocol/ludens";
import {
  NodeUdsRpcClient,
  WsAppRpcClient,
  type AppRpcClient,
} from "./app-rpc-client.ts";
import {
  readAppServerRuntimeInfo,
  resolveAppServerSocketPath,
} from "./app-server-paths.ts";

export interface RemoteConnectionConfig {
  url: string;
  token?: string;
}

export interface ServerCommandSpec {
  command: string;
  argsPrefix: string[];
}

export interface OperatorRpcOptions {
  home?: string;
  remote?: RemoteConnectionConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clientRoot?: string;
  connectTimeoutMs?: number;
  exists?: (path: string) => boolean;
  startLocalServer?: (home: string, spec: ServerCommandSpec) => Promise<void>;
  createUdsClient?: (socketPath: string) => AppRpcClient & { connect?: () => Promise<unknown> };
  createWsClient?: (remote: RemoteConnectionConfig) => AppRpcClient & { connect?: () => Promise<unknown> };
}

const DEFAULT_CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function extractRemoteArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  seed?: { remoteUrl?: string; token?: string },
): { remaining: string[]; remote?: RemoteConnectionConfig } {
  const remaining: string[] = [];
  let remoteUrl: string | undefined = seed?.remoteUrl;
  let token: string | undefined = seed?.token;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--remote") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--remote requires a URL (e.g. ws://host:port/rpc or http://host:port)");
      }
      remoteUrl = next;
      i++;
      continue;
    }
    if (arg.startsWith("--remote=")) {
      remoteUrl = arg.slice("--remote=".length);
      if (!remoteUrl) throw new Error("--remote requires a non-empty URL");
      continue;
    }
    if (arg === "--token") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--token requires a secret value");
      }
      token = next;
      i++;
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    remaining.push(arg);
  }

  const effectiveUrl = remoteUrl ?? (env.LUDENS_REMOTE_URL?.trim() || undefined);
  const effectiveToken = token ?? (env.LUDENS_REMOTE_TOKEN?.trim() || undefined);

  return {
    remaining,
    ...(effectiveUrl
      ? { remote: { url: effectiveUrl, ...(effectiveToken ? { token: effectiveToken } : {}) } }
      : {}),
  };
}

function resolveBunBinary(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  if (env.LUDENS_BUN?.trim()) return env.LUDENS_BUN.trim();
  const binName = platform === "win32" ? "bun.exe" : "bun";
  const sep = platform === "win32" ? ";" : ":";
  for (const entry of (env.PATH ?? "").split(sep).filter(Boolean)) {
    const candidate = join(entry, binName);
    if (exists(candidate)) return candidate;
  }
  const fallbacks = [
    join(homedir(), ".bun", "bin", binName),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]),
  ];
  for (const candidate of fallbacks) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the `ludens-server` executable for on-demand local daemon wakeup.
 * Resolution order:
 *   1. `LUDENS_SERVER_BIN` environment variable
 *   2. `ludens-server` on `PATH`
 *   3. Monorepo development fallback `../server/bin/ludens-server` (or `bun ../server/src/cli/main.ts`)
 * Returns `null` when `ludens-server` is not installed on this machine.
 */
export function resolveLocalLudensServerCommand(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clientRoot?: string;
  exists?: (path: string) => boolean;
} = {}): ServerCommandSpec | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const clientRoot = options.clientRoot ?? DEFAULT_CLIENT_ROOT;
  const exists = options.exists ?? existsSync;

  const explicit = env.LUDENS_SERVER_BIN?.trim();
  if (explicit) {
    return { command: explicit, argsPrefix: [] };
  }

  const sep = platform === "win32" ? ";" : delimiter;
  const binNames =
    platform === "win32"
      ? ["ludens-server.exe", "ludens-server.cmd", "ludens-server.bat", "ludens-server"]
      : ["ludens-server"];
  for (const entry of (env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const binName of binNames) {
      const candidate = join(entry, binName);
      if (exists(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    }
  }

  // Prefer executing the monorepo server TS entry directly via Bun (avoids spawning Windows .cmd shims).
  const repoEntry = resolve(clientRoot, "../server/src/cli/main.ts");
  if (exists(repoEntry)) {
    const bun = resolveBunBinary(env, platform, exists) ?? (platform === "win32" ? "bun.exe" : "bun");
    return { command: bun, argsPrefix: [repoEntry] };
  }

  const repoBin = resolve(
    clientRoot,
    "../server/bin",
    platform === "win32" ? "ludens-server.cmd" : "ludens-server",
  );
  if (exists(repoBin)) {
    return { command: repoBin, argsPrefix: [] };
  }

  return null;
}

export function buildServerSpawnInvocation(
  spec: ServerCommandSpec,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const fullArgs = [...spec.argsPrefix, ...args];
  if (platform === "win32" && /\.(cmd|bat)$/i.test(spec.command)) {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", spec.command, ...fullArgs],
    };
  }
  return { command: spec.command, args: fullArgs };
}

function isLocalSocketUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  if (err.code && ["ENOENT", "ECONNREFUSED", "EPIPE", "ENOTSOCK"].includes(err.code)) {
    return true;
  }
  const message = err.message ?? "";
  return (
    message.includes("Timed out connecting to UDS socket") ||
    message.includes("UDS RPC connection closed")
  );
}

async function runStartLocalServer(
  home: string,
  spec: ServerCommandSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const invocation = buildServerSpawnInvocation(spec, ["start"], platform, env);
  await new Promise<void>((resolveStart, rejectStart) => {
    const child = spawn(invocation.command, invocation.args, {
      env: { ...env, LUDENS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", error => {
      rejectStart(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveStart();
        return;
      }
      const detail = (stderr || stdout).trim();
      rejectStart(
        new Error(
          `Failed to start local ludens-server (exit=${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

function formatServerMissingError(socketPath: string): Error {
  return new Error(
    `Local ludens-server is not running (socket: ${socketPath}) and 'ludens-server' was not found on PATH. ` +
      `Install or start 'ludens-server' (e.g. 'ludens-server start'), or connect to a remote server with ` +
      `'--remote <ws(s)://host:port> [--token <secret>]' (or LUDENS_REMOTE_URL).`,
  );
}

export async function withOperatorRpc<T>(
  options: OperatorRpcOptions,
  run: (client: AppRpcClient, mode: "remote" | "uds") => Promise<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const connectTimeoutMs = options.connectTimeoutMs ?? 3_000;

  if (options.remote?.url) {
    const client = options.createWsClient
      ? options.createWsClient(options.remote)
      : new WsAppRpcClient({
          url: options.remote.url,
          token: options.remote.token,
          connectTimeoutMs,
        });
    try {
      if (client.connect) await client.connect();
      return await run(client, "remote");
    } finally {
      await client.close().catch(() => {});
    }
  }

  const home = resolve(options.home ?? ludensHome(env));
  const runtimeInfo = await readAppServerRuntimeInfo(home);
  const initialSocketPath = runtimeInfo?.socketPath ?? resolveAppServerSocketPath(home);

  const openUdsClient = async (socketPath: string) => {
    const client = options.createUdsClient
      ? options.createUdsClient(socketPath)
      : new NodeUdsRpcClient({ socketPath, connectTimeoutMs });
    try {
      if (client.connect) await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  };

  let client: AppRpcClient;
  try {
    client = await openUdsClient(initialSocketPath);
  } catch (connectError) {
    if (!isLocalSocketUnavailableError(connectError)) {
      throw connectError;
    }
    const serverSpec = resolveLocalLudensServerCommand({
      env,
      platform,
      clientRoot: options.clientRoot,
      exists: options.exists,
    });
    if (!serverSpec) {
      throw formatServerMissingError(initialSocketPath);
    }

    try {
      if (options.startLocalServer) {
        await options.startLocalServer(home, serverSpec);
      } else {
        await runStartLocalServer(home, serverSpec, env, platform);
      }
    } catch (startError) {
      if ((startError as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw formatServerMissingError(initialSocketPath);
      }
      throw startError;
    }

    const updatedRuntime = await readAppServerRuntimeInfo(home);
    const reconnectSocketPath = updatedRuntime?.socketPath ?? resolveAppServerSocketPath(home);
    client = await openUdsClient(reconnectSocketPath);
  }

  try {
    return await run(client, "uds");
  } finally {
    await client.close().catch(() => {});
  }
}

export async function resolveWorkspaceTargetViaRpc(
  client: AppRpcClient,
  selectedWorkspace: string,
  explicitWorkspace: boolean,
): Promise<{ id: string; workspace: string }> {
  const settings = (await client.call("workspaces/getSettings")) as {
    workspaces?: RegisteredWorkspace[];
  };
  const registered = Array.isArray(settings.workspaces) ? settings.workspaces : [];

  const findByCandidate = (candidate: string): RegisteredWorkspace | undefined =>
    registered.find(
      entry =>
        entry.id === candidate ||
        entry.workspace === candidate ||
        entry.name === candidate,
    );

  if (explicitWorkspace) {
    const direct = findByCandidate(selectedWorkspace);
    if (direct) return { id: direct.id, workspace: direct.workspace };

    const canonical = await realpath(selectedWorkspace).catch(() => resolve(selectedWorkspace));
    const byCanonical = findByCandidate(canonical);
    if (byCanonical) return { id: byCanonical.id, workspace: byCanonical.workspace };

    try {
      const localIdentity = await readWorkspaceIdentity(canonical);
      const byIdentity = findByCandidate(localIdentity.id);
      if (byIdentity) return { id: byIdentity.id, workspace: byIdentity.workspace };
    } catch {
      // Selected workspace may live only on the remote host.
    }

    throw new Error(`Workspace '${selectedWorkspace}' was not found on the server`);
  }

  const canonicalCwd = await realpath(selectedWorkspace).catch(() => resolve(selectedWorkspace));
  const cwdDirect = findByCandidate(canonicalCwd);
  if (cwdDirect) return { id: cwdDirect.id, workspace: cwdDirect.workspace };

  try {
    const localIdentity = await readWorkspaceIdentity(canonicalCwd);
    const byIdentity = findByCandidate(localIdentity.id);
    if (byIdentity) return { id: byIdentity.id, workspace: byIdentity.workspace };
  } catch {
    // Current directory need not be a local workspace when operating remotely.
  }

  if (registered.length === 1) {
    const only = registered[0]!;
    return { id: only.id, workspace: only.workspace };
  }

  throw new Error(
    registered.length === 0
      ? "No workspaces are registered on the server"
      : "Multiple workspaces registered; specify --workspace <id|path>",
  );
}
