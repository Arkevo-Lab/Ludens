# `@ludens/client`

Shared responsive **Vite Static SPA Console** (Web, Mobile, Desktop Renderer) and pure-RPC operator CLI **`ludens`**.

- **Strict dependency boundary**: depends only on `@ludens/protocol` and UI/CLI third-party packages — zero `@ludens/core`, `@ludens/server`, `@ludens/baseware`, or `electron` dependencies.
- **RPC-first**: communicates with any local or remote `ludens-server` over `@ludens/protocol/app-rpc` JSON-RPC 2.0 (Unix Domain Socket locally with on-demand `ludens-server start` wakeup, or WebSocket `/rpc` + HMAC `/media` remotely).
- **Desktop shell**: the All-in-One Electron distribution lives in [`../desktop`](../desktop/README.md) (`@ludens/desktop`, `ludens-app`).

## Pure-RPC Operator CLI (`ludens`)

```sh
ludens config [show | set <field> <value>]
ludens workspace <init|list|open|forget|import|up|down|services|eval> ...
ludens <status|auto|steer|consolidate|stop|model|logs> ...
```

All commands support `--remote <ws(s)://...>` (or `LUDENS_REMOTE_URL`) and `--token <secret>` (or `LUDENS_REMOTE_TOKEN`).

## Scripts

```sh
cd client && bun run dev          # Isolated web-dev (~/.ludens-dev): ludens-server serve --dev + Vite HMR (127.0.0.1:3015)
cd client && bun run dev:real     # Run Vite web-dev against ~/.ludens
cd client && bun run build        # Static Vite SPA build (client/out/)
cd client && bun run build:check  # Verify client/out/index.html & build stamp match sources
cd client && bun run start        # Serve client/out/ via ludens-server serve
cd client && bun run typecheck    # TypeScript check (SPA + CLI)
cd client && bun test             # Run SPA & pure-RPC CLI test suites
```

## Documentation

- [Console & Debugging Tutorial](../docs/en/tutorials/console-and-debugging.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Internal UI Engineering Contract](DESIGN.md)
