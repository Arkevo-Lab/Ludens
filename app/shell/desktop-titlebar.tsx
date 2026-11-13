"use client";

import type { MouseEvent } from "react";
import { ArrowLeft, ArrowRight, PanelLeft, RotateCw, Search } from "lucide-react";
import { PixelMark } from "@/components/ui/pixel-mark";
import type { DesktopCaptionStyle, DesktopPlatform } from "@/lib/desktop";
import { useTranslations } from "@/lib/locale";
import {
  computeTitlebarLayout,
  formatDesktopShortcut,
} from "@/shell/use-desktop-window";

export interface DesktopTitlebarProps {
  active: boolean;
  platform: DesktopPlatform;
  captionStyle: DesktopCaptionStyle;
  titlebarHeight?: number;
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
  isPreview: boolean;
  hasNativeMacTrafficLights?: boolean;
  sidebarCollapsed: boolean;
  mobileNavOpen?: boolean;
  workspaceTitle?: string;
  viewTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  companionAvailable?: boolean;
  companionVisible?: boolean;
  onToggleSidebar(): void;
  onGoBack(): void;
  onGoForward(): void;
  onOpenQuickSwitcher(): void;
  onReload(): void;
  onToggleCompanion?(): void;
  onMinimize(): void;
  onToggleMaximize(): void;
  onTogglePreviewFullScreen?(): void;
  onClose(): void;
  onTitlebarDoubleClick(): void;
  onSelectPreviewPlatform?(platform: DesktopPlatform | null): void;
}

export function DesktopTitlebar({
  active,
  platform,
  captionStyle,
  titlebarHeight = 38,
  maximized,
  fullScreen,
  focused,
  isPreview,
  hasNativeMacTrafficLights = false,
  sidebarCollapsed,
  mobileNavOpen = false,
  workspaceTitle,
  viewTitle,
  canGoBack,
  canGoForward,
  companionAvailable = false,
  companionVisible = false,
  onToggleSidebar,
  onGoBack,
  onGoForward,
  onOpenQuickSwitcher,
  onReload,
  onToggleCompanion,
  onMinimize,
  onToggleMaximize,
  onTogglePreviewFullScreen,
  onClose,
  onTitlebarDoubleClick,
  onSelectPreviewPlatform,
}: DesktopTitlebarProps) {
  const t = useTranslations("desktopChrome");
  if (!active) return null;

  const layout = computeTitlebarLayout({
    active,
    platform,
    captionStyle,
    fullScreen,
    titlebarHeight,
  });

  const sidebarExpanded = !sidebarCollapsed || mobileNavOpen;
  const sidebarActionLabel = sidebarCollapsed
    ? t("expandSidebar")
    : t("collapseSidebar");
  const sidebarTooltip = t("toggleSidebarHint")
    .replace("{action}", sidebarActionLabel)
    .replace("{shortcut}", formatDesktopShortcut(platform, "B"));
  const backTooltip = t("navigateBackHint").replace(
    "{shortcut}",
    formatDesktopShortcut(platform, "["),
  );
  const forwardTooltip = t("navigateForwardHint").replace(
    "{shortcut}",
    formatDesktopShortcut(platform, "]"),
  );
  const searchTooltip = t("quickSwitcherHint").replace(
    "{shortcut}",
    formatDesktopShortcut(platform, "K"),
  );

  const handleSurfaceDoubleClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, [data-no-drag]")) return;
    onTitlebarDoubleClick();
  };

  return (
    <header
      className="desktop-titlebar"
      aria-label={t("titlebarAria")}
      data-desktop-titlebar=""
      data-platform={platform}
      data-caption-style={captionStyle}
      data-sidebar-collapsed={String(sidebarCollapsed)}
      data-fullscreen={String(fullScreen)}
      data-maximized={String(maximized)}
      data-focused={String(focused)}
      data-preview={isPreview ? "true" : undefined}
    >
      {/* Left Header Cell: Pixel-aligned with 220px ConsoleSidebar */}
      <div
        className="desktop-titlebar-left"
        style={{ paddingLeft: `${layout.leftInsetPx}px` }}
        onDoubleClick={handleSurfaceDoubleClick}
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
            data-action="navigate-back"
            disabled={!canGoBack}
            aria-label={t("navigateBack")}
            title={backTooltip}
            onClick={onGoBack}
          >
            <ArrowLeft className="size-[15px]" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="desktop-chrome-icon-btn"
            data-action="navigate-forward"
            disabled={!canGoForward}
            aria-label={t("navigateForward")}
            title={forwardTooltip}
            onClick={onGoForward}
          >
            <ArrowRight className="size-[15px]" strokeWidth={1.75} aria-hidden="true" />
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

      {/* Right Header Cell: Draggable Main Workspace Chrome */}
      <div
        className="desktop-titlebar-main"
        onDoubleClick={handleSurfaceDoubleClick}
      >
        <div className="desktop-titlebar-breadcrumb" data-titlebar-breadcrumb="">
          <span className="desktop-breadcrumb-product">Ludens</span>
          <span className="desktop-breadcrumb-sep" aria-hidden="true">/</span>
          {workspaceTitle ? (
            <>
              <span className="desktop-breadcrumb-workspace">
                {workspaceTitle}
              </span>
              <span className="desktop-breadcrumb-sep" aria-hidden="true">
                ·
              </span>
            </>
          ) : null}
          <strong className="desktop-breadcrumb-view">{viewTitle}</strong>
        </div>

        <div className="desktop-titlebar-right" data-no-drag="">
          <div className="desktop-titlebar-tools">
            {isPreview && onSelectPreviewPlatform && (
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

            {companionAvailable && onToggleCompanion && (
              <button
                type="button"
                className="desktop-pet-pill"
                data-action="toggle-companion"
                data-visible={String(companionVisible)}
                aria-pressed={companionVisible}
                aria-label={t(
                  companionVisible ? "companionHide" : "companionShow",
                )}
                title={t(companionVisible ? "companionHide" : "companionShow")}
                onClick={onToggleCompanion}
              >
                <span className="desktop-pet-dot" aria-hidden="true" />
                <span>{t("companionLabel")}</span>
              </button>
            )}

            <button
              type="button"
              className="desktop-chrome-icon-btn"
              data-action="reload"
              aria-label={t("reload")}
              title={t("reload")}
              onClick={onReload}
            >
              <RotateCw className="size-[13.5px]" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>

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
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
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
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
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
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
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
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M 0.5,0.5 L 9.5,9.5 M 9.5,0.5 L 0.5,9.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
