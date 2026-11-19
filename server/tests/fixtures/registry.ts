import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWorkspace } from "@ludens/protocol/ludens";

/** Register only disposable fixture directories; never use the caller's global home. */
export async function registerFixture(home: string, id: string, workspace: string) {
  await mkdir(join(workspace, ".ludens"), { recursive: true });
  await writeFile(join(workspace, ".ludens", "workspace.json"), JSON.stringify({ version: 1, id }));
  return registerWorkspace(workspace, home);
}
