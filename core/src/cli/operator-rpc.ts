import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ludensHome,
  readWorkspaceIdentity,
  type RegisteredWorkspace,
} from "@ludens/protocol/ludens";
import { ensureLocalAppDaemon } from "../daemon/app-daemon.ts";
import {
  NodeUdsRpcClient,
  WsAppRpcClient,
  type AppRpcClient,
} from "./app-rpc-client.ts";

export interface RemoteConnectionConfig {
  url: string;
  token?: string;
}

export function extractRemoteArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { remaining: string[]; remote?: RemoteConnectionConfig } {
  const remaining: string[] = [];
  let remoteUrl: string | undefined;
  let token: string | undefined;

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
    ...(effectiveUrl ? { remote: { url: effectiveUrl, ...(effectiveToken ? { token: effectiveToken } : {}) } } : {}),
  };
}

export async function withOperatorRpc<T>(
  options: { home?: string; remote?: RemoteConnectionConfig },
  run: (client: AppRpcClient, mode: "remote" | "uds") => Promise<T>,
): Promise<T> {
  if (options.remote?.url) {
    const client = new WsAppRpcClient({
      url: options.remote.url,
      token: options.remote.token,
    });
    try {
      await client.connect();
      return await run(client, "remote");
    } finally {
      await client.close().catch(() => {});
    }
  }

  const home = resolve(options.home ?? ludensHome());
  const { runtime } = await ensureLocalAppDaemon({ home });
  if (!runtime.socketPath) {
    throw new Error(`Local app-daemon for ${home} does not expose a UDS socket`);
  }
  const client = new NodeUdsRpcClient({ socketPath: runtime.socketPath });
  try {
    await client.connect();
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
