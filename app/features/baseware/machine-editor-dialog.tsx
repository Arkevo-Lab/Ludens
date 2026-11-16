"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Play, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { MACHINE_TRANSPORT_KINDS, type BasewareMachineSpec, type MachineTransportKind } from "@ludens/protocol/machines";
import type { BasewareDriverOverviewItem } from "@/lib/workspaces";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BasewareModalDialog } from "./baseware-modal-dialog";
import {
  buildMachineSpecFromDraft,
  draftFromDriver,
  validateMachineDraft,
  type MachineBindMode,
  type MachineDraft,
  type MachineDraftErrorCode,
  type MachineDraftErrorField,
} from "./baseware-model";
import type { ProbeOutcome } from "./use-baseware-overview";

export interface MachineEditorDialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  initialDraft: MachineDraft;
  editingGlobalId: string | null;
  hasWorkspace: boolean;
  drivers: BasewareDriverOverviewItem[];
  existingMachineIds: string[];
  onSave(machine: BasewareMachineSpec, bindMode: MachineBindMode): Promise<unknown>;
  onProbe(machine: BasewareMachineSpec): Promise<ProbeOutcome>;
}

function errorKeyForCode(code: MachineDraftErrorCode): string {
  switch (code) {
    case "required":
      return "errRequired";
    case "invalidId":
      return "errInvalidId";
    case "reservedId":
      return "errReservedId";
    case "invalidPort":
      return "errInvalidPort";
    case "invalidUrl":
      return "errInvalidUrl";
    case "invalidSpec":
      return "errInvalidSpec";
  }
}

