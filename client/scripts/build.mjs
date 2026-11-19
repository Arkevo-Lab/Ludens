import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sources = [
  "app",
  "shell",
  "features",
  "components",
  "lib",
  "messages",
  "scripts",
  "public",
  "index.html",
  "package.json",
  "../package.json",
  "../bun.lock",
  "vite.config.ts",
  "vite-env.d.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "../protocol",
];

export function resolveNodeBinary(env = process.env, platform = process.platform) {
  const binName = platform === "win32" ? "node.exe" : "node";
  const pathSep = platform === "win32" ? ";" : delimiter;
  for (const entry of (env.PATH ?? "").split(pathSep).filter(Boolean)) {
    const candidate = join(entry, binName);
    if (existsSync(candidate)) return candidate;
  }
  if (platform !== "win32") {
    for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.execPath;
}

export function resolveViteBin(clientRoot = directory) {
  const candidates = [
    join(clientRoot, "node_modules/vite/bin/vite.js"),
    resolve(clientRoot, "../node_modules/vite/bin/vite.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
}

export function withBunNodePath(env = process.env, clientRoot = directory) {
  const bunNodeModules = resolve(clientRoot, "../node_modules/.bun/node_modules");
  const nodePath = [bunNodeModules, env.NODE_PATH].filter(Boolean).join(delimiter);
  return { ...env, NODE_PATH: nodePath };
}

export async function sourceHash(root = directory) {
  const hash = createHash("sha256");
  async function visit(path) {
    let entries;
    try {
      entries = await readdir(join(root, path), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "ENOTDIR") throw error;
      hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() || entry.isDirectory()) await visit(join(path, entry.name));
    }
  }
  for (const path of sources) await visit(path);
  return hash.digest("hex");
}

export async function stampBuild(root = directory, hash) {
  await access(join(root, "dist/index.html"));
  hash ??= await sourceHash(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist/.ludens-build.json"), JSON.stringify({ hash }) + "\n");
}

export async function checkBuild(root = directory) {
  try {
    const [saved, , hash] = await Promise.all([
      readFile(join(root, "dist/.ludens-build.json"), "utf8").then(JSON.parse),
      access(join(root, "dist/index.html")),
      sourceHash(root),
    ]);
    if (saved && typeof saved.hash === "string" && saved.hash === hash) return;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  throw new Error(
    "Client production build in client/dist is missing or stale. Run: bun run build:client",
  );
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: directory,
    stdio: "inherit",
    ...options,
  });
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const term = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  try {
    const code = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });
    if (code !== 0) throw new Error(`${options.label ?? command} exited (${code})`);
  } finally {
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
  }
}

export async function runClientBuild(args = [], root = directory) {
  const before = await sourceHash(root);
  const env = withBunNodePath(process.env, root);
  delete env.LUDENS_SERVER_URL;
  delete env.LUDENS_APP_SERVER_URL;
  await runProcess(
    resolveNodeBinary(env),
    [resolveViteBin(root), "build", ...args],
    { cwd: root, env, label: "Vite build" },
  );
  if ((await sourceHash(root)) !== before) {
    throw new Error("Client source changed during build; run the build again.");
  }
  await stampBuild(root, before);
}

async function main() {
  const [mode = "build", ...args] = process.argv.slice(2);
  if (mode === "build") {
    await runClientBuild(args, directory);
  } else if (mode === "check") {
    await checkBuild(directory);
  } else {
    throw new Error("Use build.mjs build | check");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
