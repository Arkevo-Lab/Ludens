/** Pure, client-safe types and validators for Ludens Baseware Driver Registrations. */

import { MACHINE_TRANSPORT_KINDS, type MachineTransportKind } from "./machines";

export const DRIVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

export function validDriverId(id: unknown): id is string {
  return typeof id === "string" && DRIVER_ID_PATTERN.test(id);
}

export interface RegisteredDriverSpec {
  id: string;
  spec: string;
  name?: string;
  version?: string;
  description?: string;
  transport?: MachineTransportKind;
  defaultPort?: number;
  needsGame?: boolean;
  launchHint?: string;
  updatedAt: string;
}

export interface DriversRegistryFile {
  version: 1;
  drivers: RegisteredDriverSpec[];
}

export const BUILTIN_CUA_DRIVER_SPEC = "builtin:cua";

export const BUILTIN_CUA_DRIVER: RegisteredDriverSpec = {
  id: "cua",
  spec: BUILTIN_CUA_DRIVER_SPEC,
  name: "Desktop CUA",
  version: "builtin",
  description: "Built-in local desktop CUA controller adapter over stdio MCP",
  transport: "stdio",
  needsGame: false,
  launchHint: "Starts the installed Cua Driver (cua-driver by default); it needs no emulator or bridge port.",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function driverRegistryKey(id: string, spec?: string): string {
  const cleanId = id.trim();
  const cleanSpec = (spec ?? "").trim();
  if (cleanId === "cua" && (!cleanSpec || cleanSpec === BUILTIN_CUA_DRIVER_SPEC)) {
    return BUILTIN_CUA_DRIVER_SPEC;
  }
  return `${cleanId}::${cleanSpec}`;
}

export function validateRegisteredDriverSpec(value: unknown, path = "driver"): RegisteredDriverSpec {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  if (!validDriverId(value.id)) {
    throw new Error(`${path}.id must be a valid driver identifier`);
  }
  if (typeof value.spec !== "string" || !value.spec.trim()) {
    throw new Error(`${path}.spec must be a non-empty driver package spec`);
  }
  const specText = value.spec.trim();
  if (specText.length > 500) {
    throw new Error(`${path}.spec must be at most 500 characters`);
  }
  if (specText === BUILTIN_CUA_DRIVER_SPEC) {
    throw new Error(`${path}.spec cannot overwrite built-in cua driver`);
  }

  const out: RegisteredDriverSpec = {
    id: value.id,
    spec: specText,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt.trim()
      : new Date().toISOString(),
  };

  for (const field of ["name", "version", "description", "launchHint"] as const) {
    const raw = value[field];
    if (raw !== undefined && raw !== null && raw !== "") {
      if (typeof raw !== "string") throw new Error(`${path}.${field} must be a string`);
      out[field] = raw.trim();
    }
  }

  if (value.transport !== undefined && value.transport !== null && value.transport !== "") {
    if (typeof value.transport !== "string" || !(MACHINE_TRANSPORT_KINDS as readonly string[]).includes(value.transport)) {
      throw new Error(`${path}.transport must be one of: ${MACHINE_TRANSPORT_KINDS.join(", ")}`);
    }
    out.transport = value.transport as MachineTransportKind;
  }

  if (value.defaultPort !== undefined && value.defaultPort !== null && value.defaultPort !== "") {
    const port = Number(value.defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${path}.defaultPort must be an integer between 1 and 65535`);
    }
    out.defaultPort = port;
  }

  if (value.needsGame !== undefined) {
    if (typeof value.needsGame !== "boolean") throw new Error(`${path}.needsGame must be boolean`);
    out.needsGame = value.needsGame;
  }

  return out;
}
