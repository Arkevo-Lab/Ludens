/** Pure, client-safe Device Viewport contracts, binary frame codec, and BrowserHost wire types. */

export const DEVICE_STAGE_KINDS = ["browser", "computer", "observe"] as const;
export type DeviceStageKind = (typeof DEVICE_STAGE_KINDS)[number];

export function isDeviceStageKind(value: unknown): value is DeviceStageKind {
  return typeof value === "string" && (DEVICE_STAGE_KINDS as readonly string[]).includes(value);
}

export const BUILTIN_BROWSER_START_URL = "ludens-browser://start" as const;
export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

export interface ViewportCapabilities {
  navigate: boolean;
  keyboard: boolean;
  mouse: boolean;
  pointerLock: boolean;
  resize: boolean;
  nativeEmbed: boolean;
}

export interface ViewportNavigationState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type ViewportControlMode = "manual" | "auto" | "offline";

export interface ViewportState {
  stageKind: DeviceStageKind;
  available: boolean;
  connected: boolean;
  reason?: string;
  machineId: string | null;
  driver: string | null;
  sessionId?: string;
  nativeHostId?: string;
  width: number;
  height: number;
  pointerLocked: boolean;
  controlMode: ViewportControlMode;
  navigation?: ViewportNavigationState;
  capabilities: ViewportCapabilities;
}

export type MouseButtonName = "left" | "middle" | "right";

export type ViewportHumanInput =
  | {
      type: "mouseMove";
      x: number;
      y: number;
      buttons?: number;
      modifiers?: number;
    }
  | {
      type: "mouseMoveRelative";
      dx: number;
      dy: number;
      buttons?: number;
      modifiers?: number;
    }
  | {
      type: "mouseDown";
      x: number;
      y: number;
      button: MouseButtonName;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "mouseUp";
      x: number;
      y: number;
      button: MouseButtonName;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "mouseWheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "keyDown";
      key: string;
      code?: string;
      text?: string;
      modifiers?: number;
      autoRepeat?: boolean;
    }
  | {
      type: "keyUp";
      key: string;
      code?: string;
      modifiers?: number;
    }
  | {
      type: "releaseAll";
    };

export type ViewportControlAction =
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "resize"; width: number; height: number };

export interface BrowserInputStep {
  atMs: number;
  durationMs?: number;
  keys?: string[];
  mouseButton?: MouseButtonName;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  wheelX?: number;
  wheelY?: number;
}

export type ViewportFrameFormat = "jpeg" | "webp" | "png";

export interface ViewportFramePacket {
  format: ViewportFrameFormat;
  width: number;
  height: number;
  timestampMs: number;
  seq: number;
  pointerLocked: boolean;
  bytes: Uint8Array;
}

/** `/viewport` WebSocket JSON control messages (Client -> Server). */
export type ViewportWsClientMessage =
  | { type: "subscribe"; maxFps?: number; quality?: number }
  | { type: "input"; input: ViewportHumanInput }
  | { type: "action"; action: ViewportControlAction };

/** `/viewport` WebSocket JSON status messages (Server -> Client). */
export type ViewportWsServerMessage =
  | { type: "state"; state: ViewportState }
  | { type: "error"; code: string; message: string };

const VIEWPORT_FRAME_MAGIC = 0x4c; // 'L'
const VIEWPORT_FRAME_VERSION = 0x01;
export const VIEWPORT_FRAME_HEADER_BYTES = 20;

function formatToCode(format: ViewportFrameFormat): number {
  switch (format) {
    case "jpeg":
      return 1;
    case "webp":
      return 2;
    case "png":
      return 3;
  }
}

function codeToFormat(code: number): ViewportFrameFormat {
  switch (code) {
    case 1:
      return "jpeg";
    case 2:
      return "webp";
    case 3:
      return "png";
    default:
      throw new Error(`Unsupported viewport frame format code: ${code}`);
  }
}

export function viewportFormatMimeType(format: ViewportFrameFormat): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
  }
}

