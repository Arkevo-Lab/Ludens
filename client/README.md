# `@ludens/client`

Shared responsive **Vite Static SPA Console** (Web, Mobile, Desktop Renderer) and pure-RPC operator CLI **`ludens`**.

- **Strict dependency boundary**: depends only on `@ludens/protocol` and UI/CLI third-party packages — zero `@ludens/core`, `@ludens/server`, `@ludens/baseware`, or `electron` dependencies, and zero cross-package process spawning.
- **RPC-first**: communicates with any local or remote `ludens-server` over `@ludens/protocol/app-rpc` JSON-RPC 2.0 (Unix Domain Socket locally with on-demand `ludens-server start` wakeup, or WebSocket `/rpc` + HMAC `/media` remotely).
- **Desktop shell**: the All-in-One Electron distribution lives in [`../desktop`](../desktop/README.md) (`@ludens/desktop`, `ludens-app`).

## Pure-RPC Operator CLI (`ludens`)

```sh
ludens config [show | set <field> <value>]
ludens workspace <init|list|open|forget|import|up|down|services|eval> ...
ludens <status|auto|steer|consolidate|stop|model|logs> ...
```

All commands support `--remote <ws(s)://...>` (or `LUDENS_REMOTE_URL`) and `--token <secret>` (or `LUDENS_REMOTE_TOKEN`).

## Atomic Package Scripts (`client/`)

```sh
bun --cwd client run dev          # Pure Vite HMR on 127.0.0.1:3015 (zero local backend; proxies /rpc, /media, /health only if LUDENS_SERVER_URL is set)
bun --cwd client run build        # Static Vite SPA build into client/dist/ + fingerprint stamp
bun --cwd client run build:check  # Verify client/dist/index.html & build stamp match sources
bun --cwd client run typecheck    # TypeScript check (SPA + CLI)
bun --cwd client run test         # Run SPA & pure-RPC CLI test suites
```

## Full-Stack Root Orchestration

From the repository root:

```sh
bun run dev             # Web full-stack dev (~/.ludens-dev): managed ludens-server --dev + Vite HMR
bun run dev:web:real    # Web full-stack dev mounting ~/.ludens
bun run dev:client      # Pure cross-origin Vite HMR (zero local server, connect to remote/cloud server)
bun run start:selfhost  # Verify/build client/dist and serve via ludens-server serve --static-dir client/dist
```

## Documentation

- [Console & Debugging Tutorial](../docs/en/tutorials/console-and-debugging.md)
- [Quick Start and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Internal UI Engineering Contract](DESIGN.md)
