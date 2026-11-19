import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  APP_RPC_ERROR_CODES,
  APP_RPC_EVENT_NOTIFICATION,
  APP_RPC_PROTOCOL_VERSION,
  LUDENS_EVENT_TOPICS,
  type LudensServerEvent,
} from "@ludens/protocol/app-rpc";
import type { DesktopRpcBridge, DesktopRpcStatus } from "../lib/desktop";
import {
  LudensRpcClient,
  LudensRpcError,
  LudensRpcProvider,
  useLudensRpc,
  type RpcWebSocketLike,
} from "../lib/ludens-rpc";

class FakeWebSocket implements RpcWebSocketLike {
  readonly sent: Array<{ jsonrpc: string; id: number; method: string; params?: Record<string, unknown> }> = [];
  readyState = 0;
  closedWith?: { code?: number; reason?: string };
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitResult(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }

  emitError(id: number, code: number, message: string, data?: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) });
  }

  emitEvent(event: LudensServerEvent): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: APP_RPC_EVENT_NOTIFICATION,
        params: event,
      }),
    });
  }

  triggerClose(code = 1006, reason = "Socket lost"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("LudensRpcClient performs initialize + events/subscribe handshake, deduplicates events, and sends sinceSeq catch-up on reconnect", async () => {
  const sockets: FakeWebSocket[] = [];
  const receivedEvents: LudensServerEvent[] = [];

  const client = new LudensRpcClient({
    target: { kind: "remote", url: "https://remote.example:8443/app", token: "tok-secret" },
    createWebSocket: url => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock;
    },
  });

  const unsub = client.subscribeEvent("*", evt => {
    receivedEvents.push(evt);
  });

  try {
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "wss://remote.example:8443/app/rpc");
    assert.equal(client.getSnapshot().status, "connecting");

    sockets[0].triggerOpen();
    assert.equal(sockets[0].sent.length, 1);
    assert.equal(sockets[0].sent[0].method, "initialize");
    assert.equal(sockets[0].sent[0].params?.protocolVersion, APP_RPC_PROTOCOL_VERSION);
    assert.equal(sockets[0].sent[0].params?.token, "tok-secret");

    sockets[0].emitResult(sockets[0].sent[0].id, {
      serverVersion: "0.2.0",
      protocolVersion: APP_RPC_PROTOCOL_VERSION,
      transport: "ws",
      authenticated: true,
      serverSeq: 10,
      media: {
        ticket: "ticket-1",
        ticketExpiresAt: Date.now() + 120_000,
      },
      activeCoreCount: 1,
      managedWorkspaces: [],
    });
    await flushAsync();

    assert.equal(sockets[0].sent.length, 2);
    assert.equal(sockets[0].sent[1].method, "events/subscribe");
    assert.deepEqual(sockets[0].sent[1].params, { topics: [...LUDENS_EVENT_TOPICS] });

    sockets[0].emitResult(sockets[0].sent[1].id, {
      subscribedSeq: 12,
      events: [],
      replayTruncated: false,
    });
    await flushAsync();

    const snap1 = client.getSnapshot();
    assert.equal(snap1.status, "connected");
    assert.equal(snap1.isReady, true);
    assert.equal(snap1.serverSeq, 12);
    assert.equal(snap1.mediaTicket, "ticket-1");
    assert.equal(snap1.reconnectGeneration, 0);

    // Incoming events advance serverSeq and ignore duplicates <= lastSeenSeq
    sockets[0].emitEvent({
      seq: 13,
      topic: "observation",
      at: "2026-11-14T00:00:01Z",
      workspaceId: "ws-1",
      payload: { kind: "saved" },
    });
    sockets[0].emitEvent({
      seq: 13,
      topic: "observation",
      at: "2026-11-14T00:00:02Z",
      workspaceId: "ws-1",
      payload: { kind: "duplicate" },
    });
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].seq, 13);
    assert.equal(client.getSnapshot().serverSeq, 13);

    // Call forwards request/response over active socket
    const callPromise = client.call("catalog/get", {});
    await flushAsync();
    const callReq = sockets[0].sent[2];
    assert.equal(callReq.method, "catalog/get");
    sockets[0].emitResult(callReq.id, { projects: [] });
    assert.deepEqual(await callPromise, { projects: [] });

    // Connection drops -> reconnecting state -> explicit reconnect uses sinceSeq=13 catch-up
    sockets[0].triggerClose(1006, "network dropped");
    assert.equal(client.getSnapshot().status, "reconnecting");

    client.reconnect();
    assert.equal(sockets.length, 2);
    sockets[1].triggerOpen();
    sockets[1].emitResult(sockets[1].sent[0].id, {
      serverVersion: "0.2.0",
      protocolVersion: APP_RPC_PROTOCOL_VERSION,
      transport: "ws",
      authenticated: true,
      serverSeq: 14,
      media: {
        ticket: "ticket-2",
        ticketExpiresAt: Date.now() + 120_000,
      },
      activeCoreCount: 1,
      managedWorkspaces: [],
    });
    await flushAsync();

    assert.equal(sockets[1].sent[1].method, "events/subscribe");
    assert.equal(sockets[1].sent[1].params?.sinceSeq, 13);

    // Replay returns seq 13 (stale) and seq 14 (new catch-up event)
    sockets[1].emitResult(sockets[1].sent[1].id, {
      subscribedSeq: 14,
      replayTruncated: false,
      events: [
        { seq: 13, topic: "observation", at: "t1", payload: { kind: "old" } },
        { seq: 14, topic: "run", at: "t2", workspaceId: "ws-1", runId: "r-1", payload: { kind: "updated" } },
      ],
    });
    await flushAsync();

    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[1].seq, 14);
    assert.equal(client.getSnapshot().reconnectGeneration, 1);
    assert.equal(client.getSnapshot().status, "connected");
    assert.equal(client.getSnapshot().mediaTicket, "ticket-2");
  } finally {
    unsub();
    client.dispose();
  }
});

