"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bot, Cable, Cpu, HardDrive, Monitor, SlidersHorizontal } from "lucide-react";
import { PetSettings } from "@/features/pet/pet-settings";
import { ConnectionSettings } from "@/features/workspaces/connection-settings";
import { StorageSettings } from "@/features/workspaces/storage-settings";
import {
  ModelEffortBadge,
  ModelPickerDialog,
  ServiceTierBadge,
  type ModelEffort,
  type ModelServiceTier,
} from "@/components/model-picker-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
  SettingsWorkspaceLayout,
  type SettingsCategoryItem,
} from "@/components/ui/settings-primitives";
import { Switch } from "@/components/ui/switch";
import { useLocale, useTranslations } from "@/lib/locale";
import {
  INFO_VERBOSITY_LEVELS,
  useInfoVerbosity,
  type InfoVerbosityLevel,
} from "@/lib/use-info-verbosity";
import { useOptionalLudensRpc } from "@/lib/ludens-rpc";
import type { Project } from "@ludens/protocol/types";
import type { GlobalDefaultsResult, WorkspaceSettings } from "@ludens/protocol/workspaces";
import type { WorkspaceDefaults } from "@ludens/protocol/workspaces";
import type { PetFollow } from "@/features/pet/pet-follow";

export type SettingsCategoryId = "general" | "defaults" | "storage" | "transport" | "pet";

