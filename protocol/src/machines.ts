/** Pure, client-safe types and validators for Baseware Machines and Workspace Machine Bindings. */

export const MACHINE_TRANSPORT_KINDS = ["stdio", "bridge", "ssh", "http", "sse"] as const;
export type MachineTransportKind = (typeof MACHINE_TRANSPORT_KINDS)[number];

export interface MachineStdioTransport {
  kind: "stdio";
  command?: string;
  args?: string[];
}

export interface MachineBridgeTransport {
  kind: "bridge";
  host?: string;
  port: number;
  game?: string;
  managed?: boolean;
}

export interface MachineSshTransport {
  kind: "ssh";
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  command?: string;
}

export interface MachineHttpTransport {
  kind: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type MachineTransportConfig =
  | MachineStdioTransport
  | MachineBridgeTransport
  | MachineSshTransport
  | MachineHttpTransport;

export interface BasewareMachineSpec {
  id: string;
  name: string;
  driver: string;
  driverPackage?: string;
  transport: MachineTransportConfig;
  description?: string;
  tags?: string[];
  builtin?: boolean;
  updatedAt: string;
}

export interface WorkspaceMachinesBinding {
  active?: string;
  allowed: string[];
}

export interface MachinesRegistryFile {
  version: 1;
  machines: BasewareMachineSpec[];
}

export const BUILTIN_LOCAL_DESKTOP_MACHINE: BasewareMachineSpec = {
  id: "local-desktop",
  name: "Local Desktop (CUA)",
  driver: "cua",
  transport: { kind: "stdio", command: "cua-driver" },
  description: "Built-in local desktop CUA controller over stdio MCP",
  tags: ["local", "desktop", "cua"],
  builtin: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validMachineId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id);
}

export function validateMachineTransport(value: unknown, path = "transport"): MachineTransportConfig {
  if (!isObject(value) || typeof value.kind !== "string") {
    throw new Error(`${path} must be an object with kind: stdio|bridge|ssh|http|sse`);
  }
  switch (value.kind) {
    case "stdio": {
      const result: MachineStdioTransport = { kind: "stdio" };
      if (value.command !== undefined && value.command !== null && value.command !== "") {
        if (typeof value.command !== "string" || !value.command.trim()) {
          throw new Error(`${path}.command must be a non-empty string`);
        }
        result.command = value.command.trim();
      }
      if (value.args !== undefined) {
        if (!Array.isArray(value.args) || !value.args.every(item => typeof item === "string")) {
          throw new Error(`${path}.args must be an array of strings`);
        }
        result.args = value.args.map(item => item.trim()).filter(Boolean);
      }
      return result;
    }
    case "bridge": {
      const port = Number(value.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${path}.port must be an integer between 1 and 65535`);
      }
      const result: MachineBridgeTransport = { kind: "bridge", port };
      if (value.host !== undefined && value.host !== null && value.host !== "") {
        if (typeof value.host !== "string" || !value.host.trim()) {
          throw new Error(`${path}.host must be a non-empty hostname or IP`);
        }
        result.host = value.host.trim();
      }
      if (value.game !== undefined && value.game !== null && value.game !== "") {
        if (typeof value.game !== "string" || !value.game.trim()) {
          throw new Error(`${path}.game must be a non-empty string`);
        }
        result.game = value.game.trim();
      }
      if (value.managed !== undefined) {
        if (typeof value.managed !== "boolean") throw new Error(`${path}.managed must be boolean`);
        result.managed = value.managed;
      }
      return result;
    }
    case "ssh": {
      if (typeof value.host !== "string" || !value.host.trim()) {
        throw new Error(`${path}.host must be a non-empty SSH hostname or IP`);
      }
      const result: MachineSshTransport = { kind: "ssh", host: value.host.trim() };
      if (value.user !== undefined && value.user !== null && value.user !== "") {
        if (typeof value.user !== "string" || !value.user.trim()) {
          throw new Error(`${path}.user must be a non-empty string`);
        }
        result.user = value.user.trim();
      }
      if (value.port !== undefined && value.port !== null && value.port !== "") {
        const port = Number(value.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`${path}.port must be an integer between 1 and 65535`);
        }
        result.port = port;
      }
      if (value.identityFile !== undefined && value.identityFile !== null && value.identityFile !== "") {
        if (typeof value.identityFile !== "string" || !value.identityFile.trim()) {
          throw new Error(`${path}.identityFile must be a non-empty path`);
        }
        result.identityFile = value.identityFile.trim();
      }
      if (value.command !== undefined && value.command !== null && value.command !== "") {
        if (typeof value.command !== "string" || !value.command.trim()) {
          throw new Error(`${path}.command must be a non-empty command string`);
        }
        result.command = value.command.trim();
      }
      return result;
    }
    case "http":
    case "sse": {
      if (typeof value.url !== "string" || !/^https?:\/\/.+/i.test(value.url.trim())) {
        throw new Error(`${path}.url must be a valid http:// or https:// URL`);
      }
      const result: MachineHttpTransport = { kind: value.kind, url: value.url.trim() };
      if (value.headers !== undefined) {
        if (!isObject(value.headers)) throw new Error(`${path}.headers must be an object`);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(value.headers)) {
          if (typeof v !== "string") throw new Error(`${path}.headers.${k} must be a string`);
          headers[k] = v;
        }
        if (Object.keys(headers).length > 0) result.headers = headers;
      }
      return result;
    }
    default:
      throw new Error(`${path}.kind must be one of: ${MACHINE_TRANSPORT_KINDS.join(", ")}`);
  }
}

