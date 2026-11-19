import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { readArtifact } from "@ludens/protocol/log-archive";
import { once } from "node:events";
import { readRunEvents } from "@ludens/protocol/event-sources";

export const LOG_HELP = `ludens logs events --run <run-id> [--diagnostics]
Stream saved events as NDJSON, resolving registered device sources without copying them.
--diagnostics explicitly reads the separate diagnostic channel.
ludens logs read --run <run-id> (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) [--full]
Read a stored model/tool artifact offline; no host or model is started.
Default: expand text/structure and keep media references. --full restores recorded media
as base64; missing, unrecorded or expired media fails explicitly. HTTP wire hashes describe
the original body; reconstructed JSON does not reproduce compressed wire bytes.
Event fields include payload, response, result, resultRef, body and argsRef. Old gzip artifacts remain readable.`;

export interface ReadRunLogEventsOptions {
  channel?: "events" | "diagnostics";
  limit?: number;
  afterSeq?: number;
}

export async function readRunLogEvents(
  runDirectory: string,
  options: ReadRunLogEventsOptions = {},
): Promise<{ events: unknown[]; hasMore: boolean; nextAfterSeq?: number }> {
  const run = await realpath(runDirectory);
  const channel = options.channel ?? "events";
  const limit = options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : undefined;
  const afterSeq = options.afterSeq;
  const events: unknown[] = [];
  let hasMore = false;
  let lastSeq: number | undefined;

  for await (const event of readRunEvents(run, { channel })) {
    const seq = typeof (event as { seq?: unknown }).seq === "number" ? (event as { seq: number }).seq : undefined;
    if (afterSeq !== undefined && seq !== undefined && seq <= afterSeq) continue;
    if (limit !== undefined && events.length >= limit) {
      hasMore = true;
      break;
    }
    events.push(event);
    if (seq !== undefined) lastSeq = seq;
  }

  return {
    events,
    hasMore,
    ...(hasMore && lastSeq !== undefined ? { nextAfterSeq: lastSeq } : {}),
  };
}

export interface ReadRunLogArtifactOptions {
  reference?: unknown;
  event?: number;
  field?: string;
  full?: boolean;
}

export async function readRunLogArtifact(
  runDirectory: string,
  options: ReadRunLogArtifactOptions,
): Promise<unknown> {
  const run = await realpath(runDirectory);
  let reference = options.reference;
  if (options.event !== undefined) {
    const sequence = Number(options.event);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !options.field) {
      throw new Error("event requires a positive sequence and field");
    }
    const input = createReadStream(join(run, "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { seq?: unknown; data?: Record<string, unknown> };
        if (event.seq === sequence) {
          reference = event.data?.[options.field];
          break;
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (reference === undefined) throw new Error("Event or artifact field was not found");
  } else if (reference === undefined) {
    throw new Error("Supply either reference or event + field");
  }
  return readArtifact(run, reference, { media: options.full ? "full" : "reference" });
}

export async function logCommand(argv: string[]) {
  if (!argv.length || argv.includes("--help")) { console.log(LOG_HELP); return; }
  if (argv[0] === "events") {
    const { values } = parseArgs({ args: argv.slice(1), options: { run: { type: "string" }, diagnostics: { type: "boolean" } } });
    if (!values.run) throw new Error("--run is required");
    for await (const event of readRunEvents(await realpath(values.run), { channel: values.diagnostics ? "diagnostics" : "events" })) {
      if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
    }
    return;
  }
  if (argv[0] !== "read") throw new Error("Expected ludens logs read; see ludens logs --help");
  const { values } = parseArgs({ args: argv.slice(1), options: {
    run: { type: "string" }, ref: { type: "string" }, file: { type: "string" },
    event: { type: "string" }, field: { type: "string" }, full: { type: "boolean" },
  } });
  if (!values.run || [values.ref, values.file, values.event].filter(value => value !== undefined).length !== 1)
    throw new Error("Supply --run and exactly one of --ref, --file or --event");
  if (values.event === undefined && values.field !== undefined) throw new Error("--field requires --event");
  const artifact = await readRunLogArtifact(values.run, {
    ...(values.event !== undefined
      ? { event: Number(values.event), field: values.field }
      : { reference: JSON.parse(values.ref ?? await readFile(values.file!, "utf8")) }),
    full: Boolean(values.full),
  });
  console.log(JSON.stringify(artifact, null, 2));
}

if (import.meta.main) {
  logCommand(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
