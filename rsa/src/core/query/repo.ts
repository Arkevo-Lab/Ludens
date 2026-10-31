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
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
    resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  // The marker pair rejects a package store's @ludens scope directory, which also
  // contains a bare `rsa/package.json` but never the dashboard workspace.
  return candidates.find(root => existsSync(join(root, "rsa", "package.json"))
    && existsSync(join(root, "rsa-dashboard", "package.json"))) ?? candidates[0];
})();