export function validateMachineSpec(value: unknown, path = "machine"): BasewareMachineSpec {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  if (!validMachineId(value.id)) {
    throw new Error(`${path}.id must be 1–96 alphanumeric/dash/underscore characters`);
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`${path}.name must be a non-empty string`);
  }
  if (typeof value.driver !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.driver.trim())) {
    throw new Error(`${path}.driver must be a valid driver identifier`);
  }
  const spec: BasewareMachineSpec = {
    id: value.id,
    name: value.name.trim(),
    driver: value.driver.trim(),
    transport: validateMachineTransport(value.transport, `${path}.transport`),
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt.trim()
      : new Date().toISOString(),
  };
  if (value.driverPackage !== undefined && value.driverPackage !== null && value.driverPackage !== "") {
    if (typeof value.driverPackage !== "string" || !value.driverPackage.trim()) {
      throw new Error(`${path}.driverPackage must be a non-empty string`);
    }
    spec.driverPackage = value.driverPackage.trim();
  }
  if (value.description !== undefined && value.description !== null && value.description !== "") {
    if (typeof value.description !== "string") throw new Error(`${path}.description must be a string`);
    spec.description = value.description.trim();
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === "string")) {
      throw new Error(`${path}.tags must be an array of strings`);
    }
    spec.tags = [...new Set(value.tags.map(tag => tag.trim()).filter(Boolean))];
  }
  if (value.builtin === true) spec.builtin = true;
  return spec;
}

export function validateWorkspaceMachinesBinding(
  value: unknown,
  path = "machines",
): WorkspaceMachinesBinding {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  if (!Array.isArray(value.allowed) || !value.allowed.every(validMachineId)) {
    throw new Error(`${path}.allowed must be an array of valid machine IDs`);
  }
  const allowed = [...new Set(value.allowed)];
  let active: string | undefined;
  if (value.active !== undefined && value.active !== null && value.active !== "") {
    if (!validMachineId(value.active)) {
      throw new Error(`${path}.active must be a valid machine ID`);
    }
    active = value.active;
    if (!allowed.includes(active)) allowed.unshift(active);
  } else if (allowed.length > 0) {
    active = allowed[0];
  }
  return { ...(active ? { active } : {}), allowed };
}