export function MachineEditorDialog({
  open,
  onClose,
  title,
  initialDraft,
  editingGlobalId,
  hasWorkspace,
  drivers,
  existingMachineIds,
  onSave,
  onProbe,
}: MachineEditorDialogProps) {
  const t = useTranslations("basewareView");
  const [draft, setDraft] = useState<MachineDraft>(initialDraft);
  const [touched, setTouched] = useState<Partial<Record<MachineDraftErrorField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [probeState, setProbeState] = useState<"idle" | "probing" | ProbeOutcome>("idle");

  const baseId = useId();
  const fieldRefs = useRef<Partial<Record<MachineDraftErrorField, HTMLInputElement | null>>>({});
  const isEditingExisting = Boolean(editingGlobalId);

  useEffect(() => {
    if (open) {
      setDraft(initialDraft);
      setTouched({});
      setSubmitted(false);
      setSaving(false);
      setServerError("");
      setProbeState("idle");
    }
  }, [open, initialDraft]);

  const validation = useMemo(
    () => validateMachineDraft(draft, isEditingExisting),
    [draft, isEditingExisting],
  );

  const fieldError = (field: MachineDraftErrorField): string => {
    if (!(submitted || touched[field])) return "";
    const code = validation.errors[field];
    return code ? t(errorKeyForCode(code)) : "";
  };

  const markTouched = (field: MachineDraftErrorField) => {
    setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }));
  };

  const applyDriverPreset = (driver: BasewareDriverOverviewItem) => {
    const seeded = draftFromDriver(driver, existingMachineIds);
    setDraft(prev => ({
      ...seeded,
      id: isEditingExisting ? prev.id : seeded.id,
      name: isEditingExisting ? prev.name : seeded.name,
      bindMode: prev.bindMode,
    }));
    setProbeState("idle");
    setServerError("");
  };

  const applyTransportPreset = (preset: "ssh" | "http") => {
    if (preset === "ssh") {
      setDraft(prev => ({
        ...prev,
        id: isEditingExisting ? prev.id : prev.id || "remote-mac",
        name: isEditingExisting ? prev.name : prev.name || "Remote Desktop (SSH CUA)",
        driver: "cua",
        driverPackage: "",
        transportKind: "ssh",
        sshHost: prev.sshHost || "192.168.1.50",
        sshPort: prev.sshPort || "22",
        sshCommand: prev.sshCommand || "cua-driver",
      }));
    } else {
      setDraft(prev => ({
        ...prev,
        id: isEditingExisting ? prev.id : prev.id || "remote-mcp",
        name: isEditingExisting ? prev.name : prev.name || "Remote HTTP MCP Bridge",
        transportKind: "http",
        httpUrl: prev.httpUrl || "http://127.0.0.1:8910/mcp",
      }));
    }
    setProbeState("idle");
    setServerError("");
  };

  const focusFirstInvalid = (errors: Partial<Record<MachineDraftErrorField, MachineDraftErrorCode>>) => {
    const order: MachineDraftErrorField[] = [
      "id",
      "name",
      "driver",
      "driverPackage",
      "stdioCommand",
      "bridgeHost",
      "bridgePort",
      "sshHost",
      "sshPort",
      "httpUrl",
    ];
    for (const key of order) {
      if (errors[key] && fieldRefs.current[key]) {
        fieldRefs.current[key]?.focus();
        break;
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError("");
    if (!validation.valid) {
      focusFirstInvalid(validation.errors);
      return;
    }

    setSaving(true);
    try {
      const spec = buildMachineSpecFromDraft(draft);
      await onSave(spec, hasWorkspace ? draft.bindMode : "none");
      onClose();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : t("saveMachineFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleProbe = async () => {
    setSubmitted(true);
    if (!validation.valid) {
      focusFirstInvalid(validation.errors);
      return;
    }
    setProbeState("probing");
    try {
      const res = await onProbe(buildMachineSpecFromDraft(draft));
      setProbeState(res);
    } catch (error) {
      setProbeState({
        ok: false,
        latencyMs: 0,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const idHintId = `${baseId}-id-hint`;
  const idErrId = `${baseId}-id-err`;
  const driverHintId = `${baseId}-driver-hint`;
  const driverErrId = `${baseId}-driver-err`;
  const bridgePortHintId = `${baseId}-bridge-port-hint`;
  const bridgePortErrId = `${baseId}-bridge-port-err`;
  const sshPortHintId = `${baseId}-ssh-port-hint`;
  const sshPortErrId = `${baseId}-ssh-port-err`;

  const idErr = fieldError("id");
  const nameErr = fieldError("name");
  const driverErr = fieldError("driver");
  const pkgErr = fieldError("driverPackage");
  const stdioCmdErr = fieldError("stdioCommand");
  const bridgeHostErr = fieldError("bridgeHost");
  const bridgePortErr = fieldError("bridgePort");
  const sshHostErr = fieldError("sshHost");
  const sshPortErr = fieldError("sshPort");
  const httpUrlErr = fieldError("httpUrl");

  return (
    <BasewareModalDialog
      open={open}
      onClose={onClose}
      title={title}
      subtitle={t("editorSubtitle")}
      closeLabel={t("closeDialog")}
      closedBy="any"
      size="md"
    >
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        {/* Driver & Protocol Presets */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t("editorDriverPresetsLabel")}</p>
          <div className="flex flex-wrap gap-1.5">
            {drivers.map(driver => (
              <Button
                key={driver.key}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => applyDriverPreset(driver)}
              >
                <Sparkles className="size-3 text-primary" aria-hidden="true" />
                <span>{driver.id}</span>
                {driver.defaultPort !== undefined && (
                  <span className="font-mono text-[10px] text-muted-foreground">:{driver.defaultPort}</span>
                )}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => applyTransportPreset("ssh")}
            >
              {t("presetRemoteSsh")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => applyTransportPreset("http")}
            >
              {t("presetHttpMcp")}
            </Button>
          </div>
        </div>

        {serverError && (
          <Alert variant="destructive">
            <XCircle className="size-4" aria-hidden="true" />
            <AlertDescription className="text-xs">{serverError}</AlertDescription>
          </Alert>
        )}

        {probeState !== "idle" && probeState !== "probing" && (
          <Alert variant={probeState.ok ? "default" : "destructive"}>
            {probeState.ok
              ? <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
              : <XCircle className="size-4" aria-hidden="true" />}
            <AlertDescription className="font-mono text-xs">
              {probeState.ok ? t("probeOk") : t("probeFailed")} ({probeState.latencyMs}ms): {probeState.detail}
            </AlertDescription>
          </Alert>
        )}

        {/* Identity Row */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${baseId}-id`} className="block text-xs font-medium">
              {t("fieldId")}
            </label>
            {!isEditingExisting && (
              <p id={idHintId} className="baseware-field-hint">
                {t("editorHintId")}
              </p>
            )}
            <input
              ref={el => { fieldRefs.current.id = el; }}
              id={`${baseId}-id`}
              type="text"
              autoFocus={!isEditingExisting}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={isEditingExisting}
              className="baseware-input font-mono disabled:opacity-60"
              placeholder="switch2-capture"
              value={draft.id}
              aria-invalid={Boolean(idErr)}
              aria-describedby={
                !isEditingExisting
                  ? (idErr ? `${idHintId} ${idErrId}` : idHintId)
                  : (idErr ? idErrId : undefined)
              }
              onBlur={() => markTouched("id")}
              onChange={event => setDraft(prev => ({ ...prev, id: event.target.value }))}
            />
            {idErr && (
              <p id={idErrId} className="baseware-field-error">
                <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                <span>{idErr}</span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor={`${baseId}-name`} className="block text-xs font-medium">
              {t("fieldName")}
            </label>
            {!isEditingExisting && <p className="baseware-field-hint opacity-0 select-none" aria-hidden="true">.</p>}
            <input
              ref={el => { fieldRefs.current.name = el; }}
              id={`${baseId}-name`}
              type="text"
              autoFocus={isEditingExisting}
              className="baseware-input"
              placeholder="Nintendo Switch 2 Capture"
              value={draft.name}
              aria-invalid={Boolean(nameErr)}
              aria-describedby={nameErr ? `${baseId}-name-err` : undefined}
              onBlur={() => markTouched("name")}
              onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
            />
            {nameErr && (
              <p id={`${baseId}-name-err`} className="baseware-field-error">
                <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                <span>{nameErr}</span>
              </p>
            )}
          </div>
        </div>

        {/* Driver & Transport */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${baseId}-driver`} className="block text-xs font-medium">
              {t("fieldDriver")}
            </label>
            <p id={driverHintId} className="baseware-field-hint">
              {t("editorHintDriver")}
            </p>
            <input
              ref={el => { fieldRefs.current.driver = el; }}
              id={`${baseId}-driver`}
              type="text"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="baseware-input font-mono"
              value={draft.driver}
              aria-invalid={Boolean(driverErr)}
              aria-describedby={driverErr ? `${driverHintId} ${driverErrId}` : driverHintId}
              onBlur={() => markTouched("driver")}
              onChange={event => setDraft(prev => ({ ...prev, driver: event.target.value }))}
            />
            {driverErr && (
              <p id={driverErrId} className="baseware-field-error">
                <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                <span>{driverErr}</span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor={`${baseId}-transport`} className="block text-xs font-medium">
              {t("fieldTransport")}
            </label>
            <p className="baseware-field-hint opacity-0 select-none" aria-hidden="true">.</p>
            <select
              id={`${baseId}-transport`}
              className="baseware-input"
              value={draft.transportKind}
              onChange={event =>
                setDraft(prev => ({
                  ...prev,
                  transportKind: event.target.value as MachineTransportKind,
                }))
              }
            >
              {MACHINE_TRANSPORT_KINDS.map(kind => (
                <option key={kind} value={kind}>
                  {kind.toUpperCase()} — {t(`transportKinds.${kind}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Driver Package Spec */}
        <div className="space-y-1">
          <label htmlFor={`${baseId}-pkg`} className="block text-xs font-medium">
            {t("fieldDriverPackage")}
          </label>
          <input
            ref={el => { fieldRefs.current.driverPackage = el; }}
            id={`${baseId}-pkg`}
            type="text"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="baseware-input font-mono"
            placeholder="file:/abs/path or @ludens/driver-..."
            value={draft.driverPackage}
            aria-invalid={Boolean(pkgErr)}
            aria-describedby={pkgErr ? `${baseId}-pkg-err` : undefined}
            onBlur={() => markTouched("driverPackage")}
            onChange={event => setDraft(prev => ({ ...prev, driverPackage: event.target.value }))}
          />
          {pkgErr && (
            <p id={`${baseId}-pkg-err`} className="baseware-field-error">
              <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
              <span>{pkgErr}</span>
            </p>
          )}
        </div>

        {/* Transport-specific parameters */}
        {draft.transportKind === "stdio" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${baseId}-stdio-cmd`} className="block text-xs font-medium">
                {t("fieldStdioCommand")}
              </label>
              <input
                ref={el => { fieldRefs.current.stdioCommand = el; }}
                id={`${baseId}-stdio-cmd`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                value={draft.stdioCommand}
                aria-invalid={Boolean(stdioCmdErr)}
                aria-describedby={stdioCmdErr ? `${baseId}-stdio-cmd-err` : undefined}
                onBlur={() => markTouched("stdioCommand")}
                onChange={event => setDraft(prev => ({ ...prev, stdioCommand: event.target.value }))}
              />
              {stdioCmdErr && (
                <p id={`${baseId}-stdio-cmd-err`} className="baseware-field-error">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span>{stdioCmdErr}</span>
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${baseId}-stdio-args`} className="block text-xs font-medium">
                {t("fieldStdioArgs")}
              </label>
              <input
                id={`${baseId}-stdio-args`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                placeholder="--display 1"
                value={draft.stdioArgs}
                onChange={event => setDraft(prev => ({ ...prev, stdioArgs: event.target.value }))}
              />
            </div>
          </div>
        )}

        {draft.transportKind === "bridge" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor={`${baseId}-bridge-host`} className="block text-xs font-medium">
                {t("fieldBridgeHost")}
              </label>
              <input
                ref={el => { fieldRefs.current.bridgeHost = el; }}
                id={`${baseId}-bridge-host`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                value={draft.bridgeHost}
                aria-invalid={Boolean(bridgeHostErr)}
                aria-describedby={bridgeHostErr ? `${baseId}-bridge-host-err` : undefined}
                onBlur={() => markTouched("bridgeHost")}
                onChange={event => setDraft(prev => ({ ...prev, bridgeHost: event.target.value }))}
              />
              {bridgeHostErr && (
                <p id={`${baseId}-bridge-host-err`} className="baseware-field-error">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span>{bridgeHostErr}</span>
                </p>
              )}
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label htmlFor={`${baseId}-bridge-port`} className="block text-xs font-medium">
                {t("fieldBridgePort")}
              </label>
              <p id={bridgePortHintId} className="baseware-field-hint">
                {t("editorHintPort")}
              </p>
              <input
                ref={el => { fieldRefs.current.bridgePort = el; }}
                id={`${baseId}-bridge-port`}
                type="text"
                inputMode="numeric"
                className="baseware-input font-mono"
                value={draft.bridgePort}
                aria-invalid={Boolean(bridgePortErr)}
                aria-describedby={bridgePortErr ? `${bridgePortHintId} ${bridgePortErrId}` : bridgePortHintId}
                onBlur={() => markTouched("bridgePort")}
                onChange={event => setDraft(prev => ({ ...prev, bridgePort: event.target.value }))}
              />
              {bridgePortErr && (
                <p id={bridgePortErrId} className="baseware-field-error">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span>{bridgePortErr}</span>
                </p>
              )}
            </div>
            <div className="space-y-1 sm:col-span-3">
              <label htmlFor={`${baseId}-bridge-game`} className="block text-xs font-medium">
                {t("fieldBridgeGame")}
              </label>
              <input
                id={`${baseId}-bridge-game`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                placeholder="/path/to/rom.gba (optional)"
                value={draft.bridgeGame}
                onChange={event => setDraft(prev => ({ ...prev, bridgeGame: event.target.value }))}
              />
            </div>
          </div>
        )}

        {draft.transportKind === "ssh" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${baseId}-ssh-host`} className="block text-xs font-medium">
                {t("fieldSshHost")}
              </label>
              <input
                ref={el => { fieldRefs.current.sshHost = el; }}
                id={`${baseId}-ssh-host`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                placeholder="192.168.1.100"
                value={draft.sshHost}
                aria-invalid={Boolean(sshHostErr)}
                aria-describedby={sshHostErr ? `${baseId}-ssh-host-err` : undefined}
                onBlur={() => markTouched("sshHost")}
                onChange={event => setDraft(prev => ({ ...prev, sshHost: event.target.value }))}
              />
              {sshHostErr && (
                <p id={`${baseId}-ssh-host-err`} className="baseware-field-error">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span>{sshHostErr}</span>
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${baseId}-ssh-user`} className="block text-xs font-medium">
                {t("fieldSshUser")}
              </label>
              <input
                id={`${baseId}-ssh-user`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                placeholder="player"
                value={draft.sshUser}
                onChange={event => setDraft(prev => ({ ...prev, sshUser: event.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${baseId}-ssh-port`} className="block text-xs font-medium">
                {t("fieldSshPort")}
              </label>
              <p id={sshPortHintId} className="baseware-field-hint">
                {t("editorHintPort")}
              </p>
              <input
                ref={el => { fieldRefs.current.sshPort = el; }}
                id={`${baseId}-ssh-port`}
                type="text"
                inputMode="numeric"
                className="baseware-input font-mono"
                value={draft.sshPort}
                aria-invalid={Boolean(sshPortErr)}
                aria-describedby={sshPortErr ? `${sshPortHintId} ${sshPortErrId}` : sshPortHintId}
                onBlur={() => markTouched("sshPort")}
                onChange={event => setDraft(prev => ({ ...prev, sshPort: event.target.value }))}
              />
              {sshPortErr && (
                <p id={sshPortErrId} className="baseware-field-error">
                  <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                  <span>{sshPortErr}</span>
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${baseId}-ssh-cmd`} className="block text-xs font-medium">
                {t("fieldSshCommand")}
              </label>
              <p className="baseware-field-hint opacity-0 select-none" aria-hidden="true">.</p>
              <input
                id={`${baseId}-ssh-cmd`}
                type="text"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="baseware-input font-mono"
                value={draft.sshCommand}
                onChange={event => setDraft(prev => ({ ...prev, sshCommand: event.target.value }))}
              />
            </div>
          </div>
        )}

        {(draft.transportKind === "http" || draft.transportKind === "sse") && (
          <div className="space-y-1">
            <label htmlFor={`${baseId}-http-url`} className="block text-xs font-medium">
              {t("fieldHttpUrl")}
            </label>
            <input
              ref={el => { fieldRefs.current.httpUrl = el; }}
              id={`${baseId}-http-url`}
              type="url"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="baseware-input font-mono"
              placeholder="http://127.0.0.1:8910/mcp"
              value={draft.httpUrl}
              aria-invalid={Boolean(httpUrlErr)}
              aria-describedby={httpUrlErr ? `${baseId}-http-url-err` : undefined}
              onBlur={() => markTouched("httpUrl")}
              onChange={event => setDraft(prev => ({ ...prev, httpUrl: event.target.value }))}
            />
            {httpUrlErr && (
              <p id={`${baseId}-http-url-err`} className="baseware-field-error">
                <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                <span>{httpUrlErr}</span>
              </p>
            )}
          </div>
        )}

        {/* Workspace binding fieldset */}
        {hasWorkspace && (
          <fieldset className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
            <legend className="px-1 text-xs font-medium text-foreground">
              {t("editorBindLegend")}
            </legend>
            <div className="space-y-1.5 text-xs">
              {(["primary", "allowed", "none"] as const).map(mode => (
                <label key={mode} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/40">
                  <input
                    type="radio"
                    name={`${baseId}-bind-mode`}
                    value={mode}
                    checked={draft.bindMode === mode}
                    onChange={() => setDraft(prev => ({ ...prev, bindMode: mode }))}
                  />
                  <span>
                    {mode === "primary"
                      ? t("editorBindPrimary")
                      : mode === "allowed"
                        ? t("editorBindAllowed")
                        : t("editorBindNone")}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleProbe()}
            disabled={probeState === "probing"}
          >
            {probeState === "probing"
              ? <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              : <Play className="size-3.5" aria-hidden="true" />}
            {probeState === "probing" ? t("probing") : t("probeConnection")}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving}
              data-baseware-save-machine
            >
              {saving ? t("saving") : t("saveMachine")}
            </Button>
          </div>
        </div>
      </form>
    </BasewareModalDialog>
  );
}
