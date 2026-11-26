"use client";

import type { MouseEvent, ReactNode } from "react";
import { PanelLeft, Search } from "lucide-react";
import { PixelMark } from "@/components/ui/pixel-mark";
import type { DesktopCaptionStyle, DesktopPlatform } from "@/lib/desktop";
import { useTranslations } from "@/lib/locale";
import {
  computeTitlebarLayout,
  formatDesktopShortcut,
} from "@/shell/use-desktop-window";

export interface DesktopLeadingControlsProps {
  active: boolean;
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  fullScreen: boolean;
  focused: boolean;
  isPreview: boolean;
  hasNativeMacTrafficLights?: boolean;
  sidebarCollapsed: boolean;
  mobileNavOpen?: boolean;
  variant?: "sidebar" | "inline";
  onToggleSidebar(): void;
  onOpenQuickSwitcher(): void;
  onMinimize(): void;
  onToggleMaximize(): void;
  onTogglePreviewFullScreen?(): void;
  onClose(): void;
}

/**
 * Leading desktop window controls (`traffic lights` inset + sidebar toggle + quick switcher).
 * Mounted at `y = 0` inside Col 1 (`ConsoleSidebar`) when expanded, or inline at the start
 * of the leftmost visible column header when the sidebar is collapsed.
 */
