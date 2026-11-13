"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, PackagePlus } from "lucide-react";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BasewareModalDialog } from "./baseware-modal-dialog";
import { validateDriverSpecInput } from "./baseware-model";

export interface DriverRegisterDialogProps {
  open: boolean;
  onClose(): void;
  onRegister(spec: string): Promise<unknown>;
  initialSpec?: string;
}

const QUICK_EXAMPLES = [
  { label: "file:", value: "file:/abs/path/to/ludens-driver" },
  { label: "npm", value: "@ludens-community/driver-switch2" },
  { label: "github:", value: "github:org/ludens-driver#main" },
];

export function DriverRegisterDialog({
  open,
  onClose,
  onRegister,
  initialSpec = "",
}: DriverRegisterDialogProps) {
  const t = useTranslations("basewareView");
  const [spec, setSpec] = useState(initialSpec);
  const [touched, setTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const generationRef = useRef(0);
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    generationRef.current += 1;
    if (open) {
      setSpec(initialSpec);
      setTouched(false);
      setSubmitted(false);
      setServerError("");
      setSubmitting(false);
    } else {
      setSubmitting(false);
    }
  }, [open, initialSpec]);

  const validation = validateDriverSpecInput(spec);
  const showClientError = (touched || submitted) && !validation.valid;
  const errorText = showClientError
    ? t(validation.error === "required" ? "driverSpecRequired" : "driverSpecInvalid")
    : serverError;
  const isInvalid = Boolean(errorText);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitted(true);
    setServerError("");

    const check = validateDriverSpecInput(spec);
    if (!check.valid) {
      inputRef.current?.focus();
      return;
    }

    const requestGeneration = generationRef.current;
    setSubmitting(true);
    try {
      await onRegister(spec.trim());
      if (generationRef.current === requestGeneration) {
        onClose();
      }
    } catch (error) {
      if (generationRef.current === requestGeneration) {
        setServerError(error instanceof Error ? error.message : String(error));
        inputRef.current?.focus();
      }
    } finally {
      if (generationRef.current === requestGeneration) {
        setSubmitting(false);
      }
    }
  };

  return (
    <BasewareModalDialog
      open={open}
      onClose={onClose}
      title={t("driverVerifyAndRegisterTitle")}
      subtitle={t("driverVerifyAndRegisterSubtitle")}
      closeLabel={t("closeDialog")}
      closedBy="any"
      size="sm"
    >
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="baseware-driver-spec-input" className="block text-xs font-medium text-foreground">
            {t("driverSpecLabel")}
          </label>
          <p id={hintId} className="baseware-field-hint">
            {t("driverSpecHint")}
          </p>
          <input
            ref={inputRef}
            id="baseware-driver-spec-input"
            type="text"
            autoFocus
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            className="baseware-input font-mono"
            placeholder="file:/path/to/ludens-switch2-driver"
            value={spec}
            aria-invalid={isInvalid}
            aria-describedby={isInvalid ? `${hintId} ${errorId}` : hintId}
            onBlur={() => setTouched(true)}
            onChange={event => {
              setSpec(event.target.value);
              if (serverError) setServerError("");
            }}
          />
          {isInvalid && (
            <p id={errorId} className="baseware-field-error" role="status">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
              <span>{errorText}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("driverExamplesLabel")}</span>
          {QUICK_EXAMPLES.map(example => (
            <Button
              key={example.label}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 font-mono text-[11px]"
              onClick={() => {
                setSpec(example.value);
                setServerError("");
                inputRef.current?.focus();
              }}
            >
              {example.label}
            </Button>
          ))}
        </div>

        {submitting && (
          <Alert>
            <CheckCircle2 className="size-4 animate-pulse" aria-hidden="true" />
            <AlertDescription className="text-xs">
              {t("driverRegisterSubmitting")}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={submitting}
            data-baseware-submit-driver
          >
            <PackagePlus className="size-3.5" aria-hidden="true" />
            {submitting ? t("driverRegisterSubmitting") : t("driverRegisterSubmit")}
          </Button>
        </div>
      </form>
    </BasewareModalDialog>
  );
}
