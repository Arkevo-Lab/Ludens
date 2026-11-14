"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { Eye, EyeOff, Link2, RefreshCw, Unplug, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  clearStoredConnectionTarget,
  isSameOriginAvailable,
  normalizeRemoteUrl,
  type ConnectionTarget,
} from "@/lib/connection-target";
import { useTranslations } from "@/lib/locale";
import {
  useConnectionTarget,
  useLudensRpc,
  type RpcConnectionStatus,
} from "@/lib/ludens-rpc";

export interface ConnectionTargetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type TargetMode = ConnectionTarget["kind"];

function statusDotClass(status: RpcConnectionStatus): string {
  if (status === "connected") return "is-connected";
  if (status === "connecting" || status === "reconnecting") return "is-connecting";
  return "is-disconnected";
}

function statusTranslationKey(status: RpcConnectionStatus): string {
  switch (status) {
    case "connected":
      return "statusConnected";
    case "connecting":
      return "statusConnecting";
    case "reconnecting":
      return "statusReconnecting";
    case "auth-required":
      return "statusAuthRequired";
    case "unconfigured":
      return "statusUnconfigured";
    default:
      return "statusDisconnected";
  }
}

export function ConnectionTargetDialog({ open, onOpenChange }: ConnectionTargetDialogProps) {
  const t = useTranslations("connectionTarget");
  const titleId = useId();
  const urlInputId = useId();
  const tokenInputId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOnBackdrop = useRef(false);

  const {
    target,
    resolved,
    isDesktop,
    setTarget,
    setRemoteTarget,
    setSameOriginTarget,
    switchToElectronLocal,
  } = useConnectionTarget();
  const { status, error: rpcError, needsAuth, reconnect } = useLudensRpc();

  const sameOriginAvailable = isSameOriginAvailable();

  const [mode, setMode] = useState<TargetMode>(target.kind);
  const [urlInput, setUrlInput] = useState(target.kind === "remote" ? target.url : "");
  const [tokenInput, setTokenInput] = useState(
    target.kind === "remote" || target.kind === "same-origin" ? target.token ?? "" : "",
  );
  const [showToken, setShowToken] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(target.kind);
    setUrlInput(target.kind === "remote" ? target.url : "");
    setTokenInput(
      target.kind === "remote" || target.kind === "same-origin" ? target.token ?? "" : "",
    );
    setShowToken(false);
    setValidationError(null);
  }, [open, target]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }

    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    pointerDownOnBackdrop.current = false;
    onOpenChange(false);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDialogElement>) => {
    pointerDownOnBackdrop.current = event.target === dialogRef.current;
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in dialog) return;
    if (!pointerDownOnBackdrop.current || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const insideDialog =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!insideDialog) {
      dialog.close();
    }
  };

  const normalizedPreview = mode === "remote" && urlInput.trim() ? normalizeRemoteUrl(urlInput) : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);

    if (mode === "electron-local") {
      switchToElectronLocal();
      onOpenChange(false);
      return;
    }

    const trimmedToken = tokenInput.trim() || undefined;
    if (mode === "same-origin") {
      setSameOriginTarget(trimmedToken);
      onOpenChange(false);
      return;
    }

    const check = normalizeRemoteUrl(urlInput);
    if (!check.ok) {
      if (check.error === "empty") {
        setValidationError(t("errorEmptyUrl"));
      } else if (check.error === "unsupported-protocol") {
        setValidationError(t("errorUnsupportedProtocol"));
      } else {
        setValidationError(t("errorInvalidUrl"));
      }
      return;
    }

    setRemoteTarget(check.canonicalUrl, trimmedToken);
    onOpenChange(false);
  };

  const handleClearRemote = () => {
    clearStoredConnectionTarget();
    if (isDesktop) {
      switchToElectronLocal();
    } else if (sameOriginAvailable) {
      setSameOriginTarget(undefined);
    } else {
      setTarget({ kind: "remote", url: "" });
    }
    onOpenChange(false);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="connection-target-dialog"
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={handleClose}
      onPointerDown={handlePointerDown}
      onClick={handleBackdropClick}
    >
      <div className="connection-target-surface">
        <header className="connection-target-header">
          <div className="connection-target-heading">
            <h2 id={titleId}>{t("dialogTitle")}</h2>
            <p>{t("dialogDescription")}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("closeAria")}
            onClick={() => onOpenChange(false)}
          >
            <XIcon className="size-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="connection-target-status-bar">
          <span className="connection-target-status-label">{t("statusLabel")}</span>
          <span className="connection-target-status-pill">
            <span className={`connection-status-dot ${statusDotClass(status)}`} aria-hidden="true" />
            <span>{t(statusTranslationKey(status))}</span>
          </span>
        </div>

        {(validationError || (needsAuth && t("bannerAuthRequired")) || rpcError) && (
          <Alert variant="destructive" className="my-3">
            <AlertDescription>
              {validationError ?? (needsAuth ? t("bannerAuthRequired") : rpcError)}
            </AlertDescription>
          </Alert>
        )}

        <form className="connection-target-form" onSubmit={handleSubmit}>
          <fieldset className="connection-target-modes">
            <legend>{t("modeLabel")}</legend>

            {isDesktop && (
              <label className={`connection-mode-option ${mode === "electron-local" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="connection-mode"
                  value="electron-local"
                  checked={mode === "electron-local"}
                  onChange={() => {
                    setMode("electron-local");
                    setValidationError(null);
                  }}
                />
                <span>
                  <strong>{t("modeElectronLocal")}</strong>
                  <small>{t("modeElectronLocalDesc")}</small>
                </span>
              </label>
            )}

            {sameOriginAvailable && (
              <label className={`connection-mode-option ${mode === "same-origin" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="connection-mode"
                  value="same-origin"
                  checked={mode === "same-origin"}
                  onChange={() => {
                    setMode("same-origin");
                    setValidationError(null);
                  }}
                />
                <span>
                  <strong>{t("modeSameOrigin")}</strong>
                  <small>
                    {t("modeSameOriginDesc").replace(
                      "{origin}",
                      typeof window !== "undefined" ? window.location.host : resolved.displayTarget,
                    )}
                  </small>
                </span>
              </label>
            )}

            <label className={`connection-mode-option ${mode === "remote" ? "is-selected" : ""}`}>
              <input
                type="radio"
                name="connection-mode"
                value="remote"
                checked={mode === "remote"}
                onChange={() => {
                  setMode("remote");
                  setValidationError(null);
                }}
              />
              <span>
                <strong>{t("modeRemote")}</strong>
                <small>{t("modeRemoteDesc")}</small>
              </span>
            </label>
          </fieldset>

          {mode === "remote" && (
            <div className="connection-target-field">
              <label htmlFor={urlInputId}>{t("urlLabel")}</label>
              <input
                id={urlInputId}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                autoFocus={!needsAuth}
                placeholder={t("urlPlaceholder")}
                value={urlInput}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
              {normalizedPreview?.ok && (
                <p className="connection-target-preview">
                  {t("urlPreviewLabel").replace("{wsUrl}", normalizedPreview.wsUrl)}
                </p>
              )}
            </div>
          )}

          {(mode === "remote" || mode === "same-origin") && (
            <div className="connection-target-field">
              <label htmlFor={tokenInputId}>{t("tokenLabel")}</label>
              <div className="connection-token-input-wrap">
                <input
                  id={tokenInputId}
                  type={showToken ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={needsAuth || mode === "same-origin"}
                  placeholder={t("tokenPlaceholder")}
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                />
                <button
                  type="button"
                  className="connection-token-toggle"
                  aria-label={t(showToken ? "hideToken" : "showToken")}
                  onClick={() => setShowToken((prev) => !prev)}
                >
                  {showToken ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          )}

          <footer className="connection-target-actions">
            <div className="connection-target-actions-secondary">
              {target.kind === "remote" && (
                <Button type="button" variant="outline" size="sm" onClick={handleClearRemote}>
                  <Unplug className="size-3.5" aria-hidden="true" />
                  {t("clearRemoteBtn")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => reconnect()}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t("reconnectBtn")}
              </Button>
            </div>
            <div className="connection-target-actions-primary">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("cancelBtn")}
              </Button>
              <Button type="submit" size="sm">
                <Link2 className="size-3.5" aria-hidden="true" />
                {t("applyBtn")}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