test("LudensRpcClient enters auth-required without reconnect loop on -32001 UNAUTHORIZED", async () => {
  const sockets: FakeWebSocket[] = [];
  const client = new LudensRpcClient({
    target: { kind: "remote", url: "http://127.0.0.1:3015", token: "bad" },
    createWebSocket: url => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock;
    },
  });

  try {
    const callRejected = client.call("catalog/get", {});
    sockets[0].triggerOpen();
    sockets[0].emitError(
      sockets[0].sent[0].id,
      APP_RPC_ERROR_CODES.UNAUTHORIZED,
      "Invalid bearer token",
      { code: "UNAUTHORIZED", status: 401 },
    );

    await assert.rejects(callRejected, (err: unknown) => {
      return err instanceof LudensRpcError && err.rpcCode === APP_RPC_ERROR_CODES.UNAUTHORIZED;
    });
    assert.equal(client.getSnapshot().status, "auth-required");
    assert.equal(client.getSnapshot().needsAuth, true);
    assert.equal(sockets.length, 1);
  } finally {
    client.dispose();
  }
});

test("LudensRpcClient proactively refreshes media tickets before expiration", async () => {
  const sockets: FakeWebSocket[] = [];
  const baseNow = 1_700_000_000_000;
  const client = new LudensRpcClient({
    target: { kind: "remote", url: "http://127.0.0.1:3015" },
    now: () => baseNow,
    createWebSocket: url => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock;
    },
  });

  try {
    sockets[0].triggerOpen();
    sockets[0].emitResult(sockets[0].sent[0].id, {
      serverVersion: "0.2.0",
      protocolVersion: APP_RPC_PROTOCOL_VERSION,
      transport: "ws",
      authenticated: true,
      serverSeq: 1,
      media: {
        ticket: "initial-tk",
        // computeTicketRefreshDelayMs clamps to 1,000ms minimum
        ticketExpiresAt: baseNow + 500,
      },
      activeCoreCount: 0,
      managedWorkspaces: [],
    });
    await flushAsync();
    sockets[0].emitResult(sockets[0].sent[1].id, { subscribedSeq: 1, events: [], replayTruncated: false });
    await flushAsync();
    assert.equal(client.getSnapshot().mediaTicket, "initial-tk");

    await new Promise(resolve => setTimeout(resolve, 1_100));
    const refreshReq = sockets[0].sent.find(frame => frame.method === "media/refreshTicket");
    assert.ok(refreshReq, "expected automatic media/refreshTicket request before ticket expiry");
    sockets[0].emitResult(refreshReq.id, {
      ticket: "refreshed-tk",
      expiresAt: baseNow + 120_000,
    });
    await flushAsync();
    assert.equal(client.getSnapshot().mediaTicket, "refreshed-tk");
  } finally {
    client.dispose();
  }
});

test("LudensRpcClient communicates over DesktopRpcBridge IPC in electron-local mode", async () => {
  const sentFrames: Array<{ id: number; method: string }> = [];
  const messageListeners = new Set<(frameJson: string) => void>();
  const statusListeners = new Set<(status: DesktopRpcStatus) => void>();

  const bridge: DesktopRpcBridge = {
    send(frameJson) {
      const parsed = JSON.parse(frameJson) as { id: number; method: string };
      sentFrames.push(parsed);
      queueMicrotask(() => {
        if (parsed.method === "initialize") {
          for (const listener of messageListeners) {
            listener(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  serverVersion: "0.2.0",
                  protocolVersion: APP_RPC_PROTOCOL_VERSION,
                  transport: "ipc",
                  authenticated: true,
                  serverSeq: 5,
                  media: { ticket: "", ticketExpiresAt: 0 },
                  activeCoreCount: 0,
                  managedWorkspaces: [],
                },
              }),
            );
          }
        } else if (parsed.method === "events/subscribe") {
          for (const listener of messageListeners) {
            listener(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { subscribedSeq: 5, events: [], replayTruncated: false },
              }),
            );
          }
        } else if (parsed.method === "daemon/status") {
          for (const listener of messageListeners) {
            listener(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { pid: 1234, activeCores: [] },
              }),
            );
          }
        }
      });
    },
    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      cb({ state: "connected" });
      return () => statusListeners.delete(cb);
    },
  };

  const client = new LudensRpcClient({
    target: { kind: "electron-local" },
    env: { hasDesktopRpc: true },
    desktopBridge: bridge,
  });

  try {
    await flushAsync();
    const snap = client.getSnapshot();
    assert.equal(snap.status, "connected");
    assert.equal(snap.resolved.ok, true);
    if (snap.resolved.ok) {
      assert.equal(snap.resolved.transport, "ipc");
      assert.equal(snap.resolved.mediaBaseUrl, "ludens-media://local");
    }
    const statusRes = await client.call("daemon/status", undefined);
    assert.deepEqual(statusRes, { pid: 1234, activeCores: [] });
    assert.deepEqual(
      sentFrames.map(frame => frame.method),
      ["initialize", "events/subscribe", "daemon/status"],
    );
  } finally {
    client.dispose();
  }
});

