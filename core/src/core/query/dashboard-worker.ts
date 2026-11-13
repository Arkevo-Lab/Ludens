import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DashboardMethod, DashboardMethods, WorkerRequest, WorkerResponse } from "./dashboard-protocol";
import { archiveBudget } from "./archive-budget";
import { repoRoot } from "./repo";

type Waiting = { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };
interface WorkerOptions { file?: string; env?: NodeJS.ProcessEnv; maxPending?: number; timeoutMs?: number }
const unavailable = (message: string) => Object.assign(new Error(message), { status: 503, code: "DASHBOARD_WORKER_UNAVAILABLE" });
const defaultWorkerFile = fileURLToPath(new URL("./worker.ts", import.meta.url));

function spawnWorkerThread(file: string, env: NodeJS.ProcessEnv | undefined): Worker {
  const resourceLimits = { maxOldGenerationSizeMb: archiveBudget(env).readerHeapMiB };
  if (process.versions.bun || !file.endsWith(".ts")) {
    return Reflect.construct(Worker, [file, { execArgv: [], env, resourceLimits }]) as Worker;
  }
  const appPkg = join(repoRoot, "app/package.json");
  const reqAnchor = existsSync(appPkg) ? pathToFileURL(appPkg).href : import.meta.url;
  const evalCode = [
    `const { createRequire } = require("node:module");`,
    `const { pathToFileURL } = require("node:url");`,
    `const req = createRequire(${JSON.stringify(reqAnchor)});`,
    `const tsx = req("tsx/cjs/api");`,
    `tsx.require(${JSON.stringify(file)}, pathToFileURL(${JSON.stringify(file)}).href);`,
  ].join("\n");
  return Reflect.construct(Worker, [evalCode, { eval: true, execArgv: [], env, resourceLimits }]) as Worker;
}

/** One isolated archive reader per server instance, with no retained completed Promise chain. */
export class DashboardWorker {
  private worker?: Worker;
  private waiting = new Map<number, Waiting>();
  private sequence = 0;
  private closed = false;
  constructor(private options: WorkerOptions = {}) {}
  get pendingCount() { return this.waiting.size; }

  private start() {
    if (this.closed) throw unavailable("Dashboard reader is closed");
    if (this.worker) return this.worker;
    const file = this.options.file ?? defaultWorkerFile;
    const worker = spawnWorkerThread(file, this.options.env);
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => {
      if (message.type === "ready") return;
      const entry = this.waiting.get(message.id);
      if (!entry) return;
      this.waiting.delete(message.id); entry.cleanup();
      if (!this.waiting.size) worker.unref();
      if (message.type === "error") entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.value);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.rejectAll(unavailable(`Dashboard reader stopped: ${error.message}`));
    };
    worker.on("error", failed);
    worker.on("exit", code => failed(new Error(`worker exited (${code})`)));
    worker.unref();
    return worker;
  }
  private rejectAll(error: Error) {
    for (const entry of this.waiting.values()) { entry.cleanup(); entry.reject(error); }
    this.waiting.clear();
  }
  call<K extends DashboardMethod>(method: K, args: DashboardMethods[K]["args"], signal?: AbortSignal): Promise<DashboardMethods[K]["result"]> {
    signal?.throwIfAborted();
    if (this.waiting.size >= (this.options.maxPending ?? 64)) return Promise.reject(unavailable("Dashboard reader is busy; retry shortly"));
    const worker = this.start(), id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error: unknown) => {
        const entry = this.waiting.get(id);
        if (!entry) return;
        this.waiting.delete(id); entry.cleanup();
        try { worker.postMessage({ type: "cancel", id } satisfies WorkerRequest); } catch { /* worker already exited */ }
        if (!this.waiting.size) worker.unref();
        reject(error);
      };
      const aborted = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(unavailable("Dashboard reader timed out")), this.options.timeoutMs ?? 60_000);
      this.waiting.set(id, { resolve: value => resolve(value as DashboardMethods[K]["result"]), reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); } });
      signal?.addEventListener("abort", aborted, { once: true });
      worker.ref();
      try { worker.postMessage({ type: "call", id, method, args } satisfies WorkerRequest); }
      catch (error) { finish(error); }
    });
  }
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.rejectAll(unavailable("Dashboard reader is closing"));
    if (!worker) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { void worker.terminate(); }, 5000);
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
      worker.ref();
      try { worker.postMessage({ type: "close" } satisfies WorkerRequest); } catch { void worker.terminate(); }
    });
  }
}

const key = Symbol.for("ludens.dashboard.reader-worker");
export function dashboardWorker(): DashboardWorker {
  return ((globalThis as any)[key] ??= new DashboardWorker()) as DashboardWorker;
}
