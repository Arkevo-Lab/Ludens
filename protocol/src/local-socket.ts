import { execFile } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { promisify } from "node:util";
import { pythonExecutable } from "./python.ts";

const run = promisify(execFile);

async function listenerExists(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path);
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Could not determine whether the socket is in use: ${path}`));
    }, 1000);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/** Remove a socket left by an exited local server, but never a live socket or other file. */
export async function clearStaleLocalSocket(path: string, inUse: () => Error): Promise<void> {
  let needsWindowsCheck = false;
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error(`Not a Unix socket: ${path}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (process.platform !== "win32" || code !== "EACCES") throw error;
    needsWindowsCheck = true;
  }

  if (await listenerExists(path)) throw inUse();
  if (needsWindowsCheck) {
    // libuv's lstat reports EACCES for Winsock AF_UNIX reparse points.
    // Python's Windows lstat exposes the tag without following the reparse point.
    const { stdout } = await run(pythonExecutable(), ["-c", [
      "import os, sys",
      "try:",
      "    print(os.lstat(sys.argv[1]).st_reparse_tag == 0x80000023)",
      "except FileNotFoundError:",
      "    print('missing')",
    ].join("\n"), path], { timeout: 3000, windowsHide: true });
    if (stdout.trim() === "missing") return;
    if (stdout.trim() !== "True") throw new Error(`Not a Unix socket: ${path}`);
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
