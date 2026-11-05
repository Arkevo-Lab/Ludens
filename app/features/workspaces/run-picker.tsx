"use client";

import { ContextPicker, type ContextOption } from "@/features/workspaces/context-picker";
import { useTranslations } from "@/lib/locale";
import { runWindowSummary } from "@/lib/run-identity";
import type { RunInfo } from "@/lib/types";

export function RunPicker({ runs, latest, value, onChange }: {
  runs: RunInfo[];
  latest?: RunInfo;
  value: string;
  onChange(value: string): void;
}) {
  const t = useTranslations("runPicker");
  const dt = useTranslations("dashboard");
  const et = useTranslations("workspaceRunEmpty");
  const latestLabel = latest ? dt("latestRun") : et("noGameRuns");
  const latestIdentity = latest ? runWindowSummary(latest) : null;
  const options: ContextOption[] = runs.length ? [{ value: "", label: latestLabel,
    secondarySummary: latestIdentity?.summary ?? undefined, identity: latestIdentity?.id },
  ...runs.map(run => {
    const identity = runWindowSummary(run);
    return { value: run.id, label: identity.summary ?? identity.id, identity: identity.summary ? identity.id : undefined };
  })] : [];
  const selectedRun = value ? runs.find(r => r.id === value) ?? { id: value } : null;
  const selected = selectedRun ? runWindowSummary(selectedRun) : latestIdentity;
  const triggerText = value ? `${dt("runHistoryLabel")} · ${selected?.summary ?? value}`
    : latestIdentity ? `${latestLabel} · ${latestIdentity.summary ?? latestIdentity.id}` : latestLabel;
  return <ContextPicker kind="run" options={options} value={value} onChange={onChange} label={dt("runHistoryLabel")} hideLabel
    trigger={{ text: runs.length ? triggerText : t("empty"), title: selected?.id ?? t("empty"), hint: selected?.id ?? t("description") }}
    copy={{ title: dt("runHistoryLabel"), description: t("description"), close: t("close"), current: t("current"), empty: t("empty") }} />;
}
