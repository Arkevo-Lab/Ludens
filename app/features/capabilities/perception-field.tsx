"use client";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { SettingsRow } from "@/components/ui/settings-primitives";
import { Slider } from "@/components/ui/slider";
import { useTranslations } from "@/lib/locale";
import { parsePerceptionDraft, PERCEPTION_FIELDS, type PerceptionKey, type PerceptionFieldDraft } from "@/features/capabilities/perception-draft";

export function PerceptionField({ name, saved, draft, pending, inheritanceNoteId, onEdit }: {
  name: PerceptionKey; saved?: number; draft?: PerceptionFieldDraft; pending: boolean;
  inheritanceNoteId: string;
  onEdit(mode: PerceptionFieldDraft["mode"], raw: string): void;
}) {
  const t = useTranslations("perceptionSettings"), id = useId(), limit = PERCEPTION_FIELDS[name];
  const label = t(`limits.${name}.label`), mode = draft?.mode ?? (saved === undefined ? "inherit" : "override");
  const raw = draft?.raw ?? (saved === undefined ? "" : String(saved));
  const parsed = parsePerceptionDraft(name, { mode, raw });
  const invalid = !!draft && parsed === undefined;
  const custom = !draft && saved !== undefined && parsed === undefined;
  const conflict = !!draft && draft.base !== saved;

  return (
    <div data-perception-field={name}>
      <SettingsRow
        className="items-start"
        label={label}
        htmlFor={mode === "override" ? `${id}-value` : undefined}
        badge={draft ? <Badge variant="outline">{t("draftBadge")}</Badge> : undefined}
        description={t(`limits.${name}.help`)}
        descriptionId={`${id}-help`}
        control={
          <div className="flex w-full min-w-0 flex-col gap-2.5 sm:w-[26rem] sm:max-w-full">
            <NativeSelect
              value={mode}
              aria-label={`${label} · ${t("sourceLabel")}`}
              aria-disabled={pending}
              aria-describedby={`${id}-help ${inheritanceNoteId}${mode === "inherit" ? ` ${id}-default` : ""}`}
              wrapperClassName="w-full sm:w-64"
              className="w-full aria-disabled:opacity-50"
              onKeyDown={event => { if (pending && event.key !== "Tab") event.preventDefault(); }}
              onPointerDown={event => { if (pending) event.preventDefault(); }}
              onChange={event => { if (!pending) onEdit(event.target.value === "inherit" ? "inherit" : "override", raw || String(saved ?? limit.fallback)); }}
            >
              <NativeSelectOption value="override">{t("workspaceOverride")}</NativeSelectOption>
              <NativeSelectOption value="inherit">{t("inheritEnvironment")}</NativeSelectOption>
            </NativeSelect>
            {mode === "override" ? (
              <div key="override" className="space-y-2.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${id}-value`}
                      aria-label={label}
                      value={raw}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={100}
                      readOnly={pending}
                      aria-disabled={pending}
                      aria-invalid={invalid}
                      className="w-24 tabular-nums aria-disabled:opacity-50"
                      aria-describedby={`${id}-help ${id}-range${invalid ? ` ${id}-error` : ""}${custom ? ` ${id}-custom` : ""}`}
                      onChange={event => { if (!pending) onEdit("override", event.target.value); }}
                    />
                    <span className="text-xs text-muted-foreground">{t("seconds")}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5" aria-label={t("presetsLabel")}>
                    {limit.presets.map(value => (
                      <Button
                        key={value}
                        type="button"
                        size="xs"
                        variant={parsed === value ? "secondary" : "outline"}
                        aria-pressed={parsed === value}
                        aria-disabled={pending}
                        className="px-2 text-xs aria-disabled:opacity-50"
                        onClick={() => { if (!pending) onEdit("override", String(value)); }}
                      >
                        {value >= 60 && value % 60 === 0 ? `${value / 60} ${t("presetMinutes")}` : `${value} ${t("presetSeconds")}`}
                      </Button>
                    ))}
                  </div>
                </div>
                {typeof parsed === "number" && (
                  <Slider
                    min={limit.min}
                    max={limit.max}
                    step={1}
                    value={[parsed]}
                    aria-disabled={pending}
                    className="aria-disabled:opacity-50"
                    aria-label={`${label} · ${t("sliderLabel")}`}
                    aria-describedby={`${id}-range`}
                    onKeyDownCapture={event => { if (pending && event.key !== "Tab") event.preventDefault(); }}
                    onPointerDownCapture={event => { if (pending) event.preventDefault(); }}
                    onValueChange={([value]) => { if (!pending && value !== undefined) onEdit("override", String(value)); }}
                    onValueCommit={([value]) => { if (!pending && value !== undefined) onEdit("override", String(value)); }}
                  />
                )}
                <p id={`${id}-range`} className="text-xs text-muted-foreground">
                  {t("rangePrefix")} {limit.min}–{limit.max} {t("wholeSeconds")}
                </p>
                {invalid && (
                  <p id={`${id}-error`} className="text-xs text-destructive motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150" role="alert">
                    {t("invalidValue")}
                  </p>
                )}
                {custom && (
                  <p id={`${id}-custom`} className="rounded-md border border-dashed p-2.5 text-xs leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
                    {t("customPreserved")}
                  </p>
                )}
              </div>
            ) : (
              <p key="inherit" id={`${id}-default`} data-perception-default className="text-xs leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
                {t("builtinDefaultLabel")} {limit.fallback} {t("seconds")}
              </p>
            )}
            {conflict && (
              <p className="text-xs leading-relaxed text-warning motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150" role="status">
                {t("savedValueChanged")}
              </p>
            )}
          </div>
        }
      />
    </div>
  );
}