test("useLudensRpc preserves object identity across unchanged renders and keeps rpc.call stable across snapshot updates", async () => {
  const nodeRequire = createRequire(import.meta.url);
  const { JSDOM } = nodeRequire("jsdom") as {
    JSDOM: new (html: string, options?: { url?: string }) => {
      window: { document: Document; close(): void };
    };
  };
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://remote.example:8443/",
  });
  const globalAny = globalThis as {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const prevWindow = globalAny.window;
  const prevDocument = globalAny.document;
  const prevActEnv = globalAny.IS_REACT_ACT_ENVIRONMENT;

  globalAny.window = dom.window;
  globalAny.document = dom.window.document;
  globalAny.IS_REACT_ACT_ENVIRONMENT = true;

  const sockets: FakeWebSocket[] = [];
  const baseNow = 1_700_000_000_000;
  const client = new LudensRpcClient({
    target: { kind: "remote", url: "https://remote.example:8443", token: "tok-stable" },
    now: () => baseNow,
    createWebSocket: url => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock;
    },
  });

  const observed: Array<ReturnType<typeof useLudensRpc>> = [];
  let callEffectRuns = 0;

  function Probe({ tick }: { tick: number }) {
    const rpc = useLudensRpc();
    observed.push(rpc);
    useEffect(() => {
      callEffectRuns += 1;
    }, [rpc.call]);
    return createElement("div", { "data-tick": tick, "data-status": rpc.status });
  }

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        createElement(LudensRpcProvider, {
          client,
          children: createElement(Probe, { tick: 1 }),
        }),
      );
    });

    const countAfterMount = observed.length;

    // Unchanged snapshot re-renders must return the exact same object reference (`Object.is`).
    await act(async () => {
      root.render(
        createElement(LudensRpcProvider, {
          client,
          children: createElement(Probe, { tick: 2 }),
        }),
      );
    });

    assert.equal(observed.length, countAfterMount + 1);
    assert.equal(Object.is(observed[countAfterMount - 1], observed[countAfterMount]), true);
    assert.equal(callEffectRuns, 1);

    // Trigger snapshot changes (connecting -> connected + mediaTicket -> mediaTicket renewal).
    await act(async () => {
      sockets[0].triggerOpen();
      sockets[0].emitResult(sockets[0].sent[0].id, {
        serverVersion: "0.2.0",
        protocolVersion: APP_RPC_PROTOCOL_VERSION,
        transport: "ws",
        authenticated: true,
        serverSeq: 10,
        media: { ticket: "ticket-1", ticketExpiresAt: baseNow + 500 },
        activeCoreCount: 0,
        managedWorkspaces: [],
      });
      await flushAsync();
      sockets[0].emitResult(sockets[0].sent[1].id, {
        subscribedSeq: 10,
        events: [],
        replayTruncated: false,
      });
      await flushAsync();
    });

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      const refreshReq = sockets[0].sent.find(frame => frame.method === "media/refreshTicket");
      assert.ok(refreshReq, "expected media/refreshTicket request");
      sockets[0].emitResult(refreshReq.id, {
        ticket: "ticket-2",
        expiresAt: baseNow + 600_000,
      });
      await flushAsync();
    });

    const latest = observed.at(-1)!;
    assert.equal(latest.status, "connected");
    assert.equal(latest.mediaTicket, "ticket-2");
    assert.equal(latest.serverSeq, 10);
    assert.equal(Object.is(observed[0], latest), false);

    for (const snap of observed) {
      assert.equal(Object.is(snap.call, observed[0].call), true);
    }
    assert.equal(callEffectRuns, 1);

    // Re-rendering again while snapshot stays at seq 11 keeps the new object identity stable.
    const countBefore = observed.length;
    await act(async () => {
      root.render(
        createElement(LudensRpcProvider, {
          client,
          children: createElement(Probe, { tick: 3 }),
        }),
      );
    });
    assert.equal(observed.length, countBefore + 1);
    assert.equal(Object.is(observed[countBefore - 1], observed[countBefore]), true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    client.dispose();
    dom.window.close();
    globalAny.window = prevWindow;
    globalAny.document = prevDocument;
    globalAny.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});