/** Encode a viewport frame into a compact 20-byte header + raw image payload packet. */
export function encodeViewportFrame(packet: ViewportFramePacket): Uint8Array {
  const out = new Uint8Array(VIEWPORT_FRAME_HEADER_BYTES + packet.bytes.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, VIEWPORT_FRAME_MAGIC);
  view.setUint8(1, VIEWPORT_FRAME_VERSION);
  view.setUint8(2, formatToCode(packet.format));
  view.setUint8(3, packet.pointerLocked ? 1 : 0);
  view.setUint16(4, Math.max(0, Math.min(65535, Math.round(packet.width))), false);
  view.setUint16(6, Math.max(0, Math.min(65535, Math.round(packet.height))), false);
  view.setFloat64(8, Number.isFinite(packet.timestampMs) ? packet.timestampMs : 0, false);
  view.setUint32(16, packet.seq >>> 0, false);
  out.set(packet.bytes, VIEWPORT_FRAME_HEADER_BYTES);
  return out;
}

/** Decode a binary `/viewport` WebSocket packet back into frame metadata + zero-copy subarray payload. */
export function decodeViewportFrame(raw: ArrayBuffer | Uint8Array): ViewportFramePacket {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < VIEWPORT_FRAME_HEADER_BYTES) {
    throw new Error(`Viewport frame packet too short (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint8(0);
  const version = view.getUint8(1);
  if (magic !== VIEWPORT_FRAME_MAGIC || version !== VIEWPORT_FRAME_VERSION) {
    throw new Error(`Invalid viewport frame header (magic=${magic}, version=${version})`);
  }
  const format = codeToFormat(view.getUint8(2));
  const flags = view.getUint8(3);
  const width = view.getUint16(4, false);
  const height = view.getUint16(6, false);
  const timestampMs = view.getFloat64(8, false);
  const seq = view.getUint32(16, false);
  const payload = bytes.subarray(VIEWPORT_FRAME_HEADER_BYTES);
  return {
    format,
    width,
    height,
    timestampMs,
    seq,
    pointerLocked: (flags & 1) !== 0,
    bytes: payload,
  };
}

/** Local Electron BrowserHost UDS NDJSON request union. */
export type BrowserHostRequest =
  | { kind: "ping" }
  | {
      kind: "session.ensure";
      sessionId: string;
      initialUrl?: string;
      width?: number;
      height?: number;
      partition?: string;
    }
  | { kind: "session.describe"; sessionId: string }
  | { kind: "session.close"; sessionId: string }
  | { kind: "session.action"; sessionId: string; action: ViewportControlAction }
  | {
      kind: "session.capture";
      sessionId: string;
      format?: ViewportFrameFormat;
      quality?: number;
    }
  | { kind: "session.input"; sessionId: string; input: ViewportHumanInput }
  | { kind: "session.type"; sessionId: string; text: string }
  | { kind: "session.play"; sessionId: string; steps: BrowserInputStep[] }
  | { kind: "session.releaseAll"; sessionId: string }
  | {
      kind: "session.subscribe";
      sessionId: string;
      maxFps?: number;
      quality?: number;
    }
  | { kind: "session.unsubscribe"; sessionId: string }
  | { kind: "cancel"; operationId: string };

export interface BrowserHostPingResult {
  hostId: string;
  pid: number;
  version: string;
  sessions: string[];
}

export interface BrowserHostCaptureResult {
  format: ViewportFrameFormat;
  mediaType: string;
  dataBase64: string;
  width: number;
  height: number;
  seq: number;
  timestampMs: number;
  pointerLocked: boolean;
  url: string;
  title: string;
}

export type BrowserHostEvent =
  | {
      event: "frame";
      sessionId: string;
      format: ViewportFrameFormat;
      width: number;
      height: number;
      timestampMs: number;
      seq: number;
      pointerLocked: boolean;
      dataBase64: string;
    }
  | {
      event: "state";
      sessionId: string;
      state: ViewportState;
    };

export interface BrowserHostEnvelope {
  id: string;
  request: BrowserHostRequest;
}

export type BrowserHostWireMessage =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }
  | { event: BrowserHostEvent };

/** Desktop IPC slot bounds for native `WebContentsView` attachment in `electron-local`. */
export interface NativeViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopViewportAttachInput {
  sessionId: string;
  initialUrl?: string;
  bounds: NativeViewportBounds;
  visible: boolean;
  interactive: boolean;
}
