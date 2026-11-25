"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
  WifiOff,
} from "lucide-react";
import {
  BUILTIN_BROWSER_START_URL,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  type ViewportControlAction,
  type ViewportState,
} from "@ludens/protocol/viewport";
import { PixelMark } from "@/components/ui/pixel-mark";
import { useTranslations } from "@/lib/locale";
import {
  normalizeBrowserNavigationUrl,
  type UseDeviceViewportResult,
} from "@/features/live/use-device-viewport";

export interface ViewportTopbarSlots {
  leadingExtraSlot?: ReactNode;
  centerSlot: ReactNode;
  trailingExtraSlot?: ReactNode;
}

export function ViewportBrowserNavButtons({
  state,
  isAuto,
  onAction,
}: {
  state: ViewportState | null;
  isAuto: boolean;
  onAction: (action: ViewportControlAction) => Promise<void> | void;
}) {
  const t = useTranslations("deviceViewport");
  const available = Boolean(state?.available);
  const controlMode = state?.controlMode ?? (available ? (isAuto ? "auto" : "manual") : "offline");
  const isManual = available && controlMode === "manual";
  const navigation = state?.navigation;

  return (
    <>
      <button
        type="button"
        className="device-viewport-icon-btn"
        data-viewport-nav="back"
        title={t("navBack")}
        aria-label={t("navBack")}
        disabled={!isManual || !navigation?.canGoBack}
        onClick={() => void onAction({ kind: "back" })}
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
      </button>
      {navigation?.canGoForward && (
        <button
          type="button"
          className="device-viewport-icon-btn"
          data-viewport-nav="forward"
          title={t("navForward")}
          aria-label={t("navForward")}
          disabled={!isManual}
          onClick={() => void onAction({ kind: "forward" })}
        >
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="device-viewport-icon-btn"
        data-viewport-nav="reload"
        title={t("navReload")}
        aria-label={t("navReload")}
        disabled={!isManual}
        onClick={() => void onAction({ kind: "reload" })}
      >
        <RotateCw
          className={`size-3.5${navigation?.loading ? " motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
      </button>
    </>
  );
}

export function ViewportOmnibox({
  state,
  isAuto,
  stageRef,
  onAction,
}: {
  state: ViewportState | null;
  isAuto: boolean;
  stageRef?: RefObject<HTMLDivElement | null>;
  onAction: (action: ViewportControlAction) => Promise<void> | void;
}) {
  const t = useTranslations("deviceViewport");
  const available = Boolean(state?.available);
  const controlMode = state?.controlMode ?? (available ? (isAuto ? "auto" : "manual") : "offline");
  const isManual = available && controlMode === "manual";
  const currentUrl = state?.navigation?.url ?? BUILTIN_BROWSER_START_URL;
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
    void onAction({ kind: "navigate", url: normalized });
    stageRef?.current?.focus({ preventScroll: true });
  };

  return (
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
        value={!omniboxFocused && isStartPage ? t("startPageDisplayLabel") : omniboxValue}
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
  );
}

export function ViewportComputerBadge({
  state,
  leadingSlot,
}: {
  state: ViewportState | null;
  leadingSlot?: ReactNode;
}) {
  const t = useTranslations("deviceViewport");
  const connected = Boolean(state?.connected);
  return (
    <div className="device-viewport-computer-id">
      {leadingSlot}
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
  );
}

export function ViewportMetaControls({
  state,
  isAuto,
  reclaiming = false,
  immersive = false,
  onToggleImmersive,
  onReclaimControl,
}: {
  state: ViewportState | null;
  isAuto: boolean;
  reclaiming?: boolean;
  immersive?: boolean;
  onToggleImmersive?: () => void;
  onReclaimControl?: () => void | Promise<void>;
}) {
  const t = useTranslations("deviceViewport");
  const available = Boolean(state?.available);
  const controlMode = state?.controlMode ?? (available ? (isAuto ? "auto" : "manual") : "offline");
  const isAgentControlled = available && (controlMode === "auto" || isAuto);

  return (
    <div className="device-viewport-meta">
      {isAgentControlled && (
        <div className="device-viewport-control-capsule" data-mode="auto">
          <span className="device-viewport-control-dot" aria-hidden="true" />
          <span className="device-viewport-control-label">{t("controlAutoShiori")}</span>
          {onReclaimControl && (
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
      )}

      {onToggleImmersive && (
        <button
          type="button"
          className="device-viewport-icon-btn device-viewport-immersive-btn"
          data-viewport-immersive-toggle=""
          data-immersive-toggle=""
          data-active={immersive ? "true" : undefined}
          aria-pressed={immersive}
          title={t(immersive ? "exitImmersiveHint" : "immersiveModeHint")}
          aria-label={t(immersive ? "exitImmersiveHint" : "immersiveModeHint")}
          onClick={onToggleImmersive}
        >
          {immersive ? (
            <Columns2 className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Expand className="size-3.5 shrink-0" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

export function ViewportTopbarControls({
  stageKind,
  state,
  isAuto,
  reclaiming = false,
  immersive = true,
  stageRef,
  onAction,
  onToggleImmersive,
  onReclaimControl,
}: {
  stageKind: "browser" | "computer";
  state: ViewportState | null;
  isAuto: boolean;
  reclaiming?: boolean;
  immersive?: boolean;
  stageRef?: RefObject<HTMLDivElement | null>;
  onAction: (action: ViewportControlAction) => Promise<void> | void;
  onToggleImmersive?: () => void;
  onReclaimControl?: () => void | Promise<void>;
}): ViewportTopbarSlots {
  return {
    leadingExtraSlot:
      stageKind === "browser" ? (
        <ViewportBrowserNavButtons state={state} isAuto={isAuto} onAction={onAction} />
      ) : undefined,
    centerSlot:
      stageKind === "browser" ? (
        <ViewportOmnibox state={state} isAuto={isAuto} stageRef={stageRef} onAction={onAction} />
      ) : (
        <ViewportComputerBadge state={state} />
      ),
    trailingExtraSlot: (
      <ViewportMetaControls
        state={state}
        isAuto={isAuto}
        reclaiming={reclaiming}
        immersive={immersive}
        onToggleImmersive={onToggleImmersive}
        onReclaimControl={onReclaimControl}
      />
    ),
  };
}

export interface DeviceViewportProps {
  viewport: UseDeviceViewportResult;
  stageKind: "browser" | "computer";
  isAuto: boolean;
  reclaiming?: boolean;
  suspended?: boolean;
  immersive?: boolean;
  hideChrome?: boolean;
  leadingSlot?: ReactNode;
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
  hideChrome = false,
  leadingSlot,
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
  } = viewport;

  const width = state?.width || DEFAULT_VIEWPORT_WIDTH;
  const height = state?.height || DEFAULT_VIEWPORT_HEIGHT;
  const available = Boolean(state?.available);
  const controlMode = state?.controlMode ?? (available ? (isAuto ? "auto" : "manual") : "offline");
  const isManual = available && controlMode === "manual";
  const isAgentControlled = available && (controlMode === "auto" || isAuto);

  const [lockedHintVisible, setLockedHintVisible] = useState(false);
  const lockedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerLockedHint = useCallback(() => {
    setLockedHintVisible(true);
    if (lockedHintTimerRef.current) {
      clearTimeout(lockedHintTimerRef.current);
    }
    lockedHintTimerRef.current = setTimeout(() => {
      lockedHintTimerRef.current = null;
      setLockedHintVisible(false);
    }, 2200);
  }, []);

  useEffect(() => {
    if (!isAgentControlled) {
      setLockedHintVisible(false);
      if (lockedHintTimerRef.current) {
        clearTimeout(lockedHintTimerRef.current);
        lockedHintTimerRef.current = null;
      }
    }
  }, [isAgentControlled]);

  useEffect(
    () => () => {
      if (lockedHintTimerRef.current) {
        clearTimeout(lockedHintTimerRef.current);
      }
    },
    [],
  );

  const showStreamCanvas =
    available && (transportMode === "stream" || (transportMode === "native-electron" && occluded));
  const showConnectingOverlay =
    available && transportMode === "stream" && !hasFrame && !suspended;
  const showNativeHint =
    available && transportMode === "native-electron" && !occluded && !suspended;
  const showOfflineCard = !available;

  const isFullBleedBrowser = immersive && stageKind === "browser";

  return (
    <section
      className="device-viewport"
      data-device-viewport=""
      data-stage-kind={stageKind}
      data-control-mode={controlMode}
      data-transport={transportMode}
      data-immersive={immersive ? "true" : undefined}
      data-hide-chrome={hideChrome ? "true" : undefined}
      data-suspended={suspended ? "true" : undefined}
      aria-label={t(stageKind === "browser" ? "browserAria" : "computerAria")}
    >
      {/* Top Chrome Bar (hidden on Desktop Immersive when merged into 38px DesktopTitlebar) */}
      {!hideChrome && (
        <header className="device-viewport-chrome">
          {stageKind === "browser" ? (
            <>
              <div className="device-viewport-nav-group">
                {leadingSlot}
                <ViewportBrowserNavButtons
                  state={state}
                  isAuto={isAuto}
                  onAction={performAction}
                />
              </div>

              <ViewportOmnibox
                state={state}
                isAuto={isAuto}
                stageRef={stageRef}
                onAction={performAction}
              />
            </>
          ) : (
            <ViewportComputerBadge state={state} leadingSlot={leadingSlot} />
          )}

          <ViewportMetaControls
            state={state}
            isAuto={isAuto}
            reclaiming={reclaiming}
            immersive={immersive}
            onToggleImmersive={onToggleImmersive}
            onReclaimControl={onReclaimControl}
          />
        </header>
      )}

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
              ...(isFullBleedBrowser ? {} : { aspectRatio: `${width} / ${height}` }),
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
                triggerLockedHint();
              }}
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                triggerLockedHint();
              }}
            >
              {lockedHintVisible && (
                <div
                  className="device-viewport-locked-hint"
                  data-viewport-locked-hint=""
                  role="status"
                >
                  <Hand className="size-3 shrink-0" aria-hidden="true" />
                  <span>{t("autoControlClickHint")}</span>
                </div>
              )}
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
