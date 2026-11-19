import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the repository root whether this module runs from the source tree or from an
 * installed (copied) workspace package, where `import.meta.url` points into a store.
 * Path arithmetic on the module file keeps bundlers from rewriting the URL statically.
 */
export const repoRoot = (() => {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  return (
    candidates.find(
      root =>
        existsSync(join(root, "core", "package.json")) &&
        existsSync(join(root, "server", "package.json")),
    ) ?? candidates[0]!
  );
})();

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
