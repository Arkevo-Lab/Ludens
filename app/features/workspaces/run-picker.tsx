"use client";

import { ContextPicker, type ContextOption } from "@/features/workspaces/context-picker";
import { useTranslations } from "@/lib/locale";
import { runWindowSummary } from "@/lib/run-identity";
import type { RunData, RunInfo } from "@/lib/types";

export function RunPicker({ runs, latest, cycles, quickJump, value, onChange }: {
  runs: RunInfo[];
  latest?: RunInfo;
  cycles?: RunData["cycles"];
  quickJump?: boolean;
  value: string;
  onChange(value: string): void;
}) {
  const t = useTranslations("runPicker");
  const dt = useTranslations("dashboard");
  const et = useTranslations("workspaceRunEmpty");
  const latestLabel = latest ? (quickJump ? t("latestSegment") : dt("latestRun")) : et("noGameRuns");
  const latestCycle = quickJump && cycles && cycles.length > 0 ? cycles.at(-1) : null;
  const latestIdentity = latestCycle && latest
    ? runWindowSummary({ id: `${latest.id}#${latestCycle.epoch}`, startedAt: latestCycle.startedAt, endedAt: latestCycle.endedAt ?? latest.endedAt })
    : latest ? runWindowSummary(latest) : null;
  const options: ContextOption[] = runs.length ? [{ value: "", label: latestLabel,
    secondarySummary: latestIdentity?.summary ?? undefined, identity: latest?.id ?? latestIdentity?.id },
  ...runs.flatMap(run => {
    if (quickJump && latest && run.id === latest.id && cycles && cycles.length > 1) {
      return [...cycles].reverse().map((cycle, revIdx) => {
        const idx = cycles.length - revIdx;
        const segmentValue = `${run.id}#${cycle.epoch}`;
        const identity = runWindowSummary({ id: cycle.epoch, startedAt: cycle.startedAt, endedAt: cycle.endedAt ?? (revIdx === 0 ? run.endedAt : undefined) });
        return {
          value: segmentValue,
          label: `${identity.summary ?? cycle.startedAt} · #${idx}`,
          identity: `${run.id} · ${cycle.epoch.slice(0, 8)}`,
        };
      });
    }
    const identity = runWindowSummary(run);
    return [{ value: run.id, label: identity.summary ?? identity.id, identity: identity.summary ? identity.id : undefined }];
  })] : [];
  const selectedOption = value ? options.find(o => o.value === value) : null;
  const selectedRun = value ? runs.find(r => r.id === value.split("#")[0]) ?? { id: value } : null;
  const selected = selectedOption
    ? { id: selectedOption.identity ?? value, summary: selectedOption.label }
    : selectedRun ? runWindowSummary(selectedRun) : latestIdentity;
  const prefixLabel = quickJump ? t("quickJumpLabel") : dt("runHistoryLabel");
  const triggerText = value ? `${prefixLabel} · ${selected?.summary ?? value}`
    : latestIdentity ? `${latestLabel} · ${latestIdentity.summary ?? latestIdentity.id}` : latestLabel;
  return <ContextPicker kind="run" options={options} value={value} onChange={onChange} label={prefixLabel} hideLabel
    trigger={{ text: runs.length ? triggerText : t("empty"), title: selected?.id ?? t("empty"), hint: quickJump ? t("quickJumpHint") : (selected?.id ?? t("description")) }}
    copy={{ title: prefixLabel, description: quickJump ? t("quickJumpDescription") : t("description"), close: t("close"), current: t("current"), empty: t("empty") }} />;
}
