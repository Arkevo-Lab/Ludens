"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

export interface SettingsCategoryItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface SettingsWorkspaceLayoutProps {
  navLabel: string;
  categories: SettingsCategoryItem[];
  activeCategory: string;
  onCategoryChange: (id: string) => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
  wide?: boolean;
  children: ReactNode;
  className?: string;
}

/** Two-column desktop settings layout with a Forced-Colors-safe nav rail and mobile horizontal bar. */
export function SettingsWorkspaceLayout({
  navLabel,
  categories,
  activeCategory,
  onCategoryChange,
  title,
  subtitle,
  actions,
  headingLevel = 2,
  wide = false,
  children,
  className,
}: SettingsWorkspaceLayoutProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div className={cn("settings-workspace", className)}>
      <nav aria-label={navLabel} className="settings-workspace-nav">
        {categories.map(category => {
          const active = category.id === activeCategory;
          return (
            <button
              key={category.id}
              type="button"
              data-slot="settings-nav-item"
              disabled={category.disabled}
              aria-current={active ? "page" : undefined}
              className="settings-nav-item"
              onClick={() => onCategoryChange(category.id)}
            >
              {category.icon}
              <span className="settings-nav-item-label">{category.label}</span>
              {category.badge !== undefined && category.badge !== null && (
                <span className="settings-nav-item-badge">{category.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="settings-workspace-pane" data-wide={wide ? "true" : undefined}>
        {(title || subtitle || actions) && (
          <header className="settings-workspace-header">
            <div className="settings-workspace-header-copy">
              {title && <Heading className="settings-workspace-title">{title}</Heading>}
              {subtitle && <p className="settings-workspace-subtitle">{subtitle}</p>}
            </div>
            {actions && <div className="settings-workspace-actions">{actions}</div>}
          </header>
        )}
        <div className="settings-workspace-body">{children}</div>
      </div>
    </div>
  );
}

export interface SettingsSectionProps {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  children: ReactNode;
  className?: string;
}

/** Borderless settings section with a compact header and hairline-divided rows. */
export function SettingsSection({
  id,
  title,
  description,
  actions,
  headingLevel = 2,
  children,
  className,
}: SettingsSectionProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section id={id} className={cn("settings-section", className)}>
      {(title || description || actions) && (
        <div className="settings-section-header">
          <div className="settings-section-header-copy">
            {title && <Heading className="settings-section-title">{title}</Heading>}
            {description && <p className="settings-section-description">{description}</p>}
          </div>
          {actions && <div className="settings-section-actions">{actions}</div>}
        </div>
      )}
      <div className="settings-rows">{children}</div>
    </section>
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  badge?: ReactNode;
  meta?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
  className?: string;
}

/** Flat hairline setting row that aligns label/description against a right-hand control and stacks below 640px. */
export function SettingsRow({
  label,
  htmlFor,
  description,
  descriptionId,
  badge,
  meta,
  control,
  children,
  stacked = false,
  className,
}: SettingsRowProps) {
  return (
    <div className={cn("settings-row", className)} data-stacked={stacked ? "true" : undefined}>
      <div className="settings-row-info">
        <div className="settings-row-heading">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="settings-row-label">
              {label}
            </label>
          ) : (
            <span className="settings-row-label">{label}</span>
          )}
          {badge}
          {meta !== undefined && meta !== null && (
            <span className="settings-row-meta">{meta}</span>
          )}
        </div>
        {description && (
          <p id={descriptionId} className="settings-row-description">
            {description}
          </p>
        )}
      </div>
      {(control !== undefined || children !== undefined) && (
        <div className="settings-row-control">
          {control}
          {children}
        </div>
      )}
    </div>
  );
}

export interface SettingsSaveBarProps {
  dirty: boolean;
  statusText: ReactNode;
  discardLabel?: string;
  onDiscard?: () => void;
  saveLabel: string;
  savingLabel?: string;
  onSave?: () => void;
  saveType?: "button" | "submit";
  saving?: boolean;
  disabled?: boolean;
  secondaryAction?: ReactNode;
  className?: string;
}

/** Footer bar displaying draft save status alongside discard, save, and optional secondary actions. */
export function SettingsSaveBar({
  dirty,
  statusText,
  discardLabel,
  onDiscard,
  saveLabel,
  savingLabel,
  onSave,
  saveType,
  saving = false,
  disabled = false,
  secondaryAction,
  className,
}: SettingsSaveBarProps) {
  const resolvedSaveType = saveType ?? (onSave ? "button" : "submit");

  return (
    <div className={cn("settings-save-bar", className)}>
      <p role="status" className="settings-save-status" data-dirty={dirty ? "true" : undefined}>
        {statusText}
      </p>
      <div className="settings-save-actions">
        {secondaryAction}
        {discardLabel && onDiscard && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!dirty || saving || disabled}
            onClick={onDiscard}
          >
            {discardLabel}
          </Button>
        )}
        <Button
          type={resolvedSaveType}
          size="sm"
          disabled={!dirty || saving || disabled}
          onClick={onSave}
        >
          {saving ? (savingLabel ?? saveLabel) : saveLabel}
        </Button>
      </div>
    </div>
  );
}

export interface InlineCopyButtonProps {
  text: string;
  ariaLabel: string;
  copiedText?: string;
  failedText?: string;
  revealOnHover?: boolean;
  className?: string;
}

// Track the last live-region announcement globally so repeated identical copies still trigger VoiceOver.
let lastCopyAnnouncement = "";

/** Accessible icon-only copy button with an external status bubble and VoiceOver repeat-announcement handling. */
export function InlineCopyButton({
  text,
  ariaLabel,
  copiedText = "Copied",
  failedText = "Copy failed",
  revealOnHover = false,
  className,
}: InlineCopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [tipText, setTipText] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearScheduled = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => clearScheduled, [clearScheduled]);

  const report = useCallback(
    (ok: boolean) => {
      clearScheduled();
      let message = ok ? copiedText : failedText;
      if (message === lastCopyAnnouncement) {
        message += "\u00A0";
      }
      lastCopyAnnouncement = message;

      setStatus(ok ? "copied" : "failed");
      setTipText("");

      const publish = () => {
        setTipText(message);
      };
      if (typeof requestAnimationFrame === "function") {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          publish();
        });
      } else {
        publish();
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setStatus("idle");
        setTipText("");
      }, 2000);
    },
    [clearScheduled, copiedText, failedText],
  );

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      report(true);
    } catch {
      report(false);
    }
  }, [report, text]);

  return (
    <span className={cn("settings-copy-wrap", revealOnHover && "settings-copy-reveal", className)}>
      <button
        type="button"
        data-slot="inline-copy-button"
        aria-label={ariaLabel}
        data-copied={status === "copied" ? "" : undefined}
        data-failed={status === "failed" ? "" : undefined}
        className="settings-copy-button"
        onClick={() => void handleCopy()}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <span role="status" className="settings-copy-tip" data-visible={tipText ? "" : undefined}>
        {tipText}
      </span>
    </span>
  );
}

export interface SingleLineTruncateProps {
  text: string;
  className?: string;
  mono?: boolean;
  title?: string;
}

/** Single-line ellipsis text that keeps the untruncated string in the DOM and optional title attribute. */
export function SingleLineTruncate({ text, className, mono = false, title }: SingleLineTruncateProps) {
  return (
    <span
      className={cn("settings-single-line-truncate", mono && "mono", className)}
      title={title ?? text}
    >
      {text}
    </span>
  );
}

export interface AdvancedDiagnosticsDisclosureProps {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** Native collapsible disclosure for secondary diagnostics and CLI snippets with progressive height animation. */
export function AdvancedDiagnosticsDisclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: AdvancedDiagnosticsDisclosureProps) {
  return (
    <details className={cn("settings-disclosure", className)} open={defaultOpen}>
      <summary className="settings-disclosure-summary">
        <ChevronRight aria-hidden="true" className="settings-disclosure-chevron size-3.5" />
        <span>{summary}</span>
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  );
}
