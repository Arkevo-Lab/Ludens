import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LogsScopeParams } from "@ludens/protocol/app-rpc";
import type { AppRpcClient } from "./app-rpc-client.ts";
import {
  resolveWorkspaceTargetViaRpc,
  withOperatorRpc,
  type OperatorRpcOptions,
} from "./operator-rpc.ts";

export const LOG_HELP = `Ludens log archive inspection (RPC):
ludens logs events --run <run-id-or-directory> [--diagnostics] [--cursor <n>] [--limit <n>] [--workspace <id|path>] [--remote <url> --token <secret>]
ludens logs read --run <run-id-or-directory> (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) [--full] [--workspace <id|path>] [--remote <url> --token <secret>]

Streams saved events or reads stored model/tool artifacts through ludens-server JSON-RPC.
--diagnostics reads the separate diagnostic channel.
--full restores recorded media as base64; missing or expired media fails explicitly.`;

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

async function buildLogsScope(
  client: AppRpcClient,
  rawRun: string,
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  mode: "remote" | "uds",
): Promise<LogsScopeParams> {
  if (explicitWorkspace) {
    const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, true);
    return {
      project: target.id,
      workspace: target.workspace,
      run: rawRun,
    };
  }

  if (looksLikePath(rawRun)) {
    return {
      run: mode === "remote" ? rawRun : resolve(rawRun),
    };
  }

  try {
    const target = await resolveWorkspaceTargetViaRpc(client, selectedWorkspace, false);
    return {
      project: target.id,
      workspace: target.workspace,
      run: rawRun,
    };
  } catch (error) {
    if (mode === "remote") throw error;
    return { run: resolve(rawRun) };
  }
}

export async function runLogsWithClient(
  client: AppRpcClient,
  argv: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  mode: "remote" | "uds",
  io: {
    writeLine?: (line: string) => void | Promise<void>;
    out?: (line: string) => void;
    readLocalFile?: (path: string) => Promise<string>;
  } = {},
): Promise<void> {
  const out = io.out ?? console.log;
  const writeLine =
    io.writeLine ??
    (io.out
      ? (line: string) => {
          io.out!(line);
        }
      : async (line: string) => {
          if (!process.stdout.write(`${line}\n`)) {
            await once(process.stdout, "drain");
          }
        });
  const readLocalFile = io.readLocalFile ?? ((path: string) => readFile(path, "utf8"));

  if (!argv.length || argv[0] === "--help" || argv.includes("--help")) {
    out(LOG_HELP);
    return;
  }

  const [sub, ...rest] = argv;
  if (sub === "events") {
    const { values } = parseArgs({
      args: rest,
      options: {
        run: { type: "string" },
        diagnostics: { type: "boolean", default: false },
        cursor: { type: "string" },
        limit: { type: "string" },
      },
      strict: true,
    });
    if (!values.run?.trim()) {
      throw new Error("--run is required");
    }
    const startCursor = values.cursor !== undefined ? Number(values.cursor) : undefined;
    if (startCursor !== undefined && (!Number.isInteger(startCursor) || startCursor < 0)) {
      throw new Error("--cursor must be a non-negative integer");
    }
    const explicitLimit = values.limit !== undefined ? Number(values.limit) : undefined;
    if (explicitLimit !== undefined && (!Number.isInteger(explicitLimit) || explicitLimit <= 0)) {
      throw new Error("--limit must be a positive integer");
    }

    const scope = await buildLogsScope(
      client,
      values.run.trim(),
      selectedWorkspace,
      explicitWorkspace,
      mode,
    );
    const channel = values.diagnostics ? "diagnostics" : "events";

    const DEFAULT_LOGS_PAGE_SIZE = 200;
    const MAX_LOGS_PAGE_SIZE = 500;
    let cursor = startCursor;
    let snapshot: string | undefined;
    let remaining = explicitLimit;
    for (;;) {
      const pageLimit =
        remaining !== undefined
          ? Math.min(remaining, MAX_LOGS_PAGE_SIZE)
          : DEFAULT_LOGS_PAGE_SIZE;
      const page = await client.call("logs/events", {
        ...scope,
        channel,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(snapshot !== undefined ? { snapshot } : {}),
        limit: pageLimit,
      });
      if (typeof page.snapshot === "string" && page.snapshot) {
        snapshot = page.snapshot;
      }
      for (const event of page.events) {
        await writeLine(JSON.stringify(event));
      }
      if (remaining !== undefined) {
        remaining -= page.events.length;
        if (remaining <= 0) break;
      }
      if (!page.hasMore || page.nextCursor === null || page.nextCursor === undefined) {
        break;
      }
      cursor = page.nextCursor;
    }
    return;
  }

  if (sub !== "read") {
    throw new Error(`Unknown logs subcommand '${sub}'; expected 'events' or 'read'`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      run: { type: "string" },
      ref: { type: "string" },
      file: { type: "string" },
      event: { type: "string" },
      field: { type: "string" },
      full: { type: "boolean", default: false },
    },
    strict: true,
  });

  const selectors = [values.ref, values.file, values.event].filter(v => v !== undefined);
  if (!values.run?.trim() || selectors.length !== 1) {
    throw new Error("Supply --run and exactly one of --ref, --file, or --event");
  }

  const scope = await buildLogsScope(
    client,
    values.run.trim(),
    selectedWorkspace,
    explicitWorkspace,
    mode,
  );

  if (values.event !== undefined) {
    const eventSeq = Number(values.event);
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1 || !values.field?.trim()) {
      throw new Error("--event requires a positive integer sequence and --field <name>");
    }
    const result = await client.call("logs/read", {
      ...scope,
      eventSeq,
      field: values.field.trim(),
      media: values.full ? "full" : "reference",
    });
    out(JSON.stringify(result.value, null, 2));
    return;
  }

  if (values.field !== undefined) {
    throw new Error("--field requires --event");
  }

  const rawJson = values.ref !== undefined ? values.ref : await readLocalFile(values.file!);
  const reference = JSON.parse(rawJson);
  const result = await client.call("logs/read", {
    ...scope,
    reference,
    media: values.full ? "full" : "reference",
  });
  out(JSON.stringify(result.value, null, 2));
}

export async function logsCommand(
  argv: string[],
  selectedWorkspace: string,
  explicitWorkspace: boolean,
  rpcOptions: OperatorRpcOptions,
  io?: {
    writeLine?: (line: string) => void | Promise<void>;
    out?: (line: string) => void;
    readLocalFile?: (path: string) => Promise<string>;
  },
): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv.includes("--help")) {
    (io?.out ?? console.log)(LOG_HELP);
    return;
  }
  await withOperatorRpc(rpcOptions, (client, mode) =>
    runLogsWithClient(client, argv, selectedWorkspace, explicitWorkspace, mode, io),
  );
}
