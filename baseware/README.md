# @ludens/baseware

Standalone device driver and control-plane service for Ludens: loads built-in (`cua`) and external emulator/runtime driver packages, validates `Controller` calls against JSON Schema, arbitrates `epoch` control leases, records device events, and exposes a unified interface across CLI, TypeScript/Python APIs, and MCP.

## Scripts

```sh
cd baseware && bun run typecheck
cd baseware && bun test
```

## Documentation

- [Baseware Design Philosophy and Controlled Node Pool Contract](../docs/en/reference/baseware.md)
- [Driver Bridge Protocol](../docs/en/reference/driver-bridge-protocol.md)
- [Devices, Drivers & Multi-Machine Pool](../docs/en/tutorials/devices.md)
- [Architecture and Boundaries](../docs/en/reference/architecture.md)
- [Logging and Call Chains](../docs/en/reference/logging.md)
