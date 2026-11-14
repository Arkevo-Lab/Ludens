# @ludens/protocol

Zero-dependency contract layer for the Ludens workspace. Every other package (`baseware`, `core`, `app`) consumes these types and helpers through workspace imports only — no cross-package deep relative paths.

## Exports

| Entry | Contents |
| --- | --- |
| `@ludens/protocol/activity` | Activity block / projection / changes DTOs and the `ActivityChangesClient` contract shared by Console and Desktop Pet. |
| `@ludens/protocol/app-rpc` | Unified JSON-RPC 2.0 wire contract (`APP_RPC_PROTOCOL_VERSION`, `APP_RPC_ERROR_CODES`, `LUDENS_EVENT_TOPICS`, `AppRpcMethods`, `events/event`, `media/resolve`) across CLI, Desktop, and Web/Mobile Console. |
| `@ludens/protocol/connection` | Multimodal connection and transport setting schemas (`openaiWebsockets`, `cacheRetention`, `imageUrls`). |
| `@ludens/protocol/drivers` | Baseware driver manifest and registration DTOs. |
| `@ludens/protocol/event-pool` | Bidirectional workspace Event Pool entry, cursor, and triage contracts. |
| `@ludens/protocol/event-sources` | Multi-source event fact declarations (`{sourceId, root, format, recordingId, windows}`) and on-demand merging. |
| `@ludens/protocol/log-archive` | Content-addressed structured archive (`.ludens/archive/`) reader/writer. |
| `@ludens/protocol/ludens` | Shared Ludens domain types. |
| `@ludens/protocol/machines` | Controlled node registry and transport endpoint schemas. |
| `@ludens/protocol/python` | Python worker protocol types. |
| `@ludens/protocol/timeline-media` | Timeline media asset types. |
| `@ludens/protocol/timeline-types` | Run event envelope, `EventTrace`, `EventMetadata`, and timeline record types. |

## Scripts

```sh
cd protocol && bun run typecheck && bun test
```
