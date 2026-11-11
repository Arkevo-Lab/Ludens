"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/locale";
import { replayDuration } from "@/features/replay/replay-model";
import { parseReplayElapsed, replayElapsedInput } from "@/features/replay/replay-navigation";

export function ReplayTimeJump({ elapsed, duration, onJump }: { elapsed: number; duration: number; onJump(elapsed: number): void }) {
  const t = useTranslations("replayNavigation");
  const id = useId();
  const elapsedInput = replayElapsedInput(elapsed, "milliseconds");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(elapsedInput);
  const [invalid, setInvalid] = useState(false);
  const [clamped, setClamped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(elapsedInput);
  }, [elapsedInput, editing]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing]);

  const displayElapsed =
    duration >= 3_600_000 ? replayElapsedInput(elapsed, "seconds") : replayDuration(elapsed);
  const displayDuration =
    duration >= 3_600_000 ? replayElapsedInput(duration, "seconds") : replayDuration(duration);

  if (!editing) {
    return (
      <div className="replay-timecode-group">
        <button
          type="button"
          className="replay-timecode-trigger mono"
          title={`${t("jumpLabel")} (${t("timeFormat")})`}
          aria-label={`${t("jumpLabel")}: ${displayElapsed} / ${displayDuration}`}
          onClick={() => {
            setDraft(elapsedInput);
            setInvalid(false);
            setClamped(false);
            setEditing(true);
          }}
        >
          <strong>{displayElapsed}</strong>
          <small>/ {displayDuration}</small>
        </button>
        {clamped && (
          <span className="replay-jump-feedback" role="status">
            {t("clampedTime").replace("{time}", replayElapsedInput(duration, "milliseconds"))}
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      className="replay-time-jump-inline"
      onSubmit={event => {
        event.preventDefault();
        const target = parseReplayElapsed(draft);
        if (target === null) {
          setInvalid(true);
          setClamped(false);
          return;
        }
        const next = Math.min(duration, target);
        setInvalid(false);
        setClamped(target > duration);
        setEditing(false);
        setDraft(replayElapsedInput(next, "milliseconds"));
        onJump(next);
      }}
    >
      <Label htmlFor={id} className="sr-only">{t("jumpLabel")}</Label>
      <Input
        ref={inputRef}
        id={id}
        value={draft}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-hint` : undefined}
        placeholder="00:00:00"
        className="replay-time-jump-input h-6 w-28 px-2 py-0 font-mono text-xs tabular-nums"
        spellCheck={false}
        onChange={event => {
          setInvalid(false);
          setClamped(false);
          setDraft(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            setInvalid(false);
            setEditing(false);
          }
        }}
      />
      <Button type="submit" variant="outline" size="xs">{t("jump")}</Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={t("cancelJump")}
        onClick={() => {
          setInvalid(false);
          setEditing(false);
        }}
      >
        ×
      </Button>
      {invalid && (
        <span id={`${id}-hint`} className="replay-jump-error" role="status">
          {t("invalidTime")}
        </span>
      )}
    </form>
  );
}
