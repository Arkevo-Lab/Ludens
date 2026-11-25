"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Crosshair,
  Expand,
  Globe,
  Hand,
  Monitor,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import {
  BUILTIN_BROWSER_START_URL,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
} from "@ludens/protocol/viewport";
import { PixelMark } from "@/components/ui/pixel-mark";
import { useTranslations } from "@/lib/locale";
import {
  normalizeBrowserNavigationUrl,
  type UseDeviceViewportResult,
} from "@/features/live/use-device-viewport";

export interface DeviceViewportProps {
  viewport: UseDeviceViewportResult;
  stageKind: "browser" | "computer";
  isAuto: boolean;
  reclaiming?: boolean;
  suspended?: boolean;
  immersive?: boolean;
  onToggleImmersive?: () => void;
  onReclaimControl?: () => void | Promise<void>;
}

export function DeviceViewport({
  viewport,
  stageKind,
  isAuto,
  reclaiming = false,
  suspended = false,
  immersive = false,
  onToggleImmersive,
  onReclaimControl,
}: DeviceViewportProps) {
  const t = useTranslations("deviceViewport");
  const {
    state,
    transportMode,
    streamStatus,
    loading,
    error,
    occluded,
    hasFrame,
    pointerLockedLocal,
    slotRef,
    canvasRef,
    stageRef,
    stageHandlers,
    refresh,
    performAction,
    requestPointerLock,
  } = viewport;

  const width = state?.width || DEFAULT_VIEWPORT_WIDTH;
  const height = state?.height || DEFAULT_VIEWPORT_HEIGHT;
  const available = Boolean(state?.available);
  const connected = Boolean(state?.connected);
  const controlMode = state?.controlMode ?? (available ? (isAuto ? "auto" : "manual") : "offline");
  const isManual = available && controlMode === "manual";
  const isAgentControlled = available && (controlMode === "auto" || isAuto);
  const navigation = state?.navigation;
  const currentUrl = navigation?.url ?? BUILTIN_BROWSER_START_URL;
  const isStartPage = currentUrl === BUILTIN_BROWSER_START_URL;

  const [omniboxValue, setOmniboxValue] = useState(currentUrl);
  const [omniboxFocused, setOmniboxFocused] = useState(false);

  useEffect(() => {
    if (!omniboxFocused) {
      setOmniboxValue(currentUrl);
    }
  }, [currentUrl, omniboxFocused]);

  const handleNavigateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isManual) return;
    const normalized = normalizeBrowserNavigationUrl(omniboxValue);
    if (!normalized) return;
    setOmniboxValue(normalized);
    void performAction({ kind: "navigate", url: normalized });
    stageRef.current?.focus({ preventScroll: true });
  };

  const showStreamCanvas =
    available && (transportMode === "stream" || (transportMode === "native-electron" && occluded));
  const showConnectingOverlay =
    available && transportMode === "stream" && !hasFrame && !suspended;
  const showNativeHint =
    available && transportMode === "native-electron" && !occluded && !suspended;
  const showOfflineCard = !available;

  return (
    <section
      className="device-viewport"
      data-device-viewport=""
      data-stage-kind={stageKind}
      data-control-mode={controlMode}
      data-transport={transportMode}
      data-immersive={immersive ? "true" : undefined}
      data-suspended={suspended ? "true" : undefined}
      aria-label={t(stageKind === "browser" ? "browserAria" : "computerAria")}
    >
      {/* Top Chrome Bar */}
      <header className="device-viewport-chrome">
        {stageKind === "browser" ? (
          <>
            <div className="device-viewport-nav-group">
              <button
                type="button"
                className="device-viewport-icon-btn"
                title={t("navBack")}
                aria-label={t("navBack")}
                disabled={!isManual || !navigation?.canGoBack}
                onClick={() => void performAction({ kind: "back" })}
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="device-viewport-icon-btn"
                title={t("navForward")}
                aria-label={t("navForward")}
                disabled={!isManual || !navigation?.canGoForward}
                onClick={() => void performAction({ kind: "forward" })}
              >
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="device-viewport-icon-btn"
                title={t("navReload")}
                aria-label={t("navReload")}
                disabled={!isManual}
                onClick={() => void performAction({ kind: "reload" })}
              >
                <RotateCw
                  className={`size-3.5${navigation?.loading ? " motion-safe:animate-spin" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            <form
              className="device-viewport-omnibox"
              data-start-page={isStartPage && !omniboxFocused ? "true" : undefined}
              onSubmit={handleNavigateSubmit}
            >
              <Globe className="device-viewport-omnibox-icon size-3.5" aria-hidden="true" />
              <input
                type="text"
                className="device-viewport-omnibox-input"
                aria-label={t("omniboxAria")}
                placeholder={t("omniboxPlaceholder")}
                value={
                  !omniboxFocused && isStartPage ? t("startPageDisplayLabel") : omniboxValue
                }
                readOnly={!isManual}
                disabled={!available}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                onFocus={event => {
                  setOmniboxFocused(true);
                  setOmniboxValue(currentUrl);
                  event.currentTarget.select();
                }}
                onBlur={() => {
                  setOmniboxFocused(false);
                  setOmniboxValue(currentUrl);
                }}
                onChange={event => setOmniboxValue(event.target.value)}
              />
            </form>
          </>
        ) : (
          <div className="device-viewport-computer-id">
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="device-viewport-computer-name">
              {state?.machineId || t("computerDefaultLabel")}
            </span>
            <span
              className="device-viewport-conn-dot"
              data-connected={connected ? "true" : "false"}
              title={t(connected ? "statusConnected" : "statusDisconnected")}
              aria-label={t(connected ? "statusConnected" : "statusDisconnected")}
            />
          </div>
        )}

        <div className="device-viewport-meta">
          <span className="device-viewport-res" title={t("resolutionTitle")}>
            {width}×{height}
          </span>

          {transportMode === "stream" && isManual && state?.capabilities.pointerLock && (
            <button
              type="button"
              className="device-viewport-icon-btn"
              data-active={pointerLockedLocal ? "true" : undefined}
              title={t("pointerLockBtnHint")}
              aria-label={t("pointerLockBtnHint")}
              onClick={requestPointerLock}
            >
              <Crosshair className="size-3.5" aria-hidden="true" />
            </button>
          )}

          <div className="device-viewport-control-capsule" data-mode={controlMode}>
            <span className="device-viewport-control-dot" aria-hidden="true" />
            <span className="device-viewport-control-label">
              {controlMode === "offline"
                ? t("controlOffline")
                : isAgentControlled
                  ? t("controlAutoShiori")
                  : t("controlManual")}
            </span>
            {isAgentControlled && onReclaimControl && (
              <button
                type="button"
                className="device-viewport-reclaim-btn"
                data-viewport-reclaim=""
                disabled={reclaiming}
                onClick={() => void onReclaimControl()}
              >
                <Hand className="size-3" aria-hidden="true" />
                <span>{t(reclaiming ? "reclaimingBtn" : "reclaimControlBtn")}</span>
              </button>
            )}
          </div>

          {onToggleImmersive && (
            <button
              type="button"
              className="device-viewport-icon-btn device-viewport-immersive-btn"
              data-viewport-immersive-toggle=""
              data-active={immersive ? "true" : undefined}
              aria-pressed={immersive}
              title={t(immersive ? "exitImmersiveHint" : "immersiveModeHint")}
              aria-label={t(immersive ? "exitImmersiveHint" : "immersiveModeHint")}
              onClick={onToggleImmersive}
            >
              {immersive ? (
                <Columns2 className="size-3.5" aria-hidden="true" />
              ) : (
                <Expand className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </header>

      {/* Stage Body */}
      <div
        ref={stageRef}
        className="device-viewport-stage"
        tabIndex={isManual ? 0 : -1}
        data-interactive={isManual ? "true" : "false"}
        data-auto-locked={isAgentControlled ? "true" : undefined}
        onKeyDown={stageHandlers.onKeyDown}
        onKeyUp={stageHandlers.onKeyUp}
        onBlur={stageHandlers.onBlur}
      >
        <div
          ref={slotRef}
          className="device-viewport-slot"
          style={
            {
              aspectRatio: `${width} / ${height}`,
              "--vp-aspect": String(width / Math.max(1, height)),
            } as CSSProperties
          }
        >
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="device-viewport-canvas"
            data-visible={showStreamCanvas ? "true" : "false"}
            onMouseMove={stageHandlers.onMouseMove}
            onMouseDown={stageHandlers.onMouseDown}
            onMouseUp={stageHandlers.onMouseUp}
            onWheel={stageHandlers.onWheel}
            onContextMenu={stageHandlers.onContextMenu}
            onDoubleClick={stageHandlers.onDoubleClick}
          />

          {showNativeHint && (
            <div className="device-viewport-native-placeholder" aria-hidden="true" />
          )}

          {showConnectingOverlay && (
            <div className="device-viewport-overlay-state" role="status">
              <PixelMark loading size={18} />
              <span>
                {t(
                  streamStatus === "disconnected"
                    ? "streamReconnecting"
                    : "streamConnecting",
                )}
              </span>
            </div>
          )}

          {showOfflineCard && (
            <div className="device-viewport-offline" role="status" data-viewport-offline="">
              <div className="device-viewport-offline-icon" aria-hidden="true">
                {stageKind === "browser" ? (
                  <Globe className="size-5" />
                ) : (
                  <WifiOff className="size-5" />
                )}
              </div>
              <h4 className="device-viewport-offline-title">
                {t(stageKind === "browser" ? "browserOfflineTitle" : "computerOfflineTitle")}
              </h4>
              <p className="device-viewport-offline-desc">
                {state?.reason ||
                  t(stageKind === "browser" ? "browserOfflineDesc" : "computerOfflineDesc")}
              </p>
              <button
                type="button"
                className="device-viewport-retry-btn"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  className={`size-3.5${loading ? " motion-safe:animate-spin" : ""}`}
                  aria-hidden="true"
                />
                <span>{t("retryBtn")}</span>
              </button>
            </div>
          )}

          {isAgentControlled && !showOfflineCard && (
            <div
              className="device-viewport-auto-shield"
              data-viewport-auto-overlay=""
              onMouseDown={event => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="device-viewport-auto-pill">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("autoControlBanner")}</span>
                {onReclaimControl && (
                  <button
                    type="button"
                    className="device-viewport-auto-pill-btn"
                    disabled={reclaiming}
                    onClick={() => void onReclaimControl()}
                  >
                    {t(reclaiming ? "reclaimingBtn" : "reclaimControlBtn")}
                  </button>
                )}
              </div>
            </div>
          )}

          {pointerLockedLocal && isManual && (
            <div className="device-viewport-lock-pill" role="status">
              <Crosshair className="size-3" aria-hidden="true" />
              <span>{t("pointerLockActiveHint")}</span>
            </div>
          )}
        </div>
      </div>

      {error && available && (
        <p className="device-viewport-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
