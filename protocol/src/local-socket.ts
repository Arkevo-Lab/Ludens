import { execFile } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { promisify } from "node:util";
import { pythonExecutable } from "./python.ts";

const run = promisify(execFile);
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const IO_REPARSE_TAG_AF_UNIX = 0x80000023;
const INVALID_HANDLE = -1n;

export function isWindowsNamedPipe(path: string): boolean {
  return process.platform === "win32" && path.startsWith("\\\\.\\pipe\\");
}

export function localServiceSocketPath(
  service: "core" | "baseware",
  workspaceHash: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") {
    const rawUser = environment.USERNAME || environment.USER || "user";
    const user = rawUser.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
    return `\\\\.\\pipe\\ludens-${service}-${user}-${workspaceHash}`;
  }
  const uid = process.getuid?.() ?? "user";
  return `/tmp/ludens-${service}-${uid}-${workspaceHash}.sock`;
}

type Kernel32FindApi = {
  FindFirstFileW: (fileName: Uint8Array, findData: Uint8Array) => bigint;
  FindClose: (handle: bigint) => number;
};

let cachedKernel32Find: Kernel32FindApi | undefined;

async function getKernel32Find(): Promise<Kernel32FindApi | undefined> {
  if (cachedKernel32Find) return cachedKernel32Find;
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return undefined;
  const bunFfiModule: string = "bun:ffi";
  const ffi = (await import(bunFfiModule)) as {
    dlopen: (lib: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: unknown };
    FFIType: Record<string, unknown>;
  };
  const lib = ffi.dlopen("kernel32.dll", {
    FindFirstFileW: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i64 },
    FindClose: { args: [ffi.FFIType.i64], returns: ffi.FFIType.i32 },
  });
  cachedKernel32Find = lib.symbols as Kernel32FindApi;
  return cachedKernel32Find;
}

async function inspectWindowsUnixSocket(path: string): Promise<"missing" | "socket" | "other"> {
  const kernel32 = await getKernel32Find();
  if (kernel32) {
    const encoded = Buffer.from(`${path}\0`, "utf16le");
    const findData = Buffer.alloc(592);
    const handle = kernel32.FindFirstFileW(encoded, findData);
    if (handle === INVALID_HANDLE || handle === 0n) {
      return "missing";
    }
    kernel32.FindClose(handle);
    const attributes = findData.readUInt32LE(0);
    const reparseTag = findData.readUInt32LE(36);
    return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 && reparseTag === IO_REPARSE_TAG_AF_UNIX
      ? "socket"
      : "other";
  }

  // Fallback for non-Bun runtimes where libuv lstat returns EACCES on AF_UNIX reparse points.
  const { stdout } = await run(pythonExecutable(), ["-c", [
    "import os, sys",
    "try:",
    "    st = os.lstat(sys.argv[1])",
    "    print('socket' if getattr(st, 'st_reparse_tag', 0) == 0x80000023 else 'other')",
    "except FileNotFoundError:",
    "    print('missing')",
  ].join("\n"), path], { timeout: 3000, windowsHide: true });
  const trimmed = stdout.trim();
  if (trimmed === "missing") return "missing";
  return trimmed === "socket" ? "socket" : "other";
}

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
  if (isWindowsNamedPipe(path)) {
    if (await listenerExists(path)) throw inUse();
    return;
  }

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
    const status = await inspectWindowsUnixSocket(path);
    if (status === "missing") return;
    if (status !== "socket") throw new Error(`Not a Unix socket: ${path}`);
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
