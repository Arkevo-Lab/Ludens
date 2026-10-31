# @ludens/protocol

Zero-dependency contract layer for the Ludens workspace. Every other package (`baseware`, `rsa`, `rsa-dashboard`, `rsa-companion`) consumes these types and helpers through workspace imports only — no cross-package deep relative paths.

## Exports

| Entry | Contents |
| --- | --- |
| `@ludens/protocol/activity` | Activity block / projection / changes DTOs and the `ActivityChangesClient` contract shared by Dashboard and Ludens Pet. |
| `@ludens/protocol/event-sources` | Multi-source event fact declarations (`{sourceId, root, format, recordingId, windows}`) and on-demand merging. |
| `@ludens/protocol/log-archive` | Content-addressed structured archive (`.rsa/archive/`) reader/writer. |
| `@ludens/protocol/ludens` | Shared Ludens domain types. |
| `@ludens/protocol/python` | Python worker protocol types. |
| `@ludens/protocol/timeline-media` | Timeline media asset types. |
| `@ludens/protocol/timeline-types` | Run event envelope, `EventTrace`, `EventMetadata`, and timeline record types. |

## Scripts

```sh
cd protocol && bun run typecheck && bun test
```