export function SettingsView({
  follow,
  projects,
  initialCategory = "general",
}: {
  follow: PetFollow;
  projects: Project[];
  initialCategory?: SettingsCategoryId;
}) {
  const { locale, setLocale } = useLocale();
  const { level: verbosity, setLevel: setVerbosity } = useInfoVerbosity();
  const t = useTranslations("settings");
  const vt = useTranslations("views.settings");
  const languageId = useId();
  const verbosityId = useId();
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(initialCategory);

  const categories: SettingsCategoryItem[] = [
    { id: "general", label: t("categories.general"), icon: <Monitor aria-hidden="true" className="size-4" /> },
    { id: "defaults", label: t("categories.defaults"), icon: <SlidersHorizontal aria-hidden="true" className="size-4" /> },
    { id: "storage", label: t("categories.storage"), icon: <HardDrive aria-hidden="true" className="size-4" /> },
    { id: "transport", label: t("categories.transport"), icon: <Cable aria-hidden="true" className="size-4" /> },
    { id: "pet", label: t("categories.pet"), icon: <Bot aria-hidden="true" className="size-4" /> },
  ];

  return (
    <SettingsWorkspaceLayout
      navLabel={t("sectionsNavLabel")}
      categories={categories}
      activeCategory={activeCategory}
      onCategoryChange={id => setActiveCategory(id as SettingsCategoryId)}
      title={vt("title")}
      subtitle={vt("description")}
      headingLevel={1}
      className="settings-page mx-auto w-full max-w-5xl"
    >
      {activeCategory === "general" && (
        <SettingsSection title={t("generalTitle")} description={t("generalDescription")}>
          <SettingsRow
            label={t("language")}
            htmlFor={languageId}
            description={t("languageDescription")}
            descriptionId={`${languageId}-hint`}
            control={
              <NativeSelect
                id={languageId}
                value={locale}
                onChange={event => setLocale(event.target.value === "zh" ? "zh" : "en")}
                aria-describedby={`${languageId}-hint`}
                wrapperClassName="w-full sm:w-48"
                className="w-full"
              >
                <NativeSelectOption value="en">{t("languageEnglish")}</NativeSelectOption>
                <NativeSelectOption value="zh">{t("languageChinese")}</NativeSelectOption>
              </NativeSelect>
            }
          />
          <SettingsRow
            label={t("infoVerbosity")}
            description={t("infoVerbosityDescription")}
            descriptionId={`${verbosityId}-hint`}
            control={
              <div className="flex w-full flex-col gap-2 sm:w-80">
                <div
                  id={verbosityId}
                  role="radiogroup"
                  aria-label={t("infoVerbosity")}
                  aria-describedby={`${verbosityId}-hint`}
                  data-info-verbosity-picker=""
                  className="grid grid-cols-5 gap-1 rounded-md border border-border/70 bg-muted/30 p-1"
                >
                  {INFO_VERBOSITY_LEVELS.map(item => {
                    const selected = verbosity === item;
                    return (
                      <button
                        key={item}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-verbosity-level={item}
                        data-active={selected ? "true" : undefined}
                        onClick={() => setVerbosity(item as InfoVerbosityLevel)}
                        className={
                          "flex flex-col items-center justify-center rounded px-1.5 py-1 text-[11px] font-medium transition-colors " +
                          (selected
                            ? "bg-primary text-primary-foreground shadow-xs"
                            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground")
                        }
                      >
                        <span className="font-mono text-[10px] opacity-80">L{item}</span>
                        <span className="truncate">{t(`infoVerbosityLevel${item}Label`)}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11.5px] leading-snug text-muted-foreground" data-info-verbosity-detail="">
                  {t(`infoVerbosityLevel${verbosity}Detail`)}
                </p>
              </div>
            }
          />
        </SettingsSection>
      )}
      {activeCategory === "defaults" && <GlobalDefaultsCard />}
      {activeCategory === "storage" && <StorageSettings />}
      {activeCategory === "transport" && <ConnectionSettings projects={projects} />}
      {activeCategory === "pet" && <PetSettings follow={follow} projects={projects} />}
    </SettingsWorkspaceLayout>
  );
}

export function GlobalDefaultsCard() {
  const t = useTranslations("settings.globalDefaults");
  const st = useTranslations("settings");
  const ct = useTranslations("connectionSettings");
  const modelId = useId();
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
    compactionThreshold: string;
    pet: boolean;
  }>({
    model: "",
    serviceTier: null,
    effort: null,
    compactionThreshold: "",
    pet: false,
  });
  const [draft, setDraft] = useState(saved);
  const versionRef = useRef(0);
  const rpc = useOptionalLudensRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    const controller = new AbortController();
    const version = ++versionRef.current;
    setLoading(true);
    setReadError(null);
    const caller = rpcRef.current;
    if (!caller) {
      setLoading(false);
      setReadError(t("loadFailed"));
      return () => controller.abort();
    }
    void caller
      .call("workspaces/getSettings", undefined, { signal: controller.signal })
      .then(value => value as WorkspaceSettings)
      .then(settings => {
        if (controller.signal.aborted || version !== versionRef.current) return;
        const d = settings.config.defaults;
        const next = {
          model: d.model ?? "",
          serviceTier: d.serviceTier ?? null,
          effort: d.effort ?? null,
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
  }, [t, Boolean(rpc), rpc?.reconnectGeneration ?? 0]);

  const dirty =
    draft.model.trim() !== saved.model.trim() ||
    draft.serviceTier !== saved.serviceTier ||
    draft.effort !== saved.effort ||
    draft.compactionThreshold.trim() !== saved.compactionThreshold.trim() ||
    draft.pet !== saved.pet;

  const saveDefaults = async () => {
    if (saving || !dirty) return;
    const caller = rpcRef.current;
    if (!caller) {
      setWriteError("RPC client is unavailable");
      return;
    }
    setSaving(true);
    setWriteError(null);
    setSavedNotice(false);
    try {
      const value = await caller.call("workspaces/mutate", {
        action: "updateGlobalDefaults",
        defaults: {
          model: draft.model.trim() || null,
          serviceTier: draft.serviceTier,
          effort: draft.effort,
          compactionThreshold: draft.compactionThreshold.trim() ? Number(draft.compactionThreshold.trim()) : null,
          pet: draft.pet,
        } as unknown as Partial<WorkspaceDefaults>,
      });
      const d = (value as GlobalDefaultsResult).config.defaults;
      const next = {
        model: d.model ?? "",
        serviceTier: d.serviceTier ?? null,
        effort: d.effort ?? null,
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
    <div className="grid min-w-0 gap-4">
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

      <SettingsSection title={st("defaultsSectionTitle")}>
        <SettingsRow
          label={st("defaultsModelLabel")}
          htmlFor={modelId}
          description={st("defaultsModelHint")}
          stacked
          control={
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
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
                placeholder="openai-codex/gpt-6.2-sol"
                className="font-mono text-sm sm:flex-1"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-2">
                <ModelEffortBadge effort={draft.effort} />
                <ServiceTierBadge
                  tier={draft.serviceTier}
                  showStandard={Boolean(draft.model.trim())}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={loading || saving}
                  data-browse-models="global-defaults"
                  onClick={() => setModelPickerOpen(true)}
                >
                  <Cpu className="size-3.5" aria-hidden="true" />
                  {t("browseModels")}
                </Button>
              </div>
            </div>
          }
        />

        <SettingsRow
          label={st("defaultsCompactionLabel")}
          htmlFor={compactionId}
          control={
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
              className="w-full font-mono text-sm sm:w-52"
            />
          }
        />

        <SettingsRow
          label={st("defaultsPetLabel")}
          htmlFor="global-default-pet-switch"
          description={st("defaultsPetHint")}
          control={
            <Switch
              id="global-default-pet-switch"
              disabled={loading || saving}
              checked={draft.pet}
              onCheckedChange={checked => {
                setDraft(current => ({ ...current, pet: checked }));
                setSavedNotice(false);
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSaveBar
        dirty={dirty}
        statusText={dirty ? t("unsaved") : savedNotice ? t("savedHint") : ct("noChanges")}
        discardLabel={t("discard")}
        onDiscard={() => {
          setDraft(saved);
          setWriteError(null);
          setSavedNotice(false);
        }}
        saveLabel={t("save")}
        savingLabel={t("saving")}
        saving={saving}
        disabled={loading}
        onSave={() => void saveDefaults()}
      />

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
  );
}
