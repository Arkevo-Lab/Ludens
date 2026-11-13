import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "app",
  "shell",
  "features",
  "components",
  "lib",
  "messages",
  "scripts",
  "public",
  "package.json",
  "../package.json",
  "../bun.lock",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "../protocol",
  "../core/src",
];

export function resolveBunBinary(env = process.env, platform = process.platform, home = homedir()) {
  if (env.LUDENS_BUN?.trim()) return env.LUDENS_BUN.trim();
  const binName = platform === "win32" ? "bun.exe" : "bun";
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, binName);
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks = [
    join(home, ".bun", "bin", binName),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]),
  ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return binName;
}

export function withBunNodePath(env = process.env, appRoot = directory) {
  const bunNodeModules = resolve(appRoot, "../node_modules/.bun/node_modules");
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
  await access(join(root, "out/index.html"));
  hash ??= await sourceHash(root);
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "out/.ludens-build.json"), JSON.stringify({ hash }) + "\n");
}

export async function checkBuild(root = directory) {
  try {
    const [saved, , hash] = await Promise.all([
      readFile(join(root, "out/.ludens-build.json"), "utf8").then(JSON.parse),
      access(join(root, "out/index.html")),
      sourceHash(root),
    ]);
    if (saved && typeof saved.hash === "string" && saved.hash === hash) return;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  throw new Error(`Dashboard production build is missing or stale. Run: npm --prefix ${root} run build`);
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

export async function cleanStaleDevTypes(root = directory) {
  await rm(join(root, ".next/dev/types"), { recursive: true, force: true });
}

async function nextBuild(args) {
  await cleanStaleDevTypes(directory);
  const env = withBunNodePath(process.env, directory);
  delete env.LUDENS_NEXT_DEV;
  delete env.LUDENS_APP_SERVER_URL;
  await runProcess(
    process.execPath,
    [join(directory, "node_modules/next/dist/bin/next"), "build", ...args],
    { env, label: "Next build" },
  );
}

async function nextTypegen(args) {
  await cleanStaleDevTypes(directory);
  const env = withBunNodePath(process.env, directory);
  await runProcess(
    process.execPath,
    [join(directory, "node_modules/next/dist/bin/next"), "typegen", ...args],
    { env, label: "Next typegen" },
  );
}

function hasPortArg(args) {
  return args.some(arg => arg === "--port" || arg === "-p" || arg.startsWith("--port=") || arg.startsWith("-p="));
}

function hasStaticDirArg(args) {
  return args.some(arg => arg === "--static-dir" || arg.startsWith("--static-dir="));
}

async function startAppServer(args) {
  const bun = resolveBunBinary();
  const cliEntry = join(directory, "../core/src/cli/main.ts");
  const serverArgs = [
    cliEntry,
    "app-server",
    ...(hasPortArg(args) ? [] : ["--port", "3015"]),
    ...(hasStaticDirArg(args) ? [] : ["--static-dir", join(directory, "out")]),
    ...args,
  ];
  await runProcess(bun, serverArgs, {
    cwd: resolve(directory, ".."),
    env: process.env,
    label: "ludens app-server",
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "build") {
    const before = await sourceHash();
    await nextBuild(args);
    if ((await sourceHash()) !== before) {
      throw new Error("Dashboard source changed during build; run the build again.");
    }
    await stampBuild(directory, before);
  } else if (mode === "typegen") {
    await nextTypegen(args);
  } else if (mode === "check") {
    await checkBuild();
  } else if (mode === "start") {
    await checkBuild();
    await startAppServer(args);
  } else {
    throw new Error("Use production.mjs build | typegen | check | start");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
