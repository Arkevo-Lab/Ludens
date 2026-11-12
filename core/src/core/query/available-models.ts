import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceAddress } from "@ludens/core/core/storage/workspace-state";
import { globalHome, hostRequest, workspaceForProject } from "./data";
import { repoRoot } from "./repo";
import type { LiveStatus } from "./types";
import type { OmpEffort, OmpServiceTier } from "@ludens/protocol/ludens";

export interface AvailableModelItem {
  fullId: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  authenticated: boolean;
  supportedServiceTiers: OmpServiceTier[];
  supportedEfforts: OmpEffort[];
  defaultEffort: OmpEffort | null;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  providers: { id: string; count: number; authenticated: boolean }[];
  currentModel?: string | null;
  currentServiceTier?: OmpServiceTier | null;
  currentEffort?: OmpEffort | null;
}

interface AvailableModelsLookupOptions {
  workspace?: string;
  home?: string;
  currentModel?: string | null;
  currentServiceTier?: OmpServiceTier | null;
  currentEffort?: OmpEffort | null;
}

/**
 * Spawn Bun to inspect `@oh-my-pi/pi-coding-agent` model & credential state when
 * the Dashboard query worker runs inside Node.js (Next.js `app/`).
 */
export async function listAvailableModelsViaBun(
  options: AvailableModelsLookupOptions,
  signal?: AbortSignal,
): Promise<AvailableModelsCatalog> {
  signal?.throwIfAborted();
  const script = join(repoRoot, "core", "src", "core", "agent-omp", "list-models-cli.ts");
  const child = spawn("bun", [script, "--options", JSON.stringify(options)], {
    cwd: options.workspace ?? repoRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  let terminating = false;
  let forced: ReturnType<typeof setTimeout> | undefined;

  const kill = (sig: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  const stop = (reason: unknown) => {
    if (terminating) return;
    terminating = true;
    failure = reason;
    kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const aborted = () => stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  const timeout = setTimeout(
    () => stop(Object.assign(new Error("读取可用 OMP 模型列表超时"), { status: 504 })),
    25_000,
  );
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      stop(Object.assign(new Error("可用 OMP 模型列表输出过大"), { status: 502 }));
    } else {
      target.push(chunk);
    }
  };

  child.stdout.on("data", chunk => collect(output, chunk));
  child.stderr.on("data", chunk => collect(errors, chunk));
  child.once("exit", () => {
    clearTimeout(forced);
    kill("SIGKILL");
  });
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();

  let stdout: string;
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    if (failure) throw failure;
    if (code !== 0) {
      throw Object.assign(
        new Error(Buffer.concat(errors).toString("utf8").trim() || `OMP 模型发现进程异常退出 (${code})`),
        { status: 500 },
      );
    }
    stdout = Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timeout);
    clearTimeout(forced);
    signal?.removeEventListener("abort", aborted);
    kill("SIGKILL");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("OMP 模型发现返回了无法解析的 JSON"), { status: 502 });
  }
  const record = parsed as Record<string, unknown>;
  if (!record || typeof record !== "object" || !Array.isArray(record.models) || !Array.isArray(record.providers)) {
    throw Object.assign(new Error("OMP 模型发现返回结构无效"), { status: 502 });
  }
  return parsed as AvailableModelsCatalog;
}

async function resolveCatalog(
  options: AvailableModelsLookupOptions,
  signal?: AbortSignal,
): Promise<AvailableModelsCatalog> {
  signal?.throwIfAborted();
  if ("Bun" in globalThis) {
    const modUrl = pathToFileURL(join(repoRoot, "core", "src", "core", "agent-omp", "models.ts")).href;
    const mod = (await import(modUrl)) as {
      listAvailableOmpModels: (opts?: AvailableModelsLookupOptions) => Promise<AvailableModelsCatalog>;
    };
    const result = await mod.listAvailableOmpModels(options);
    signal?.throwIfAborted();
    return result;
  }
  return listAvailableModelsViaBun(options, signal);
}

export async function availableModels(
  workspaceId?: unknown,
  home = globalHome,
  signal?: AbortSignal,
): Promise<AvailableModelsCatalog> {
  signal?.throwIfAborted();
  if (typeof workspaceId === "string" && workspaceId.trim()) {
    const id = workspaceId.trim();
    const workspace = await workspaceForProject(id, home);
    const { socket } = await resolveWorkspaceAddress(workspace);
    const live = await hostRequest<LiveStatus>(socket, { kind: "status", argv: [] }).catch(() => null);
    return resolveCatalog(
      {
        workspace,
        home,
        ...(live && "model" in live ? { currentModel: live.model ?? null } : {}),
        ...(live && "serviceTier" in live ? { currentServiceTier: live.serviceTier ?? null } : {}),
        ...(live && "effort" in live ? { currentEffort: live.effort ?? null } : {}),
      },
      signal,
    );
  }
  return resolveCatalog({ home }, signal);
}
