"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useActivityPreferences, useDesktopCompanion, usePetSound, usePetVisibility } from "@/features/pet/pet-hooks";
import type { BlockKind, DesktopCompanion, PetSoundSettings } from "@/lib/desktop";
import type { Project } from "@/lib/types";
import type { DesktopFailure } from "@/features/pet/pet-resource";
import { PetFollowSettings, type PetFollow } from "@/features/pet/pet-follow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AdvancedDiagnosticsDisclosure,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-primitives";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/locale";

function SettingSwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  dataResource,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
  dataResource?: string;
}) {
  const id = useId();
  return (
    <div data-pet-resource={dataResource}>
      <SettingsRow
        label={label}
        htmlFor={id}
        description={hint}
        descriptionId={hint ? `${id}-hint` : undefined}
        control={
          <Switch
            id={id}
            checked={checked}
            aria-disabled={disabled}
            className="aria-disabled:opacity-50"
            onCheckedChange={value => { if (!disabled) onChange(value); }}
            aria-describedby={hint ? `${id}-hint` : undefined}
          />
        }
      />
    </div>
  );
}

function ResourceFailureBanner({
  readError,
  known,
  writePending,
  writeError,
}: {
  readError: string | null;
  known: boolean;
  writePending: boolean;
  writeError: DesktopFailure | null;
}) {
  const t = useTranslations("petSettings");
  const rawError = readError || (writeError && writeError.code !== "invalidFile" ? writeError.detail : null);

  return (
    <>
      {writePending && (
        <p role="status" className="text-xs text-muted-foreground">{t("savingLabel")}</p>
      )}
      {readError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            <p>{t("readFailed")}</p>
            {known && <p className="mt-1">{t("showingCached")}</p>}
          </AlertDescription>
        </Alert>
      )}
      {writeError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            <p>{t(writeError.code === "invalidFile" ? "invalidSound" : "writeUnconfirmed")}</p>
          </AlertDescription>
        </Alert>
      )}
      {rawError && (
        <AdvancedDiagnosticsDisclosure summary={t("technicalDetails")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">
            {rawError}
          </pre>
        </AdvancedDiagnosticsDisclosure>
      )}
    </>
  );
}

