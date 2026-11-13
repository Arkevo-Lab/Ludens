"use client";

import { useEffect, useId, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useTranslations } from "@/lib/locale";
import type { DeviceContentionConflict } from "@/lib/types";

function formatTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

export interface DeviceContentionDialogProps {
  conflict: DeviceContentionConflict | null;
  busy?: boolean;
  error?: string | null;
  onConfirmPreempt: () => void | Promise<boolean | void>;
  onDismiss: () => void;
  onSwitchToHolder?: (holderProjectId: string) => void;
}

/**
 * Native modal `<dialog closedby="any">` prompt shown when Core cold-start or
 * resume encounters HTTP `409 DEVICE_BUSY` on a contended physical device.
 */
export function DeviceContentionDialog({
  conflict,
  busy = false,
  error = null,
  onConfirmPreempt,
  onDismiss,
  onSwitchToHolder,
}: DeviceContentionDialogProps) {
  const t = useTranslations("deviceContention");
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = useRef(false);
  const openedConflictRef = useRef<DeviceContentionConflict | null>(null);
  const prevErrorRef = useRef<string | null>(null);
  const closingProgrammaticallyRef = useRef(false);

  // Open via `showModal()` when a new conflict arrives or when preemption fails with a new error.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const isNewConflict = Boolean(conflict && conflict !== openedConflictRef.current);
    const hasNewError = Boolean(conflict && error && error !== prevErrorRef.current);
    prevErrorRef.current = error;

    if (!conflict) {
      openedConflictRef.current = null;
      if (dialog.open) {
        closingProgrammaticallyRef.current = true;
        dialog.returnValue = "";
        dialog.close();
      }
      return;
    }

    if ((isNewConflict || hasNewError) && !dialog.open) {
      openedConflictRef.current = conflict;
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [conflict, error]);

  // Fallback light-dismiss for runtimes lacking `HTMLDialogElement.prototype.closedBy`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype) {
      return;
    }

    const isOutsideDialogRect = (event: PointerEvent): boolean => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };

    const handlePointerDown = (event: PointerEvent) => {
      pointerDownOutsideRef.current = event.target === dialog && isOutsideDialogRect(event);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const shouldClose =
        pointerDownOutsideRef.current && event.target === dialog && isOutsideDialogRect(event);
      pointerDownOutsideRef.current = false;
      if (shouldClose && dialog.open) {
        dialog.close("cancel");
      }
    };

    dialog.addEventListener("pointerdown", handlePointerDown);
    dialog.addEventListener("pointerup", handlePointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", handlePointerDown);
      dialog.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const action = dialog.returnValue;
    dialog.returnValue = "";

    if (closingProgrammaticallyRef.current) {
      closingProgrammaticallyRef.current = false;
      return;
    }

    if (action === "preempt") {
      void onConfirmPreempt();
      return;
    }

    if (action === "switch" && conflict && onSwitchToHolder) {
      onDismiss();
      onSwitchToHolder(conflict.holderProjectId);
      return;
    }

    onDismiss();
  };

  const holderName = conflict?.holderWorkspaceName || conflict?.holderProjectId || "";
  const deviceName = conflict?.deviceLabel || conflict?.deviceKey || "";
  const modeLabel = conflict?.holderMode === "auto" ? t("modeAuto") : t("modeManual");
  const originLabel =
    conflict?.holderOrigin === "cli"
      ? t("originCli")
      : conflict?.holderOrigin === "app"
        ? t("originApp")
        : null;

  return (
    <dialog
      ref={dialogRef}
      className="device-contention-dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClose={handleClose}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      {conflict ? (
        <form method="dialog">
          <div className="dcd-header">
            <div className="dcd-title-row">
              <span className="dcd-badge-icon" aria-hidden="true">
                <AlertTriangle size={16} />
              </span>
              <h2 id={titleId} className="dcd-title">
                {t("title")}
              </h2>
            </div>
            <button
              type="submit"
              value="cancel"
              className="dcd-close-btn"
              aria-label={t("closeAria")}
              formNoValidate
            >
              <X size={16} />
            </button>
          </div>

          <div className="dcd-body">
            <p id={descId} className="dcd-description">
              {formatTemplate(t("description"), { device: deviceName, holder: holderName, mode: modeLabel })}
            </p>

            <dl className="dcd-facts">
              <dt>{t("holderLabel")}</dt>
              <dd>{holderName}</dd>
              <dt>{t("deviceLabel")}</dt>
              <dd>{deviceName}</dd>
              <dt>{t("holderModeLabel")}</dt>
              <dd>{modeLabel}</dd>
              {originLabel ? (
                <>
                  <dt>{t("holderOriginLabel")}</dt>
                  <dd>{originLabel}</dd>
                </>
              ) : null}
            </dl>

            <p className="dcd-warning">{formatTemplate(t("preemptWarning"), { holder: holderName })}</p>

            {error ? (
              <p className="dcd-error" role="alert">
                {error || t("preemptFailed")}
              </p>
            ) : null}
          </div>

          <div className="dcd-footer">
            <button
              type="submit"
              value="cancel"
              className="dcd-btn"
              autoFocus
            >
              {t("cancelBtn")}
            </button>
            {onSwitchToHolder ? (
              <button
                type="submit"
                value="switch"
                className="dcd-btn"
                disabled={busy}
              >
                {formatTemplate(t("switchHolderBtn"), { holder: holderName })}
              </button>
            ) : null}
            <button
              type="submit"
              value="preempt"
              className="dcd-btn dcd-btn-primary"
              disabled={busy}
            >
              {busy ? t("preemptingBtn") : t("preemptBtn")}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
