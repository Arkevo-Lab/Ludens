# @ludens/baseware

Cross-device integration and compatibility layer for Ludens: loads built-in (`cua`) and external target/simulator/hardware driver packages, validates `Controller` calls against JSON Schema, arbitrates monotonic `epoch` control leases, records device events, and exposes a unified interface across CLI, TypeScript/Python APIs, and MCP.

## Scripts

```sh
cd baseware && bun run typecheck
cd baseware && bun test
```

## Documentation

- [System Overview](../docs/en/concepts/overview.md)
- [Baseware Design Philosophy and Controlled Node Pool Contract](../docs/en/reference/baseware.md)
- [Driver Bridge Protocol](../docs/en/reference/driver-bridge-protocol.md)
- [Devices, Drivers & Multi-Node Pool](../docs/en/tutorials/devices.md)
- [Architecture and Boundaries](../docs/en/reference/architecture.md)
- [CLI Reference](../docs/en/reference/cli.md)
- [Logging and Call Chains](../docs/en/reference/logging.md)
