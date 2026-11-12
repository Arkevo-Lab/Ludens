"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bot, Cable, CheckCircle2, Cpu, Monitor, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { PetSettings } from "@/features/pet/pet-settings";
import { ConnectionSettings } from "@/features/workspaces/connection-settings";
import {
  ModelEffortBadge,
  ModelPickerDialog,
  ServiceTierBadge,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
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

type SettingsSectionId = "settings-console" | "settings-defaults" | "settings-connection" | "settings-pet";

export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { locale, setLocale } = useLocale();
  const t = useTranslations("settings");
  const languageId = useId();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("settings-console");
  const sections: { id: SettingsSectionId; label: string; icon: typeof Monitor }[] = [
    { id: "settings-console", label: t("sections.console"), icon: Monitor },
    { id: "settings-defaults", label: t("sections.defaults"), icon: SlidersHorizontal },
    { id: "settings-connection", label: t("sections.connection"), icon: Cable },
    { id: "settings-pet", label: t("sections.pet"), icon: Bot },
  ];

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids: SettingsSectionId[] = ["settings-console", "settings-defaults", "settings-connection", "settings-pet"];
    const elements = ids
      .map(sectionId => document.getElementById(sectionId))
      .filter((element): element is HTMLElement => element !== null);
    if (!elements.length) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActiveSection(visible[0].target.id as SettingsSectionId);
        }
      },
      { rootMargin: "-72px 0px -65% 0px", threshold: [0, 0.15] },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="settings-page mx-auto grid w-full max-w-5xl gap-5">
      <nav
        aria-label={t("sectionsNavLabel")}
        data-settings-jump-nav
        className="sticky top-0 z-20 flex items-center gap-1.5 overflow-x-auto rounded-lg border border-border/80 bg-background/90 p-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      >
        {sections.map(section => {
          const Icon = section.icon;
          const active = activeSection === section.id;
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={active ? "true" : undefined}
              onClick={event => {
                event.preventDefault();
                setActiveSection(section.id);
                document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors " +
                (active
                  ? "border-[color-mix(in_srgb,var(--gold)_45%,var(--border))] bg-[var(--surface-inset)] text-foreground shadow-xs"
                  : "border-transparent text-muted-foreground hover:bg-[var(--surface-inset)]/60 hover:text-foreground")
              }
            >
              <Icon className={"size-3.5 shrink-0 " + (active ? "text-[var(--gold)]" : "")} aria-hidden="true" />
              <span>{section.label}</span>
            </a>
          );
        })}
      </nav>
      <div id="settings-console" className="min-w-0 scroll-mt-16">
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
      </div>
      <div id="settings-defaults" className="min-w-0 scroll-mt-16">
        <GlobalDefaultsCard />
      </div>
      <div id="settings-connection" className="min-w-0 scroll-mt-16">
        <ConnectionSettings projects={projects} />
      </div>
      <div id="settings-pet" className="min-w-0 scroll-mt-16">
        <PetSettings follow={follow} projects={projects} />
      </div>
    </section>
  );
}

export function GlobalDefaultsCard() {
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const [saved, setSaved] = useState<{
    model: string;
    serviceTier: ModelServiceTier | null;
    effort: ModelEffort | null;
    seconds: string;
    requests: string;
    compactionThreshold: string;
    pet: boolean;
  }>({
    model: "",
    serviceTier: null,
    effort: null,
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
          serviceTier: d.serviceTier ?? null,
          effort: d.effort ?? null,
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
    draft.serviceTier !== saved.serviceTier ||
    draft.effort !== saved.effort ||
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
            serviceTier: draft.serviceTier,
            effort: draft.effort,
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
        serviceTier: d.serviceTier ?? null,
        effort: d.effort ?? null,
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
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={modelId}
                disabled={loading || saving}
                value={draft.model}
                onChange={event => {
                  setDraft(current => ({
                    ...current,
                    model: event.target.value,
                    serviceTier: null,
                    effort: null,
                  }));
                  setSavedNotice(false);
                }}
                placeholder="openai-codex/gpt-6.1-sol"
                className="font-mono text-sm sm:flex-1"
                spellCheck={false}
              />
              <ModelEffortBadge effort={draft.effort} className="self-start sm:self-center" />
              <ServiceTierBadge
                tier={draft.serviceTier}
                showStandard={Boolean(draft.model.trim())}
                className="self-start sm:self-center"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={loading || saving}
                data-browse-models="global-defaults"
                onClick={() => setModelPickerOpen(true)}
              >
                <Cpu className="size-3.5" aria-hidden="true" />
                {t("browseModels")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("modelHint")}</p>
            <ModelPickerDialog
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              value={draft.model}
              serviceTier={draft.serviceTier}
              effort={draft.effort}
              allowUnauthenticated={true}
              onSelect={(nextModel, nextServiceTier, nextEffort) => {
                setDraft(current => ({
                  ...current,
                  model: nextModel,
                  serviceTier: nextServiceTier,
                  effort: nextEffort,
                }));
                setSavedNotice(false);
              }}
            />
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