export function DesktopLeadingControls({
  active,
  platform,
  captionStyle,
  fullScreen,
  focused,
  isPreview,
  hasNativeMacTrafficLights = false,
  sidebarCollapsed,
  mobileNavOpen = false,
  variant = "sidebar",
  onToggleSidebar,
  onOpenQuickSwitcher,
  onMinimize,
  onToggleMaximize,
  onTogglePreviewFullScreen,
  onClose,
}: DesktopLeadingControlsProps) {
  const t = useTranslations("desktopChrome");
  if (!active) return null;

  const layout = computeTitlebarLayout({
    active,
    platform,
    captionStyle,
    fullScreen,
  });

  const sidebarExpanded = !sidebarCollapsed || mobileNavOpen;
  const sidebarActionLabel = sidebarCollapsed
    ? t("expandSidebar")
    : t("collapseSidebar");
  const sidebarTooltip = t("toggleSidebarHint")
    .replace("{action}", sidebarActionLabel)
    .replace("{shortcut}", formatDesktopShortcut(platform, "B"));
  const searchTooltip = t("quickSwitcherHint").replace(
    "{shortcut}",
    formatDesktopShortcut(platform, "K"),
  );

  const paddingLeftPx =
    variant === "sidebar"
      ? layout.leftInsetPx
      : layout.showTrafficLightZone
        ? Math.max(0, layout.leftInsetPx - 12)
        : 0;

  return (
    <div
      className="desktop-leading-controls"
      data-desktop-leading={variant}
      data-platform={platform}
      data-focused={String(focused)}
      style={{ paddingLeft: `${paddingLeftPx}px` }}
    >
      {isPreview &&
        layout.showTrafficLightZone &&
        !hasNativeMacTrafficLights && (
          <div
            className="desktop-preview-traffic-lights"
            data-no-drag=""
            data-preview-traffic-lights=""
          >
            <button
              type="button"
              className="desktop-preview-dot close"
              aria-label={t("exitPreview")}
              title={t("exitPreview")}
              onClick={onClose}
            />
            <button
              type="button"
              className="desktop-preview-dot minimize"
              aria-hidden="true"
              tabIndex={-1}
              onClick={onMinimize}
            />
            <button
              type="button"
              className="desktop-preview-dot zoom"
              aria-label={t("winMaximize")}
              title={t("winMaximize")}
              onClick={() =>
                onTogglePreviewFullScreen
                  ? onTogglePreviewFullScreen()
                  : onToggleMaximize()
              }
            />
          </div>
        )}

      {layout.showLeadingBrandMark && (
        <span className="desktop-titlebar-app-icon" data-titlebar-brand="">
          <PixelMark size={15} />
        </span>
      )}

      <div className="desktop-titlebar-nav-group" data-no-drag="">
        <button
          type="button"
          className="desktop-chrome-icon-btn"
          data-action="toggle-sidebar"
          data-active={String(sidebarExpanded)}
          aria-label={sidebarActionLabel}
          aria-pressed={sidebarExpanded}
          title={sidebarTooltip}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="size-[15px]" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="desktop-chrome-icon-btn"
          data-action="quick-switcher"
          aria-label={t("quickSwitcher")}
          title={searchTooltip}
          onClick={onOpenQuickSwitcher}
        >
          <Search className="size-[14.5px]" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface DesktopTrailingControlsProps {
  active: boolean;
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
  isPreview: boolean;
  onMinimize(): void;
  onToggleMaximize(): void;
  onClose(): void;
  onSelectPreviewPlatform?(platform: DesktopPlatform | null): void;
}

/**
 * Trailing desktop window controls (Windows/Linux caption buttons, WCO safe spacer,
 * and browser preview OS switcher). Returns `null` on native macOS so the rightmost
 * column header stays 100% pure.
 */
export function DesktopTrailingControls({
  active,
  platform,
  captionStyle,
  maximized,
  fullScreen,
  focused,
  isPreview,
  onMinimize,
  onToggleMaximize,
  onClose,
  onSelectPreviewPlatform,
}: DesktopTrailingControlsProps) {
  const t = useTranslations("desktopChrome");
  if (!active) return null;

  const layout = computeTitlebarLayout({
    active,
    platform,
    captionStyle,
    fullScreen,
  });

  const showPreview = Boolean(isPreview && onSelectPreviewPlatform);
  if (
    !showPreview &&
    !layout.reserveWin32Overlay &&
    !layout.showCustomWindowControls
  ) {
    return null;
  }

  return (
    <div
      className="desktop-trailing-controls"
      data-desktop-trailing=""
      data-platform={platform}
      data-focused={String(focused)}
      data-no-drag=""
    >
      {showPreview && onSelectPreviewPlatform && (
        <div
          className="desktop-preview-switcher"
          role="group"
          aria-label={t("previewBadge")}
          data-preview-switcher=""
        >
          <button
            type="button"
            className="desktop-preview-btn"
            data-preview-switch="darwin"
            data-active={String(platform === "darwin")}
            title={t("previewSwitchMac")}
            onClick={() => onSelectPreviewPlatform("darwin")}
          >
            {t("previewMac")}
          </button>
          <button
            type="button"
            className="desktop-preview-btn"
            data-preview-switch="win32"
            data-active={String(platform === "win32")}
            title={t("previewSwitchWin")}
            onClick={() => onSelectPreviewPlatform("win32")}
          >
            {t("previewWin")}
          </button>
          <button
            type="button"
            className="desktop-preview-btn exit"
            data-preview-exit=""
            aria-label={t("exitPreview")}
            title={t("exitPreview")}
            onClick={() => onSelectPreviewPlatform(null)}
          >
            ×
          </button>
        </div>
      )}

      {layout.reserveWin32Overlay && (
        <div
          className="desktop-wco-spacer"
          data-win32-overlay-spacer=""
          aria-hidden="true"
        />
      )}

      {layout.showCustomWindowControls && (
        <div className="desktop-win-controls" data-win-controls="">
          <button
            type="button"
            className="desktop-win-btn minimize"
            data-win-control="minimize"
            aria-label={t("winMinimize")}
            title={t("winMinimize")}
            onClick={onMinimize}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M 0,5 L 10,5"
                stroke="currentColor"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
            </svg>
          </button>
          <button
            type="button"
            className="desktop-win-btn maximize"
            data-win-control="maximize"
            aria-label={t(maximized ? "winRestore" : "winMaximize")}
            title={t(maximized ? "winRestore" : "winMaximize")}
            onClick={onToggleMaximize}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M 2.5,2.5 V 1.5 A 1,1 0 0 1 3.5,0.5 H 8.5 A 1,1 0 0 1 9.5,1.5 V 6.5 A 1,1 0 0 1 8.5,7.5 H 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <rect
                  x="0.5"
                  y="2.5"
                  width="7"
                  height="7"
                  rx="1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect
                  x="0.5"
                  y="0.5"
                  width="9"
                  height="9"
                  rx="1.25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="desktop-win-btn close"
            data-win-control="close"
            aria-label={t("winClose")}
            title={t("winClose")}
            onClick={onClose}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M 1,1 L 9,9 M 9,1 L 1,9"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight 46px draggable top strip rendered ONLY on non-workbench views
 * (Workspaces, Devices, Settings, Docs, Config, Capabilities) on Desktop so
 * users can drag the window and access collapsed-sidebar / Win32 controls without a T-bar.
 */
export function DesktopDragStrip({
  leadingSlot,
  trailingSlot,
  onDoubleClick,
}: {
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  onDoubleClick?: () => void;
}) {
  const handleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, [data-no-drag]")) return;
    onDoubleClick?.();
  };

  return (
    <div
      className="desktop-view-dragbar"
      data-desktop-dragbar=""
      onDoubleClick={handleDoubleClick}
    >
      <div className="desktop-view-dragbar-left">{leadingSlot}</div>
      <div className="desktop-view-dragbar-right">{trailingSlot}</div>
    </div>
  );
}
