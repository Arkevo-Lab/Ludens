import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function defaultSocket(workspace = process.cwd()): Promise<string> {
  const canonical = await realpath(resolve(workspace));
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const uid = process.getuid?.() ?? "user";
  const dir = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(dir, `ludens-baseware-${uid}-${id}.sock`);
}
