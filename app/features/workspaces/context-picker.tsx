"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export type ContextPickerVariant = "default" | "sidebar" | "compact";

export interface ContextOption {
  value: string;
  label: string;
  identity?: string;
  identityKind?: "path" | "id";
  secondarySummary?: string;
  badge?: string;
}

/** Presentation only: callers own identity, catalog state, and navigation. */
export function ContextPicker({
  kind,
  options,
  value,
  onChange,
  label,
  hideLabel = false,
  variant = "default",
  muted = false,
  statusTone,
  trigger,
  copy,
}: {
  kind: "workspace" | "run";
  options: ContextOption[];
  value: string;
  onChange(value: string): void;
  label: ReactNode;
  hideLabel?: boolean;
  variant?: ContextPickerVariant;
  muted?: boolean;
  statusTone?: "active" | "muted" | "danger";
  trigger: { text: string; hint: string; title: string };
  copy: { title: string; description: string; close: string; current: string; empty: string; emptyHint?: string };
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selectedChoice = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusedChoice = useRef<HTMLButtonElement | null>(null);
  const empty = !options.length;
  const srOnlyLabel = hideLabel || variant !== "default";
  useLayoutEffect(() => {
    // A catalog refresh may remove the focused row; do not select another item or refocus on ordinary polls.
    const previous = focusedChoice.current;
    if (open && previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === content.current)) {
      focusedChoice.current = null;
      closeButton.current?.focus({ preventScroll: true });
    }
  }, [options, open]);
  const wrapperClass =
    variant === "sidebar"
      ? `sidebar-${kind}-picker context-picker flex w-full min-w-0 max-w-full items-center`
      : variant === "compact"
        ? `contextual-${kind}-picker context-picker flex min-w-0 max-w-full shrink items-center`
        : `topbar-${kind}-picker context-picker flex min-w-0 max-w-full items-center gap-2`;
  return <div className={wrapperClass} data-variant={variant} data-muted={muted ? "true" : undefined}>
    <Label id={`${id}-label`} htmlFor={id} className={srOnlyLabel ? "sr-only" : "context-picker-label flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"}>{label}</Label>
    <Dialog open={open} onOpenChange={next => { if (!next || !empty) setOpen(next); }}>
      <DialogTrigger asChild>
        {variant === "sidebar" ? (
          <Button
            id={id}
            type="button"
            variant="ghost"
            size="sm"
            className={`context-picker-trigger ${kind}-picker-trigger context-picker-trigger-sidebar w-full min-w-0 max-w-full justify-between text-xs aria-disabled:opacity-50`}
            data-muted={muted ? "true" : undefined}
            aria-disabled={empty}
            aria-labelledby={`${id}-label ${id}-value`}
            aria-describedby={`${id}-hint`}
            title={trigger.title}
          >
            <span className="sidebar-picker-dot" data-tone={statusTone ?? (muted ? "muted" : "active")} aria-hidden="true" />
            <span id={`${id}-value`} className="sidebar-picker-text">{trigger.text}</span>
            <ChevronsUpDown className="sidebar-picker-chevron" aria-hidden="true" />
          </Button>
        ) : variant === "compact" ? (
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            className={`context-picker-trigger ${kind}-picker-trigger context-picker-trigger-compact h-7 min-w-0 max-w-[210px] shrink justify-between gap-1.5 px-2.5 text-xs aria-disabled:opacity-50 sm:max-w-[240px]`}
            aria-disabled={empty}
            aria-labelledby={`${id}-label ${id}-value`}
            aria-describedby={`${id}-hint`}
            title={trigger.title}
          >
            <span id={`${id}-value`} className="min-w-0 truncate">{trigger.text}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-65" aria-hidden="true" />
          </Button>
        ) : (
          <Button id={id} type="button" variant="outline" size="sm"
            className={`context-picker-trigger ${kind}-picker-trigger min-w-0 max-w-full shrink justify-between text-xs aria-disabled:opacity-50 ${kind === "workspace" ? "w-56 sm:w-64" : "w-64 sm:w-80"}`}
            aria-disabled={empty} aria-labelledby={`${id}-label ${id}-value`} aria-describedby={`${id}-hint`} title={trigger.title}>
            <span id={`${id}-value`} className="min-w-0 truncate">{trigger.text}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent ref={content} showCloseButton={false} className={`context-picker-dialog ${kind}-picker-dialog flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl`}
        onOpenAutoFocus={event => {
          event.preventDefault();
          (selectedChoice.current ?? closeButton.current)?.focus({ preventScroll: true });
          selectedChoice.current?.scrollIntoView({ block: "nearest" });
        }}
        onFocusCapture={event => { focusedChoice.current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-context-choice]") : null; }}>
        <div className={`context-picker-header ${kind}-picker-header`}>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogClose asChild><Button ref={closeButton} type="button" variant="outline" size="sm">{copy.close}</Button></DialogClose>
        </div>
        <div className={`context-picker-body ${kind}-picker-body`}>
          <DialogDescription className={`context-picker-description ${kind}-picker-description`}>{copy.description}</DialogDescription>
          {empty ? <div className={`context-picker-empty ${kind}-picker-empty`} role="status"><p>{copy.empty}</p>{copy.emptyHint && <p>{copy.emptyHint}</p>}</div>
            : <ul className={`context-picker-list ${kind}-picker-list`} role="list" aria-label={copy.title}>
              {options.map(option => <li key={option.value}>
                <button type="button" className={`context-picker-choice ${kind}-picker-choice`} data-context-choice={option.value}
                  data-workspace-choice={kind === "workspace" ? option.value : undefined} data-run-choice={kind === "run" ? option.value : undefined}
                  ref={option.value === value ? selectedChoice : undefined} aria-current={option.value === value ? "true" : undefined}
                  onClick={() => { if (!open) return; setOpen(false); if (option.value !== value) onChange(option.value); }}>
                  <span className={`context-picker-choice-heading ${kind}-picker-choice-heading`}>
                    <strong className={`${kind}-picker-summary`}>{option.label}</strong>
                    <span className={`context-picker-markers ${kind}-picker-markers`}>
                      {option.value === value && <span className={`context-picker-current ${kind}-picker-current`}>{copy.current}</span>}
                      {option.badge && <span className={`context-picker-badge ${kind === "workspace" ? "workspace-picker-unavailable" : "run-picker-badge"}`}>{option.badge}</span>}
                    </span>
                  </span>
                  {option.secondarySummary && <span className={`context-picker-secondary ${kind}-picker-secondary`}>{option.secondarySummary}</span>}
                  {option.identity && <code className={`context-picker-identity ${kind === "workspace" ? "workspace-picker-location" : "run-picker-identity"}`}
                    data-workspace-identity={kind === "workspace" ? option.identityKind : undefined}>{option.identity}</code>}
                </button>
              </li>)}
            </ul>}
        </div>
      </DialogContent>
    </Dialog>
    <span id={`${id}-hint`} className="sr-only">{trigger.hint}</span>
  </div>;
}