export function PetSettings({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  const { bridge, ready, recheck } = useDesktopCompanion();
  const sound = usePetSound(bridge);
  const prefs = useActivityPreferences(bridge);
  const visibility = usePetVisibility(bridge);
  const t = useTranslations("petSettings");
  const volumeId = useId();
  const file = useRef<HTMLInputElement>(null);
  const fileBridge = useRef<DesktopCompanion | null>(null);
  const [checkedAvailability, setCheckedAvailability] = useState(false);
  const [volumeDraft, setVolumeDraft] = useState<{ settings: PetSoundSettings; value: number } | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fileBridge.current = null;
    setVolumeDraft(null);
  }, [bridge]);

  const settings = prefs.settings;
  const soundSettings = sound.settings;
  const volume = soundSettings
    ? volumeDraft?.settings === soundSettings
      ? volumeDraft.value
      : Math.round(soundSettings.volume * 100)
    : null;
  const blockLabels: Record<BlockKind, string> = {
    thinking: t("blockThinking"),
    text: t("blockText"),
    tool: t("blockTool"),
    system: t("blockSystem"),
    diagnostic: t("blockDiagnostic"),
  };
  const visibilityDisabled = visibility.pending || !!visibility.readError || !!visibility.writeError;
  const prefsDisabled = prefs.pending || !!prefs.readError || !!prefs.writeError;
  const soundDisabled = sound.pending || !!sound.readError || (!!sound.writeError && sound.writeError.code !== "invalidFile");
  const companionBusy = visibility.loading || visibility.pending || prefs.loading || prefs.pending;
  const companionError = visibility.readError || prefs.readError;
  const companionReadLabel = t(
    visibility.loading || prefs.loading
      ? "readingSettings"
      : companionError
        ? "retryRead"
        : "readAgain",
  );
  const soundReadLabel = t(
    sound.loading ? "readingSettings" : sound.readError ? "retryRead" : "readAgain",
  );

  return (
    <div className="grid min-w-0 gap-6">
      <PetFollowSettings follow={follow} projects={projects} />

      {!bridge && (
        <div
          data-pet-availability
          className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground"
        >
          <span role={checkedAvailability ? "status" : undefined}>
            {!ready
              ? t("checkingAvailability")
              : checkedAvailability
                ? t("checkedUnavailable")
                : t("desktopBannerTitle")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { recheck(); setCheckedAvailability(true); }}
          >
            {t("desktopBannerAction")}
          </Button>
        </div>
      )}

      {bridge && (
        <>
          <div className="grid min-w-0 gap-3">
            <SettingsSection
              title={t("companionTitle")}
              description={`${t("companionDesc")} · ${t("logsDesc")}`}
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-disabled={companionBusy}
                  className="aria-disabled:opacity-50"
                  aria-label={`${companionReadLabel} · ${t("companionTitle")}`}
                  onClick={() => {
                    if (companionBusy) return;
                    visibility.retry();
                    prefs.retry();
                  }}
                >
                  {companionReadLabel}
                </Button>
              }
            >
              {visibility.settings !== null && (
                <SettingSwitchRow
                  dataResource="visibility"
                  label={t("showPetLabel")}
                  hint={t("showPetHint")}
                  checked={visibility.settings}
                  disabled={visibilityDisabled}
                  onChange={() => { void visibility.toggle(); }}
                />
              )}

              {settings && (
                <>
                  {(["enabled", "pet", "main", "brief"] as const).map(key => (
                    <SettingSwitchRow
                      key={key}
                      dataResource="notifications"
                      label={{
                        enabled: t("prefEnabled"),
                        pet: t("prefPet"),
                        main: t("prefMain"),
                        brief: t("prefBrief"),
                      }[key]}
                      hint={key === "main" ? t("mainHint") : key === "brief" ? t("briefHint") : undefined}
                      checked={settings[key]}
                      disabled={prefsDisabled}
                      onChange={value => { void prefs.update({ [key]: value }); }}
                    />
                  ))}

                  <SettingsRow
                    label={t("logsTitle")}
                    description={
                      settings.pausedUntil > now
                        ? `${t("pausedPrefix")}${new Date(settings.pausedUntil).toLocaleTimeString()}${t("pausedSuffix")}`
                        : undefined
                    }
                    control={
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-disabled={prefsDisabled}
                          className="aria-disabled:opacity-50"
                          onClick={() => {
                            if (!prefsDisabled) {
                              void prefs.update({
                                pausedUntil: settings.pausedUntil > now ? 0 : Date.now() + 3_600_000,
                              });
                            }
                          }}
                        >
                          {settings.pausedUntil > now ? t("resumeNotifications") : t("pauseHour")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-disabled={prefsDisabled}
                          className="aria-disabled:opacity-50"
                          onClick={() => { if (!prefsDisabled) void prefs.reset(); }}
                        >
                          {t("resetDefaults")}
                        </Button>
                      </div>
                    }
                  />
                </>
              )}
            </SettingsSection>

            {settings && (
              <AdvancedDiagnosticsDisclosure summary={t("contentHeading")}>
                <div className="settings-rows">
                  {(Object.keys(blockLabels) as BlockKind[]).map(kind => (
                    <SettingSwitchRow
                      key={kind}
                      label={blockLabels[kind]}
                      checked={settings.blocks[kind]}
                      disabled={prefsDisabled}
                      onChange={value => {
                        void prefs.update({ blocks: { ...settings.blocks, [kind]: value } });
                      }}
                    />
                  ))}
                </div>
              </AdvancedDiagnosticsDisclosure>
            )}

            <ResourceFailureBanner
              readError={visibility.readError}
              known={visibility.settings !== null}
              writePending={visibility.pending}
              writeError={visibility.writeError}
            />
            <ResourceFailureBanner
              readError={prefs.readError}
              known={!!settings}
              writePending={prefs.pending}
              writeError={prefs.writeError}
            />
          </div>

          <div data-pet-resource="sound" role="region" aria-label={t("soundTitle")} className="grid min-w-0 gap-3">
            <SettingsSection
              title={t("soundTitle")}
              description={t("soundDesc")}
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-disabled={sound.loading || sound.pending}
                  className="aria-disabled:opacity-50"
                  aria-label={`${soundReadLabel} · ${t("soundTitle")}`}
                  onClick={() => {
                    if (!sound.loading && !sound.pending) sound.retry();
                  }}
                >
                  {soundReadLabel}
                </Button>
              }
            >
              {soundSettings && volume !== null ? (
                <>
                  <SettingSwitchRow
                    label={t("clickSoundLabel")}
                    checked={soundSettings.enabled}
                    disabled={soundDisabled}
                    onChange={enabled => { void sound.update({ enabled }); }}
                  />

                  <SettingsRow
                    label={<span id={volumeId}>{t("volumeLabel")}</span>}
                    meta={<output className="tabular-nums">{volume}%</output>}
                    control={
                      <div className="w-full sm:w-56">
                        <Slider
                          min={0}
                          max={100}
                          step={1}
                          value={[volume]}
                          aria-disabled={soundDisabled}
                          className="aria-disabled:opacity-50"
                          aria-labelledby={volumeId}
                          onKeyDownCapture={event => {
                            if (soundDisabled && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                              event.preventDefault();
                            }
                          }}
                          onPointerDownCapture={event => { if (soundDisabled) event.preventDefault(); }}
                          onValueChange={([value]) => {
                            if (!soundDisabled) setVolumeDraft({ settings: soundSettings, value });
                          }}
                          onValueCommit={([value]) => {
                            if (soundDisabled) return;
                            void sound.update({ volume: value / 100 }).then(() => {
                              if (sound.current()) {
                                setVolumeDraft(previous => (previous?.settings === soundSettings ? null : previous));
                              }
                            });
                          }}
                        />
                      </div>
                    }
                  />

                  <SettingsRow
                    label={t("soundFileHeading")}
                    description={
                      <>
                        <span className="block break-all text-foreground/85">
                          {soundSettings.source?.name ?? t("noSoundFile")}
                        </span>
                        <span className="block">{t("soundFormatHint")}</span>
                      </>
                    }
                    control={
                      <>
                        <input
                          ref={file}
                          type="file"
                          accept=".wav,.mp3,.ogg"
                          hidden
                          aria-label={t("selectFileAria")}
                          onChange={event => {
                            const chosen = event.target.files?.[0];
                            event.target.value = "";
                            if (chosen && fileBridge.current === bridge && !soundDisabled) {
                              void sound.importFile(chosen);
                            }
                          }}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-disabled={soundDisabled}
                            className="aria-disabled:opacity-50"
                            onClick={() => {
                              if (soundDisabled) return;
                              fileBridge.current = bridge;
                              file.current?.click();
                            }}
                          >
                            {t("chooseFile")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-disabled={!soundSettings.source || soundDisabled || volume === 0}
                            className="aria-disabled:opacity-50"
                            onClick={() => {
                              if (soundSettings.source && !soundDisabled && volume !== 0) void sound.preview();
                            }}
                          >
                            {t("previewLabel")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-disabled={soundDisabled}
                            className="aria-disabled:opacity-50"
                            onClick={() => { if (!soundDisabled) void sound.reset(); }}
                          >
                            {t("restoreDefaultSound")}
                          </Button>
                        </div>
                      </>
                    }
                  />
                </>
              ) : (
                <SettingsRow
                  label={t("soundTitle")}
                  meta={<span role="status">{sound.loading ? t("readingSettings") : t("unknownValues")}</span>}
                />
              )}
            </SettingsSection>

            <ResourceFailureBanner
              readError={sound.readError}
              known={!!soundSettings}
              writePending={sound.pending}
              writeError={sound.writeError}
            />
            {sound.previewError && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{t("previewFailed")}</AlertDescription>
              </Alert>
            )}
          </div>
        </>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">{t("footerNote")}</p>
    </div>
  );
}
