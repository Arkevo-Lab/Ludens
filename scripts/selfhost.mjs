import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuild, runClientBuild } from "../client/scripts/build.mjs";
import { buildServerSpawn, resolveLudensServerCommand } from "./dev.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = join(repoRoot, "client");
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

export function buildSelfhostArgs(args = [], env = process.env, rootDir = repoRoot) {
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
    ...(hasStaticDirArg(args) ? [] : ["--static-dir", join(rootDir, "client/dist")]),
    ...args,
  ];
}

export async function ensureClientDist(targetClientRoot = clientRoot) {
  try {
    await checkBuild(targetClientRoot);
  } catch {
    console.log("[ludens-selfhost] client/dist is missing or stale; building @ludens/client...");
    await runClientBuild([], targetClientRoot);
  }
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
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
      child.once("exit", (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0)));
    });
    if (code !== 0) throw new Error(`${options.label ?? command} exited (${code})`);
  } finally {
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isHelp = args.includes("--help") || args.includes("-h");
  if (!isHelp && !hasStaticDirArg(args)) {
    await ensureClientDist(clientRoot);
  }

  const { command, argsPrefix } = resolveLudensServerCommand(
    repoRoot,
    process.env,
    process.platform,
    undefined,
    { preferDist: true },
  );
  const serverArgs = [
    ...argsPrefix,
    "serve",
    ...(isHelp ? args : buildSelfhostArgs(args, process.env, repoRoot)),
  ];
  const invocation = buildServerSpawn(command, serverArgs, process.platform, process.env);
  await runProcess(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    label: "ludens-server serve",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
