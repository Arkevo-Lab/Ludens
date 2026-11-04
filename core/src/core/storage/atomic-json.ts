import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
