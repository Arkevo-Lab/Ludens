import type { LogBlock } from "./activity";

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
declare global {
  interface Window {
    readonly ludens?: {
      readonly companion?: DesktopCompanion;
      readonly window?: DesktopWindowBridge;
    };
    readonly ludensPet?: {
      getSnapshot(): Promise<DesktopSnapshot>;
      onSnapshot(callback: (snapshot: DesktopSnapshot) => void): () => void;
      openDashboard(): Promise<void>;
    };
  }
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
