import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { localServiceSocketPath } from "@ludens/protocol/local-socket";

export async function defaultSocket(workspace = process.cwd()): Promise<string> {
  const canonical = await realpath(resolve(workspace));
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return localServiceSocketPath("baseware", id);
}
