import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unique local-socket address for tests: a Named Pipe on Windows (Node/Bun cannot
 * `listen()` on a plain filesystem path there) and a short `.sock` under the OS temp
 * directory elsewhere (kept well below the ~104-byte `sun_path` limit).
 */
export function testSocketPath(label: string): string {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ludens-test-${label}-${id}`
    : join(tmpdir(), `lt-${label}-${id}.sock`);
}

/** Unique scratch file path under the OS temp directory. */
export function testTempPath(label: string, extension = ""): string {
  return join(tmpdir(), `ludens-${label}-${crypto.randomUUID()}${extension}`);
}
