import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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

export function resolveLudensServerCommand(
  clientRoot = directory,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  if (env.LUDENS_SERVER_BIN?.trim()) {
    return { command: env.LUDENS_SERVER_BIN.trim(), argsPrefix: [] };
  }
  const binNames =
    platform === "win32"
      ? ["ludens-server.exe", "ludens-server.cmd", "ludens-server.bat", "ludens-server"]
      : ["ludens-server"];

  const pathSep = platform === "win32" ? ";" : delimiter;
  const pathEntries = (env.PATH ?? "").split(pathSep).filter(Boolean);
  for (const entry of pathEntries) {
    for (const binName of binNames) {
      const candidate = join(entry, binName);
      if (exists(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    }
  }

  // Prefer executing the monorepo server TS entry directly via Bun (avoids spawning Windows .cmd shims).
  const repoEntry = resolve(clientRoot, "../server/src/cli/main.ts");
  if (exists(repoEntry)) {
    return { command: resolveBunBinary(env, platform), argsPrefix: [repoEntry] };
  }

  const repoBin = resolve(
    clientRoot,
    "../server/bin",
    platform === "win32" ? "ludens-server.cmd" : "ludens-server",
  );
  if (exists(repoBin)) {
    return { command: repoBin, argsPrefix: [] };
  }

  return {
    command: platform === "win32" ? "ludens-server.cmd" : "ludens-server",
    argsPrefix: [],
  };
}

export function buildServerSpawn(
  command,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

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

export function resolveViteBin(appRoot = directory) {
  const candidates = [
    join(appRoot, "node_modules/vite/bin/vite.js"),
    resolve(appRoot, "../node_modules/vite/bin/vite.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
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

async function viteBuild(args) {
  const env = withBunNodePath(process.env, directory);
  delete env.LUDENS_APP_SERVER_URL;
  await runProcess(
    process.execPath,
    [resolveViteBin(directory), "build", ...args],
    { env, label: "Vite build" },
  );
}

const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function extractListenSpecs(args) {
  const specs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--listen" && i + 1 < args.length) {
      specs.push(args[++i]);
    } else if (arg.startsWith("--listen=")) {
      specs.push(arg.slice("--listen=".length));
    }
  }
  return specs;
}

function hasStaticDirArg(args) {
  return args.some(arg => arg === "--static-dir" || arg.startsWith("--static-dir="));
}

function hasExplicitAuthOrDevArg(args) {
  return args.some(
    arg =>
      arg === "--dev" ||
      arg === "--auth" ||
      arg.startsWith("--auth=") ||
      arg === "--token" ||
      arg.startsWith("--token=") ||
      arg === "--token-env" ||
      arg.startsWith("--token-env="),
  );
}

function isLoopbackWsSpec(spec) {
  if (typeof spec !== "string" || !spec.trim().toLowerCase().startsWith("ws://")) {
    return false;
  }
  try {
    const parsed = new URL(spec.trim());
    return LOOPBACK_LISTEN_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildProductionStartArgs(args = [], env = process.env, appRoot = directory) {
  const explicitListenSpecs = extractListenSpecs(args);
  const defaultListenSpec = "ws://127.0.0.1:3015";
  const effectiveListenSpecs =
    explicitListenSpecs.length > 0 ? explicitListenSpecs : [defaultListenSpec];
  const wsSpecs = effectiveListenSpecs.filter(spec =>
    spec.trim().toLowerCase().startsWith("ws://"),
  );
  const allWsLoopback = wsSpecs.length > 0 && wsSpecs.every(isLoopbackWsSpec);

  let modeFlags = [];
  if (!hasExplicitAuthOrDevArg(args) && wsSpecs.length > 0) {
    if (env?.LUDENS_APP_TOKEN?.trim()) {
      modeFlags = ["--auth", "token", "--token-env", "LUDENS_APP_TOKEN"];
    } else if (allWsLoopback) {
      modeFlags = ["--dev"];
    }
  }

  return [
    ...(explicitListenSpecs.length > 0 ? [] : ["--listen", defaultListenSpec]),
    ...modeFlags,
    ...(hasStaticDirArg(args) ? [] : ["--static-dir", join(appRoot, "out")]),
    ...args,
  ];
}

async function startAppServer(args) {
  const { command, argsPrefix } = resolveLudensServerCommand(directory, process.env, process.platform);
  const serverArgs = [
    ...argsPrefix,
    "serve",
    ...buildProductionStartArgs(args, process.env, directory),
  ];
  const invocation = buildServerSpawn(command, serverArgs, process.platform, process.env);
  await runProcess(invocation.command, invocation.args, {
    cwd: resolve(directory, ".."),
    env: process.env,
    label: "ludens-server serve",
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "build") {
    const before = await sourceHash();
    await viteBuild(args);
    if ((await sourceHash()) !== before) {
      throw new Error("Dashboard source changed during build; run the build again.");
    }
    await stampBuild(directory, before);
  } else if (mode === "check") {
    await checkBuild();
  } else if (mode === "start") {
    await checkBuild();
    await startAppServer(args);
  } else {
    throw new Error("Use production.mjs build | check | start");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
