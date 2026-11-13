"use client";

import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface BasewareModalDialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  subtitle?: string;
  closeLabel: string;
  closedBy?: "any" | "closerequest" | "none";
  size?: "md" | "sm";
  children: React.ReactNode;
}

function isPointOutsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX < rect.left
    || clientX > rect.right
    || clientY < rect.top
    || clientY > rect.bottom
  );
}

/**
 * Native `<dialog>` modal wrapper following Modern Web Guidance:
 * uses `showModal()` and native `closedby` with a pointer-rectangle
 * light-dismiss fallback when `closedBy` is unsupported.
 */
export function BasewareModalDialog({
  open,
  onClose,
  title,
  subtitle,
  closeLabel,
  closedBy = "any",
  size = "md",
  children,
}: BasewareModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerStartedOutsideRef = useRef(false);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Light-dismiss fallback when browser lacks HTMLDialogElement.prototype.closedBy
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || closedBy !== "any") return;
    if (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      pointerStartedOutsideRef.current = isPointOutsideRect(event.clientX, event.clientY, rect);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const startedOutside = pointerStartedOutsideRef.current;
      pointerStartedOutsideRef.current = false;
      if (!startedOutside) return;
      const rect = dialog.getBoundingClientRect();
      if (isPointOutsideRect(event.clientX, event.clientY, rect)) {
        dialog.close();
      }
    };

    dialog.addEventListener("pointerdown", handlePointerDown);
    dialog.addEventListener("pointerup", handlePointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", handlePointerDown);
      dialog.removeEventListener("pointerup", handlePointerUp);
    };
  }, [open, closedBy]);

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog && dialog.returnValue) {
      dialog.returnValue = "";
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      onClose={handleClose}
      className={`baseware-dialog ${size === "sm" ? "baseware-dialog--sm" : ""}`}
      {...({ closedby: closedBy } as Record<string, string>)}
    >
      <div className="baseware-dialog-header">
        <div className="min-w-0 space-y-0.5">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
          {subtitle && (
            <p id={subtitleId} className="text-xs text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2"
          onClick={() => dialogRef.current?.close()}
          aria-label={closeLabel}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="baseware-dialog-body">{open ? children : null}</div>
    </dialog>
  );
}
