import { describe, expect, test } from "bun:test";
import {
  BUILTIN_BROWSER_DRIVER_SPEC,
  driverRegistryKey,
  validateRegisteredDriverSpec,
} from "../src/drivers.ts";
import {
  BUILTIN_LOCAL_BROWSER_MACHINE,
  BUILTIN_LOCAL_DESKTOP_MACHINE,
  resolveMachineStageKind,
  validateMachineSpec,
} from "../src/machines.ts";
import {
  browserHostRuntimeFilePath,
  resolveBrowserHostSocketPath,
} from "../src/browser-host-paths.ts";
import {
  decodeViewportFrame,
  encodeViewportFrame,
  viewportFormatMimeType,
} from "../src/viewport.ts";

describe("protocol viewport & built-in browser contracts", () => {
  test("encodes and decodes binary viewport frames losslessly", () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const encoded = encodeViewportFrame({
      format: "jpeg",
      width: 1280,
      height: 720,
      timestampMs: 1732521600123.5,
      seq: 42,
      pointerLocked: true,
      bytes: payload,
    });
    const decoded = decodeViewportFrame(encoded);
    expect(decoded.format).toBe("jpeg");
    expect(viewportFormatMimeType(decoded.format)).toBe("image/jpeg");
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(720);
    expect(decoded.timestampMs).toBe(1732521600123.5);
    expect(decoded.seq).toBe(42);
    expect(decoded.pointerLocked).toBe(true);
    expect([...decoded.bytes]).toEqual([...payload]);
  });

  test("resolves first-class device stage kinds cleanly", () => {
    expect(resolveMachineStageKind(BUILTIN_LOCAL_BROWSER_MACHINE)).toBe("browser");
    expect(resolveMachineStageKind(BUILTIN_LOCAL_DESKTOP_MACHINE)).toBe("computer");
    expect(resolveMachineStageKind({ driver: "mgba" })).toBe("observe");
    expect(resolveMachineStageKind(null)).toBe("observe");

    const customComputer = validateMachineSpec({
      id: "remote-vm",
      name: "Remote VM",
      driver: "cua",
      stageKind: "computer",
      transport: { kind: "ssh", host: "10.0.0.5" },
    });
    expect(customComputer.stageKind).toBe("computer");
  });

  test("protects builtin:browser driver key and resolves browser-host paths", () => {
    expect(driverRegistryKey("browser")).toBe(BUILTIN_BROWSER_DRIVER_SPEC);
    expect(driverRegistryKey("browser", BUILTIN_BROWSER_DRIVER_SPEC)).toBe(BUILTIN_BROWSER_DRIVER_SPEC);
    expect(() =>
      validateRegisteredDriverSpec({ id: "browser", spec: BUILTIN_BROWSER_DRIVER_SPEC }),
    ).toThrow(/built-in/);

    const socketPath = resolveBrowserHostSocketPath("/tmp/ludens-test-home");
    const runtimePath = browserHostRuntimeFilePath("/tmp/ludens-test-home");
    expect(socketPath.length).toBeGreaterThan(0);
    expect(runtimePath.endsWith("browser-host.json")).toBe(true);
  });
});
