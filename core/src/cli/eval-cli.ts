/** Capability evaluation CLI: static listing, execution, and history; no host required. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { historyCapabilityEvals, listCapabilityEvals, runCapabilityEvals } from "../core/subsystems/capability-evals.ts";

export const EVAL_HELP = `ludens eval list
ludens eval run [<capability-id>] [--all]
ludens eval history [<capability-id>] [--limit <n>]
ludens eval <capability-id>

Evaluate workspace @capability functions through their bound @eval_capability.
list joins static discovery with .ludens/evals/latest.json and reports evalStatus
per capability: missing (no binding), unverified (never run), stale (source changed),
failed (error or empty rewards), or verified (current passing rewards).
run executes the bound eval (or every bound eval with --all) offline: epochs are
stripped, timeline reads fall back to committed .ludens/timeline/ records, and each
run is persisted under .ludens/evals/runs/ with latest.json republished.
Exit code 0 when every executed eval passes; 1 when any fails or has no binding.
history lists persisted runs newest-first. Pair each @capability with
@eval_capability(fn) in the same module; ludens bench covers Harbor agent tasks.`;

export async function evalCommand(args: string[], workspacePath: string) {
  if (!args.length || args[0] === "--help") { console.log(EVAL_HELP); return; }
  const workspace = resolve(workspacePath);
  const [first, ...rest] = args;
  const command = first === "run" || first === "list" || first === "history"
    ? first
    : first?.startsWith("python/") ? "run" : undefined;
  if (!command) throw new Error(`Unknown eval command: ${first}; see ludens eval --help`);
  const positional = command === "run" && first !== "run" ? [first, ...rest] : rest;
  if (command === "run") {
    const { values, positionals } = parseArgs({ args: positional, allowPositionals: true, options: {
      all: { type: "boolean" }, limit: { type: "string" },
    } });
    if (values.all && positionals.length) throw new Error("Choose either a capability ID or --all");
    const capabilityId = positionals[0];
    if (!capabilityId && !values.all) throw new Error("eval run requires a capability ID or --all");
    if (positionals.length > 1) throw new Error("eval run takes at most one capability ID");
    const run = await runCapabilityEvals(workspace, { ...(capabilityId ? { capabilityId } : { all: true }) });
    console.log(JSON.stringify(run, null, 2));
    process.exitCode = run.outcome === "passed" ? 0 : 1;
    return;
  }
  if (command === "list") {
    if (positional.length) throw new Error("eval list takes no arguments");
    console.log(JSON.stringify(await listCapabilityEvals(workspace), null, 2));
    return;
  }
  const { values, positionals } = parseArgs({ args: positional, allowPositionals: true, options: {
    limit: { type: "string" },
  } });
  if (positionals.length > 1) throw new Error("eval history takes at most one capability ID");
  const history = await historyCapabilityEvals(workspace, {
    ...(positionals[0] ? { capabilityId: positionals[0] } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
  });
  console.log(JSON.stringify({ runs: history }, null, 2));
}
