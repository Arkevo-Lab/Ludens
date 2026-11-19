# @ludens/server

Control-plane server (`ludens-server`) for Ludens: exposes unified JSON-RPC 2.0 over zero-port Unix Domain Socket (NDJSON) and WebSocket (`/rpc`), real-time `EventHub` push (`events/subscribe` + `sinceSeq` replay), HMAC capability-ticket `/media` (`206 Range`), static SPA serving (`--static-dir`), workspace catalog & archive query engine (`DashboardWorker`, SQLite log index, cold builder), and multi-workspace Core lifecycle supervision (`WorkspaceSupervisor`, `WorkspaceLauncher`, device contention arbitration).

`@ludens/server` depends on `@ludens/protocol`, `@ludens/core`, and `@ludens/baseware`, with zero dependency on `@ludens/client` or `@ludens/desktop`.

## CLI (`bin/ludens-server`)

```sh
ludens-server serve [--dev] [--listen <unix://...|ws://HOST:PORT>]... [--auth <none|token>] [--token <secret>|--token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--parent-watchdog]
ludens-server <start|stop|restart|status> [--keep-cores|--stop-cores] [--dev] [--listen ...] ...
```

## Scripts

```sh
cd server && bun run typecheck
cd server && bun run test
```

## Documentation

- [System Overview](../docs/en/concepts/overview.md)
- [Architecture and Boundaries](../docs/en/reference/architecture.md)
- [CLI Reference](../docs/en/reference/cli.md)
