import type { LogBlock } from "@ludens/protocol/activity";
import type {
  DesktopViewportAttachInput,
  NativeViewportBounds,
} from "@ludens/protocol/viewport";

export type BlockKind = LogBlock["kind"];
export interface PetSoundSettings {
  enabled: boolean;
  volume: number;
  source: { name: string; dataUrl: string } | null;
}
export interface ActivityPreferences {
  version: 2;
  defaultsVersion: number;
  enabled: boolean;
  blocks: Record<BlockKind, boolean>;
  main: boolean;
  pet: boolean;
  brief: boolean;
  pausedUntil: number;
}
export type ActivityDisplay =
  | { type: "hide"; displayId: string }
  | {
      type: "show";
      displayId: string;
      input: {
        title?: string;
        description?: string;
        status?: string;
        block?: LogBlock;
      };
    };
export interface DesktopCompanion {
  getSound(): Promise<PetSoundSettings>;
  updateSound(settings: Partial<PetSoundSettings>): Promise<PetSoundSettings>;
  resetSound(): Promise<PetSoundSettings>;
  onSound(callback: (settings: PetSoundSettings) => void): () => void;
  getVisible(): Promise<boolean>;
  toggle(): Promise<boolean>;
  onVisibility(callback: (visible: boolean) => void): () => void;
  setLocale(locale: "en" | "zh"): Promise<"en" | "zh">;
  activity: {
    getPreferences(): Promise<ActivityPreferences>;
    updatePreferences(
      input: Partial<ActivityPreferences>,
    ): Promise<ActivityPreferences>;
    resetPreferences(): Promise<ActivityPreferences>;
    onPreferences(callback: (input: ActivityPreferences) => void): () => void;
    onDisplay(callback: (input: ActivityDisplay) => void): () => void;
    onOpen(callback: (url: string) => void): () => void;
    open(displayId: string): Promise<boolean>;
    dismiss(displayId: string): Promise<boolean>;
  };
}
export type DesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopCaptionStyle = "macos" | "win32-overlay" | "custom";
export type DesktopWindowCommand =
  | "toggle-sidebar"
  | "quick-switcher"
  | "navigate-back"
  | "navigate-forward";

export interface DesktopWindowInitialState {
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  titlebarHeight: number;
}

export interface DesktopWindowState extends DesktopWindowInitialState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface DesktopWindowBridge {
  readonly platform: DesktopPlatform;
  readonly initialState: DesktopWindowInitialState;
  getState(): Promise<DesktopWindowState>;
  onState(callback: (state: DesktopWindowState) => void): () => void;
  onCommand(callback: (command: DesktopWindowCommand) => void): () => void;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  handleTitlebarDoubleClick(): Promise<void>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  reload(): Promise<void>;
  setOverlayTheme?(options: {
    color: string;
    symbolColor: string;
    height?: number;
  }): Promise<void>;
}

export interface DesktopSnapshot {
  workspace: string;
  dashboardUrl: string;
  runId: string | null;
}
export interface DesktopRpcStatus {
  readonly state: "connecting" | "connected" | "disconnected";
  readonly error?: string;
}

export interface DesktopRpcBridge {
  send(frameJson: string): void;
  onMessage(callback: (frameJson: string) => void): () => void;
  onStatus?(callback: (status: DesktopRpcStatus) => void): () => void;
  reconnect?(): Promise<void>;
}

export interface DesktopPickPathOptions {
  mode: "directory" | "file";
  title?: string;
  defaultPath?: string;
  extensions?: string[];
  filterName?: string;
}

export interface DesktopDialogBridge {
  pickPath(options: DesktopPickPathOptions): Promise<string | null>;
}

export interface DesktopViewportHostInfo {
  readonly available: boolean;
  readonly hostId?: string;
  readonly socketPath?: string;
}

export interface DesktopViewportUpdateBoundsInput {
  readonly sessionId: string;
  readonly bounds: NativeViewportBounds;
  readonly visible: boolean;
  readonly interactive: boolean;
}

export interface DesktopViewportFramePayload {
  readonly sessionId: string;
  readonly format: "jpeg" | "png" | "webp";
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
  readonly timestampMs: number;
  readonly seq: number;
  readonly pointerLocked: boolean;
}

export interface DesktopViewportFrameStreamInput {
  readonly sessionId: string;
  readonly active: boolean;
  readonly maxFps?: number;
  readonly quality?: number;
}

export interface DesktopViewportBridge {
  getHostInfo(): Promise<DesktopViewportHostInfo>;
  attach(input: DesktopViewportAttachInput): Promise<void | { ok: boolean; error?: string }>;
  updateBounds(
    input: DesktopViewportUpdateBoundsInput,
  ): Promise<void | { ok: boolean; error?: string }>;
  detach(sessionId?: string): Promise<void | { ok: boolean }>;
  setFrameStream?(input: DesktopViewportFrameStreamInput): Promise<void | { ok: boolean }>;
  onFrame?(callback: (frame: DesktopViewportFramePayload) => void): () => void;
}

export interface DesktopPowerState {
  readonly preventAppSuspension: boolean;
  readonly blocking: boolean;
  readonly activeCoreCount: number;
}

export interface DesktopPowerBridge {
  getState(): Promise<DesktopPowerState>;
  setPreventAppSuspension(enabled: boolean): Promise<DesktopPowerState>;
  onState(callback: (state: DesktopPowerState) => void): () => void;
}

export interface LudensDesktopBridge {
  readonly companion?: DesktopCompanion;
  readonly window?: DesktopWindowBridge;
  readonly rpc?: DesktopRpcBridge;
  readonly dialog?: DesktopDialogBridge;
  readonly viewport?: DesktopViewportBridge;
  readonly power?: DesktopPowerBridge;
}

declare global {
  interface Window {
    readonly ludens?: LudensDesktopBridge;
    readonly ludensPet?: {
      getSnapshot(): Promise<DesktopSnapshot>;
      onSnapshot(callback: (snapshot: DesktopSnapshot) => void): () => void;
      openDashboard(): Promise<void>;
    };
  }
}

export function canPickNativePath(): boolean {
  return typeof window !== "undefined" && typeof window.ludens?.dialog?.pickPath === "function";
}

export async function pickNativePath(options: DesktopPickPathOptions): Promise<string | null> {
  if (!canPickNativePath()) return null;
  return window.ludens!.dialog!.pickPath(options);
}

/** Keep native deep links inside the configured application, including in Web previews. */
export function localDashboardLink(
  input: string,
  current: string,
): string | null {
  try {
    const url = new URL(input, current),
      base = new URL(current);
    return url.origin === base.origin && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
