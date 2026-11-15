import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

export interface WorkerReply {
  id: string; ok: boolean; result?: unknown;
  error?: { type: string; message: string; traceback?: string };
}

const STOP_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 5_000;

/** JSON-line transport and bounded process-group cleanup shared by resident Python entries. */
export class PythonWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  expectedExit = false;
  private stopping?: Promise<void>;
  private readonly finishExit: (error: Error) => void;
  private pending = new Map<string, { resolve(reply: WorkerReply): void; reject(error: Error): void }>();

  constructor(readonly generation: string, options: {
    executable: string; module: string; workspace: string; env: NodeJS.ProcessEnv; stderrPath: string;
    onEvent(event: any): void; onExit(error: Error): void;
  }) {
    this.process = spawn(options.executable, ["-u", "-m", options.module], {
      cwd: options.workspace, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.process;
    const stderr = createWriteStream(options.stderrPath);
    child.stderr.pipe(stderr);
    let tail = "", finished = false;
    child.stderr.on("data", data => { tail = (tail + data.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout.setEncoding("utf8"), crlfDelay: Infinity });
    lines.on("line", line => {
      let reply: WorkerReply & { event?: string };
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.event) { options.onEvent(reply); return; }
      const pending = this.pending.get(reply.id);
      if (pending) { this.pending.delete(reply.id); pending.resolve(reply); }
    });
    const exited = Promise.withResolvers<void>();
    this.exited = exited.promise;
    this.finishExit = error => {
      if (finished) return;
      finished = true;
      lines.close(); stderr.end();
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      exited.resolve();
      options.onExit(error);
    };
    child.once("error", this.finishExit);
    child.once("close", (code, signal) => this.finishExit(new Error(`Python worker exited (${signal ?? code})${tail ? `: ${tail.trim()}` : ""}`)));
  }

  request(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerReply> {
    if (this.expectedExit) return Promise.reject(new Error("Python worker is stopping"));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.pending.delete(id); cleanup(); reject(signal?.reason ?? new Error("Worker request cancelled")); };
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup();
        reject(new Error(`Python worker ${message.action} timed out after ${timeoutMs} ms; repair the implementation and reload it.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: reply => { cleanup(); resolve(reply); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.process.stdin.write(JSON.stringify({ ...message, id }) + "\n", "utf8", error => {
        if (!error) return;
        const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(error);
      });
    });
  }

  stop(): Promise<void> {
    this.expectedExit = true;
    return this.stopping ??= this.stopProcess();
  }

  private async stopProcess() {
    // Closing stdin gives Python a chance to finish recording on either platform.
    this.process.stdin.end();
    if (await this.waitForExit(STOP_GRACE_MS)) return;
    const { pid } = this.process;
    if (pid !== undefined) {
      if (process.platform === "win32") {
        // A Windows Python virtualenv launcher can have its own Python child.
        if (!this.processHasExited()) {
          await new Promise<void>(resolve => {
            execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, timeout: STOP_TIMEOUT_MS }, () => resolve());
          });
        }
      } else {
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    if (this.closeExitedTransport() || await this.waitForExit(STOP_TIMEOUT_MS) || this.closeExitedTransport()) return;
    throw new Error("Python worker did not exit after shutdown");
  }

  private processHasExited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null;
  }

  private closeExitedTransport(): boolean {
    if (!this.processHasExited()) return false;
    // A confirmed process exit can precede stdio closure indefinitely.
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.finishExit(new Error("Python worker exited during shutdown"));
    return true;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
