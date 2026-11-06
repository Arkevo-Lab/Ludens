"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Monitor, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { PetSettings } from "@/features/pet/pet-settings";
import { ConnectionSettings } from "@/features/workspaces/connection-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";
import type { GlobalDefaultsResult, WorkspaceSettings } from "@/lib/workspaces";
import type { PetFollow } from "@/features/pet/pet-follow";

export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { locale, setLocale } = useLocale();
  const t = useTranslations("settings");
  const languageId = useId();
  return (
    <section className="settings-page mx-auto grid w-full max-w-5xl gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start gap-3.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-[var(--surface-inset)] text-[var(--gold)]">
            <Monitor aria-hidden="true" className="size-4" />
          </div>
          <div className="space-y-1">
            <CardTitle role="heading" aria-level={2}>{t("consoleTitle")}</CardTitle>
            <CardDescription>{t("consoleDescription")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor={languageId}>{t("language")}</Label>
              <p id={`${languageId}-hint`} className="text-xs text-muted-foreground">{t("languageDescription")}</p>
            </div>
            <NativeSelect
              id={languageId}
              value={locale}
              onChange={event => setLocale(event.target.value === "zh" ? "zh" : "en")}
              aria-describedby={`${languageId}-hint`}
              wrapperClassName="w-full min-[480px]:w-48"
              className="w-full"
            >
              <NativeSelectOption value="en">{t("languageEnglish")}</NativeSelectOption>
              <NativeSelectOption value="zh">{t("languageChinese")}</NativeSelectOption>
            </NativeSelect>
          </div>
        </CardContent>
      </Card>
      <GlobalDefaultsCard />
      <ConnectionSettings projects={projects} />
      <PetSettings follow={follow} projects={projects} />
    </section>
  );
}

function GlobalDefaultsCard() {
  const t = useTranslations("settings.globalDefaults");
  const modelId = useId();
  const secondsId = useId();
  const requestsId = useId();
  const compactionId = useId();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [saved, setSaved] = useState<{
    model: string;
    seconds: string;
    requests: string;
    compactionThreshold: string;
    pet: boolean;
  }>({
    model: "",
    seconds: "",
    requests: "",
    compactionThreshold: "",
    pet: false,
  });
  const [draft, setDraft] = useState(saved);
  const versionRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++versionRef.current;
    setLoading(true);
    setReadError(null);
    void fetch("/api/workspaces", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error ?? t("loadFailed"));
        return value as WorkspaceSettings;
      })
      .then(settings => {
        if (controller.signal.aborted || version !== versionRef.current) return;
        const d = settings.config.defaults;
        const next = {
          model: d.model ?? "",
          seconds: d.seconds !== undefined ? String(d.seconds) : "",
          requests: d.requests !== undefined ? String(d.requests) : "",
          compactionThreshold: d.compactionThreshold !== undefined ? String(d.compactionThreshold) : "",
          pet: d.pet ?? false,
        };
        setSaved(next);
        setDraft(next);
      })
      .catch(error => {
        if (controller.signal.aborted || version !== versionRef.current) return;
        setReadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && version === versionRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [t]);

  const dirty =
    draft.model.trim() !== saved.model.trim() ||
    draft.seconds.trim() !== saved.seconds.trim() ||
    draft.requests.trim() !== saved.requests.trim() ||
    draft.compactionThreshold.trim() !== saved.compactionThreshold.trim() ||
    draft.pet !== saved.pet;

  const saveDefaults = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setWriteError(null);
    setSavedNotice(false);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "globalDefaults",
          defaults: {
            model: draft.model.trim() || null,
            seconds: draft.seconds.trim() ? Number(draft.seconds.trim()) : null,
            requests: draft.requests.trim() ? Number(draft.requests.trim()) : null,
            compactionThreshold: draft.compactionThreshold.trim() ? Number(draft.compactionThreshold.trim()) : null,
            pet: draft.pet,
          },
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error ?? t("saveFailed"));
      const d = (value as GlobalDefaultsResult).config.defaults;
      const next = {
        model: d.model ?? "",
        seconds: d.seconds !== undefined ? String(d.seconds) : "",
        requests: d.requests !== undefined ? String(d.requests) : "",
        compactionThreshold: d.compactionThreshold !== undefined ? String(d.compactionThreshold) : "",
        pet: d.pet ?? false,
      };
      setSaved(next);
      setDraft(next);
      setSavedNotice(true);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-[var(--surface-inset)] text-[var(--gold)]">
          <SlidersHorizontal aria-hidden="true" className="size-4" />
        </div>
        <div className="space-y-1">
          <CardTitle role="heading" aria-level={2}>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {readError && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">{readError}</AlertDescription>
          </Alert>
        )}
        {writeError && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">{writeError}</AlertDescription>
          </Alert>
        )}
        {savedNotice && (
          <Alert className="border-success/35 bg-success/5">
            <CheckCircle2 className="text-success" />
            <AlertTitle>{t("savedTitle")}</AlertTitle>
            <AlertDescription className="text-xs">{t("savedHint")}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={modelId}>{t("modelLabel")}</Label>
            <Input
              id={modelId}
              disabled={loading || saving}
              value={draft.model}
              onChange={event => {
                setDraft(current => ({ ...current, model: event.target.value }));
                setSavedNotice(false);
              }}
              placeholder="openai-codex/gpt-6.1-sol"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("modelHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={secondsId}>{t("secondsLabel")}</Label>
            <Input
              id={secondsId}
              type="number"
              min={1}
              disabled={loading || saving}
              value={draft.seconds}
              onChange={event => {
                setDraft(current => ({ ...current, seconds: event.target.value }));
                setSavedNotice(false);
              }}
              placeholder="1800"
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={requestsId}>{t("requestsLabel")}</Label>
            <Input
              id={requestsId}
              type="number"
              min={1}
              disabled={loading || saving}
              value={draft.requests}
              onChange={event => {
                setDraft(current => ({ ...current, requests: event.target.value }));
                setSavedNotice(false);
              }}
              placeholder="1000"
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={compactionId}>{t("compactionLabel")}</Label>
            <Input
              id={compactionId}
              type="number"
              min={1000}
              disabled={loading || saving}
              value={draft.compactionThreshold}
              onChange={event => {
                setDraft(current => ({ ...current, compactionThreshold: event.target.value }));
                setSavedNotice(false);
              }}
              placeholder={t("compactionPlaceholder")}
              className="font-mono text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-[var(--surface-inset)] p-3">
            <div className="space-y-0.5">
              <Label htmlFor="global-default-pet-switch" className="text-xs font-semibold">
                {t("petLabel")}
              </Label>
              <p className="text-[11px] text-muted-foreground">{t("petHint")}</p>
            </div>
            <Switch
              id="global-default-pet-switch"
              disabled={loading || saving}
              checked={draft.pet}
              onCheckedChange={checked => {
                setDraft(current => ({ ...current, pet: checked }));
                setSavedNotice(false);
              }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            {dirty ? t("unsaved") : t("synced")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(saved);
                setWriteError(null);
                setSavedNotice(false);
              }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("discard")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void saveDefaults()}
            >
              <Save className="size-3.5" aria-hidden="true" />
              {t(saving ? "saving" : "save")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
