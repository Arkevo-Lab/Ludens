import { parseArgs } from "node:util";
import {
  EVENT_DIRECTIONS,
  POOL_EVENT_STATUSES,
  type EventDirection,
  type PoolEventStatus,
} from "@ludens/protocol/event-pool";
import { openWorkspaceEventPool } from "../core/storage/event-pool.ts";
import { send } from "../daemon/transport.ts";

export const EVENT_HELP = `ludens event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]
ludens event send [--title <text>] [--message <text> | <text>]
ludens event reply <event-id> [--message <text> | <text>]
ludens event ack <event-id> [<event-id2> ...]

Post messages or replies into the workspace duplex Event Pool, inspect pending/handled items,
or acknowledge outbound Shiori requests. Works whether ludens run is online (via host socket)
or offline (persisted directly into .ludens/event-pool.json for the next cycle).`;

export type ParsedEventCommand =
  | {
      subcommand: "list";
      filter: { direction?: EventDirection; status?: PoolEventStatus; limit?: number };
    }
  | {
      subcommand: "send";
      title?: string;
      text: string;
    }
  | {
      subcommand: "reply";
      replyTo: string;
      text: string;
    }
  | {
      subcommand: "ack";
      ids: string[];
    };

export function parseEventCommandArgs(argv: string[]): ParsedEventCommand {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        direction: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
      },
    });
    if (positionals.length > 0) {
      throw new Error("Usage: ludens event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]");
    }
    if (values.direction !== undefined && !(EVENT_DIRECTIONS as readonly string[]).includes(values.direction)) {
      throw new Error("--direction must be inbound|outbound");
    }
    if (values.status !== undefined && !(POOL_EVENT_STATUSES as readonly string[]).includes(values.status)) {
      throw new Error("--status must be pending|handled");
    }
    let limit: number | undefined;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
    }
    return {
      subcommand: "list",
      filter: {
        ...(values.direction ? { direction: values.direction as EventDirection } : {}),
        ...(values.status ? { status: values.status as PoolEventStatus } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  }

  if (subcommand === "send") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        title: { type: "string" },
        message: { type: "string" },
      },
    });
    const text = (values.message ?? positionals.join(" ")).trim();
    if (!text || (values.message !== undefined && positionals.length > 0)) {
      throw new Error("Usage: ludens event send [--title <text>] [--message <text> | <text>]");
    }
    return {
      subcommand: "send",
      ...(values.title?.trim() ? { title: values.title.trim() } : {}),
      text,
    };
  }

  if (subcommand === "reply") {
    const [replyTo, ...replyRest] = rest;
    if (!replyTo || replyTo.startsWith("--")) {
      throw new Error("Usage: ludens event reply <event-id> [--message <text> | <text>]");
    }
    const { values, positionals } = parseArgs({
      args: replyRest,
      allowPositionals: true,
      options: {
        message: { type: "string" },
      },
    });
    const text = (values.message ?? positionals.join(" ")).trim();
    if (!text || (values.message !== undefined && positionals.length > 0)) {
      throw new Error("Usage: ludens event reply <event-id> [--message <text> | <text>]");
    }
    return { subcommand: "reply", replyTo: replyTo.trim(), text };
  }

  if (subcommand === "ack") {
    const ids = rest.map(id => id.trim()).filter(id => id.length > 0 && !id.startsWith("--"));
    if (!ids.length || ids.length !== rest.length) {
      throw new Error("Usage: ludens event ack <event-id> [<event-id2> ...]");
    }
    return { subcommand: "ack", ids };
  }

  throw new Error("Usage: ludens event <list|send|reply|ack> (see ludens event --help)");
}

export function isHostSocketOfflineError(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Host is starting or closing")
  );
}

export async function eventCommand(
  argv: string[],
  workspacePath: string,
  socket: string,
  globalHome?: string,
): Promise<void> {
  if (!argv.length || argv.includes("--help")) {
    console.log(EVENT_HELP);
    return;
  }
  const parsed = parseEventCommandArgs(argv);
  const epoch = process.env.BASEWARE_EPOCH;
  if (epoch !== undefined && parsed.subcommand !== "list") {
    throw new Error("Human Event Pool actions belong to the human; inside an agent cycle use the event_pool tool");
  }

  try {
    const value = await send(socket, { kind: "event", argv, epoch });
    console.log(JSON.stringify({ ...(value as Record<string, unknown>), hostOnline: true }, null, 2));
    return;
  } catch (error) {
    if (!isHostSocketOfflineError(error)) throw error;
  }

  const pool = await openWorkspaceEventPool(workspacePath, globalHome);
  if (parsed.subcommand === "list") {
    const snap = await pool.snapshot(parsed.filter);
    console.log(JSON.stringify({ ...snap, hostOnline: false }, null, 2));
    return;
  }
  if (parsed.subcommand === "send") {
    const result = await pool.postInbound({ text: parsed.text, title: parsed.title, runId: null, epoch: null });
    console.log(JSON.stringify({ ...result, hostOnline: false }, null, 2));
    return;
  }
  if (parsed.subcommand === "reply") {
    const result = await pool.postInbound({ text: parsed.text, replyTo: parsed.replyTo, runId: null, epoch: null });
    console.log(JSON.stringify({ ...result, hostOnline: false }, null, 2));
    return;
  }
  const result = await pool.ack(parsed.ids, "human");
  console.log(JSON.stringify({ ...result, hostOnline: false }, null, 2));
}
