import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the repository root whether this module runs from the source tree, a bundled
 * packaged resource directory (e.g. `Resources/server/main.js`), or an installed workspace
 * package where `import.meta.url` points into a store.
 * Path arithmetic on the module file keeps bundlers from rewriting the URL statically.
 */
export function resolveRepoRoot(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const explicit = env.LUDENS_REPO_ROOT?.trim();
  const candidates = [
    ...(explicit ? [resolve(explicit)] : []),
    resolve(moduleDir, "../../.."),
    resolve(moduleDir, "../.."),
    resolve(moduleDir, ".."),
    resolve(cwd, ".."),
    cwd,
  ];
  return (
    candidates.find(
      root =>
        existsSync(join(root, "core", "package.json")) &&
        existsSync(join(root, "server", "package.json")),
    ) ?? candidates[0]!
  );
}

export const repoRoot = resolveRepoRoot();

/** Resolve the installed `@ludens/core` package root directory. */
export const corePackageRoot = (() => {
  try {
    const resolved = import.meta.resolve("@ludens/core/package.json");
    if (resolved.startsWith("file://")) {
      return dirname(fileURLToPath(resolved));
    }
  } catch {
    // Fallback to monorepo sibling layout.
  }
  return join(repoRoot, "core");
})();
