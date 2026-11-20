"use client";

import { useRef, type HTMLAttributes, type KeyboardEvent } from "react";
import { Check, Film, HardDrive, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/locale";
import {
  RECORDING_QUALITY_TIERS,
  formatVideoQualitySpecBadge,
  type VideoQualityPreset,
} from "@/lib/storage";

export interface RecordingQualityPresetsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  value: VideoQualityPreset;
  onChange: (next: VideoQualityPreset) => void;
  /**
   * When true (default), includes the recommended local ring-buffer quota (`5 / 20 / 50 GiB`)
   * in each card's spec badge. When false (e.g. bound to a remote S3 / external directory profile),
   * omits the local quota from the active spec badge and surfaces a crisp muted indicator so
   * users clearly see remote quota is untouched.
   */
  showQuota?: boolean;
  /** Optional tier to tag with a subtle "Default" pill (e.g. `"balanced"` or the global default tier). */
  defaultBadgeTier?: VideoQualityPreset | null;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}

function TierIcon({ tier, active }: { tier: VideoQualityPreset; active: boolean }) {
  const iconClass = cn(
    "size-3.5 shrink-0 transition-colors",
    active ? "text-[var(--gold)]" : "text-muted-foreground",
  );
  switch (tier) {
    case "compact":
      return <HardDrive className={iconClass} aria-hidden="true" />;
    case "balanced":
      return <Film className={iconClass} aria-hidden="true" />;
    case "high":
      return <Sparkles className={iconClass} aria-hidden="true" />;
  }
}

export function RecordingQualityPresets({
  value,
  onChange,
  showQuota = true,
  defaultBadgeTier = null,
  disabled = false,
  compact = false,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  className,
  ...rest
}: RecordingQualityPresetsProps) {
  const t = useTranslations("recordingQualityPresets");
  const buttonRefs = useRef<Partial<Record<VideoQualityPreset, HTMLButtonElement | null>>>({});

  const moveFocusAndSelect = (nextTier: VideoQualityPreset) => {
    if (disabled) return;
    onChange(nextTier);
    buttonRefs.current[nextTier]?.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    if (disabled) return;
    const count = RECORDING_QUALITY_TIERS.length;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = RECORDING_QUALITY_TIERS[(currentIndex + 1) % count]!;
      moveFocusAndSelect(next);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const prev = RECORDING_QUALITY_TIERS[(currentIndex - 1 + count) % count]!;
      moveFocusAndSelect(prev);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocusAndSelect(RECORDING_QUALITY_TIERS[0]!);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocusAndSelect(RECORDING_QUALITY_TIERS[count - 1]!);
    }
  };

  const nativeLabel = t("nativeResolution");

  return (
    <div className={cn("grid min-w-0 gap-1.5", className)} {...rest}>
      <div
        role="radiogroup"
        aria-label={ariaLabelledBy ? undefined : (ariaLabel ?? t("groupLabel"))}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-recording-quality-presets=""
        data-show-quota={showQuota ? "true" : "false"}
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {RECORDING_QUALITY_TIERS.map((tier, index) => {
          const active = value === tier;
          const specText = formatVideoQualitySpecBadge(tier, {
            nativeLabel,
            showQuota,
          });
          const isDefaultTier = defaultBadgeTier === tier;

          return (
            <button
              key={tier}
              ref={el => {
                buttonRefs.current[tier] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              tabIndex={active ? 0 : -1}
              data-quality-preset={tier}
              onClick={() => {
                if (!disabled) onChange(tier);
              }}
              onKeyDown={event => handleKeyDown(event, index)}
              className={cn(
                "group relative flex min-w-0 flex-col items-start justify-between rounded-md border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                compact ? "gap-1.5 p-2.5" : "gap-2 p-3",
                active
                  ? "border-[var(--gold)] bg-[var(--surface-inset)] text-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--gold)_28%,transparent)]"
                  : "border-border/80 bg-[var(--surface-inset)]/60 text-foreground hover:border-border hover:bg-muted/45",
                disabled && "pointer-events-none opacity-50",
              )}
            >
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <TierIcon tier={tier} active={active} />
                  <span className="truncate text-xs font-semibold tracking-tight text-foreground">
                    {t(`tiers.${tier}.title`)}
                  </span>
                  {isDefaultTier && (
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-1.5 py-0 text-[10px] leading-4"
                    >
                      {t("defaultBadge")}
                    </Badge>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                    active
                      ? "border-[var(--gold)] bg-[var(--gold)] text-background"
                      : "border-muted-foreground/40 group-hover:border-muted-foreground/70",
                  )}
                >
                  {active ? <Check className="size-2.5 stroke-[3]" /> : null}
                </span>
              </div>

              <div className="flex w-full flex-wrap items-center gap-1.5">
                <span
                  data-quality-spec={tier}
                  className={cn(
                    "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums leading-tight",
                    active
                      ? "border-[var(--gold)]/40 bg-[var(--gold)]/10 text-foreground"
                      : "border-border/70 bg-background/70 text-muted-foreground",
                  )}
                >
                  {specText}
                </span>
              </div>

              <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {t(`tiers.${tier}.hint`)}
              </span>
            </button>
          );
        })}
      </div>

      {!showQuota && (
        <p
          data-quality-quota-muted-note=""
          className="text-[11px] leading-relaxed text-muted-foreground"
        >
          {t("quotaMutedNote")}
        </p>
      )}
    </div>
  );
}
