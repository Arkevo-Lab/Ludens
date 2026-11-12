"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AlertCircle,
  Check,
  Cpu,
  Eye,
  KeyRound,
  Gauge,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "@/lib/locale";

export type ModelServiceTier = "priority" | "ultrafast";

export interface AvailableModelItem {
  fullId: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  authenticated: boolean;
  supportedServiceTiers: ModelServiceTier[];
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  providers: { id: string; count: number; authenticated: boolean }[];
  currentModel?: string | null;
  currentServiceTier?: ModelServiceTier | null;
}

export interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null | undefined;
  serviceTier?: ModelServiceTier | null;
  projectId?: string | null;
  onSelect: (modelFullId: string, serviceTier: ModelServiceTier | null) => Promise<void> | void;
  disabled?: boolean;
  disabledReason?: string;
  allowUnauthenticated?: boolean;
  catalogOverride?: AvailableModelsCatalog | null;
  inline?: boolean;
}

export function shortModelLabel(model: string | null | undefined, fallback: string): string {
  const trimmed = model?.trim();
  if (!trimmed) return fallback;
  const slash = trimmed.indexOf("/");
  return slash >= 0 && slash + 1 < trimmed.length ? trimmed.slice(slash + 1) : trimmed;
}

export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens >= 1_048_576 && tokens % 1_048_576 === 0
      ? tokens / 1_048_576
      : tokens / 1_000_000;
    const rounded = Math.round(millions * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens % 1_024 === 0 && tokens / 1_024 >= 8 && (tokens / 1_024) % 16 === 0
      ? Math.round(tokens / 1_000)
      : Math.round(tokens / 1_000);
    return `${thousands}K`;
  }
  return String(Math.round(tokens));
}

export function filterAvailableModels(
  models: readonly AvailableModelItem[],
  options: {
    query?: string;
    provider?: string;
    includeUnauthenticated?: boolean;
  } = {},
): AvailableModelItem[] {
  const includeUnauth = Boolean(options.includeUnauthenticated);
  const providerFilter = options.provider && options.provider !== "all" ? options.provider : null;
  const tokens = (options.query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return models.filter(item => {
    if (!includeUnauth && !item.authenticated) return false;
    if (providerFilter && item.provider !== providerFilter) return false;
    if (tokens.length === 0) return true;
    const haystack = `${item.fullId} ${item.name} ${item.provider} ${item.id}`.toLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
}

export function buildProviderTabs(
  models: readonly AvailableModelItem[],
  options: {
    query?: string;
    includeUnauthenticated?: boolean;
  } = {},
): Array<{ id: string; count: number; authenticated: boolean }> {
  const scoped = filterAvailableModels(models, {
    query: options.query,
    provider: "all",
    includeUnauthenticated: options.includeUnauthenticated,
  });
  const byProvider = new Map<string, { id: string; count: number; authenticated: boolean }>();
  for (const item of scoped) {
    const existing = byProvider.get(item.provider);
    if (existing) {
      existing.count += 1;
      if (item.authenticated) existing.authenticated = true;
    } else {
      byProvider.set(item.provider, {
        id: item.provider,
        count: 1,
        authenticated: item.authenticated,
      });
    }
  }
  return [...byProvider.values()].sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function isModelSelectable(
  item: AvailableModelItem,
  options: { disabled?: boolean; allowUnauthenticated?: boolean } = {},
): boolean {
  if (options.disabled) return false;
  if (!options.allowUnauthenticated && !item.authenticated) return false;
  return true;
}

export function serviceTierForModel(
  item: AvailableModelItem | null | undefined,
  tier: ModelServiceTier | null | undefined,
): ModelServiceTier | null {
  return tier && item?.supportedServiceTiers.includes(tier) ? tier : null;
}

/** Marker for a premium serving tier; renders nothing for Standard. `iconOnly` keeps the label for assistive tech and tooltip only. */
export function ServiceTierBadge({
  tier,
  iconOnly = false,
  className,
}: {
  tier: ModelServiceTier | null | undefined;
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations("modelPicker");
  if (!tier) return null;
  const Icon = tier === "ultrafast" ? Rocket : Gauge;
  const label = t(tier === "ultrafast" ? "serviceTierUltra" : "serviceTierFast");
  return (
    <span
      className={["service-tier-badge", className].filter(Boolean).join(" ")}
      data-service-tier={tier}
      data-icon-only={iconOnly || undefined}
      title={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}

export function stepHighlightedIndex(
  current: number,
  items: readonly AvailableModelItem[],
  delta: 1 | -1,
  options: { disabled?: boolean; allowUnauthenticated?: boolean } = {},
): number {
  const selectableIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (isModelSelectable(items[i]!, options)) selectableIndices.push(i);
  }
  if (selectableIndices.length === 0) return -1;
  const pos = selectableIndices.indexOf(current);
  if (pos === -1) {
    return delta > 0 ? selectableIndices[0]! : selectableIndices[selectableIndices.length - 1]!;
  }
  const nextPos = (pos + delta + selectableIndices.length) % selectableIndices.length;
  return selectableIndices[nextPos]!;
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  value,
  serviceTier,
  projectId,
  onSelect,
  disabled = false,
  disabledReason,
  allowUnauthenticated = false,
  catalogOverride,
  inline = false,
}: ModelPickerDialogProps) {
  const t = useTranslations("modelPicker");
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const requestVersionRef = useRef(0);

  const [fetchedCatalog, setFetchedCatalog] = useState<AvailableModelsCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const [showUnauthenticated, setShowUnauthenticated] = useState<boolean>(allowUnauthenticated);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [stagedModel, setStagedModel] = useState<string | null>(null);
  const [stagedServiceTier, setStagedServiceTier] = useState<ModelServiceTier | null>(null);

  useEffect(() => {
    setShowUnauthenticated(allowUnauthenticated);
  }, [allowUnauthenticated, open]);

  useEffect(() => {
    if (!open) {
      setSelectError(null);
      setSelectingId(null);
      return;
    }
    setQuery("");
    setSelectedProvider("all");
    setSelectError(null);
  }, [open]);

  useEffect(() => {
    if (!open || catalogOverride !== undefined) return;
    const controller = new AbortController();
    const version = ++requestVersionRef.current;
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (projectId?.trim()) params.set("project", projectId.trim());
    const url = params.size > 0 ? `/api/models?${params}` : "/api/models";

    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof payload?.error === "string" ? payload.error : t("loadFailed"),
          );
        }
        return payload as AvailableModelsCatalog;
      })
      .then(result => {
        if (controller.signal.aborted || version !== requestVersionRef.current) return;
        setFetchedCatalog(result);
      })
      .catch(error => {
        if (controller.signal.aborted || version !== requestVersionRef.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && version === requestVersionRef.current) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [open, projectId, reloadTick, catalogOverride, t]);

  const catalog = catalogOverride !== undefined ? catalogOverride : fetchedCatalog;
  const allModels = catalog?.models ?? [];
  const normalizedValue = (value?.trim() || catalog?.currentModel?.trim() || "") || null;

  useEffect(() => {
    if (!open) return;
    setStagedModel(normalizedValue);
    setStagedServiceTier(serviceTier !== undefined ? serviceTier : catalog?.currentServiceTier ?? null);
  }, [open, normalizedValue, serviceTier, catalog?.currentServiceTier]);

  const stagedModelItem = allModels.find(item => item.fullId === stagedModel);
  const effectiveStagedServiceTier = serviceTierForModel(stagedModelItem, stagedServiceTier);

  const unauthenticatedCount = useMemo(
    () => allModels.filter(item => !item.authenticated).length,
    [allModels],
  );
  const authenticatedCount = allModels.length - unauthenticatedCount;

  // If zero models are authenticated yet, surface unauthenticated catalog items with clear badge so dialog isn't blank
  const effectiveIncludeUnauth =
    showUnauthenticated || (allModels.length > 0 && authenticatedCount === 0);

  const providerTabs = useMemo(
    () =>
      buildProviderTabs(allModels, {
        query,
        includeUnauthenticated: effectiveIncludeUnauth,
      }),
    [allModels, query, effectiveIncludeUnauth],
  );

  const activeProvider =
    selectedProvider === "all" || providerTabs.some(tab => tab.id === selectedProvider)
      ? selectedProvider
      : "all";

  const scopedTotalCount = useMemo(
    () => providerTabs.reduce((sum, tab) => sum + tab.count, 0),
    [providerTabs],
  );

  const visibleModels = useMemo(
    () =>
      filterAvailableModels(allModels, {
        query,
        provider: activeProvider,
        includeUnauthenticated: effectiveIncludeUnauth,
      }),
    [allModels, query, activeProvider, effectiveIncludeUnauth],
  );

  useEffect(() => {
    if (visibleModels.length === 0) {
      setHighlightedIndex(-1);
      return;
    }
    const currentIdx = stagedModel
      ? visibleModels.findIndex(item => item.fullId === stagedModel)
      : -1;
    if (
      currentIdx >= 0 &&
      isModelSelectable(visibleModels[currentIdx]!, { disabled, allowUnauthenticated })
    ) {
      setHighlightedIndex(currentIdx);
      return;
    }
    const firstSelectable = visibleModels.findIndex(item =>
      isModelSelectable(item, { disabled, allowUnauthenticated }),
    );
    setHighlightedIndex(firstSelectable);
  }, [visibleModels, stagedModel, disabled, allowUnauthenticated]);

  const stageSelection = useCallback((item: AvailableModelItem) => {
    if (selectingId || !isModelSelectable(item, { disabled, allowUnauthenticated })) return;
    setSelectError(null);
    setStagedModel(item.fullId);
    setStagedServiceTier(current => serviceTierForModel(item, current));
  }, [selectingId, disabled, allowUnauthenticated]);

  const commitSelection = useCallback(
    async () => {
      const item = stagedModelItem;
      if (!item || selectingId || !isModelSelectable(item, { disabled, allowUnauthenticated })) return;
      setSelectError(null);
      setSelectingId(item.fullId);
      try {
        await onSelect(item.fullId, effectiveStagedServiceTier);
        onOpenChange(false);
      } catch (error) {
        setSelectError(error instanceof Error ? error.message : String(error));
      } finally {
        setSelectingId(null);
      }
    },
    [stagedModelItem, effectiveStagedServiceTier, selectingId, disabled, allowUnauthenticated, onSelect, onOpenChange],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("[data-service-tier], [data-model-picker-apply]")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = stepHighlightedIndex(highlightedIndex, visibleModels, 1, {
        disabled,
        allowUnauthenticated,
      });
      setHighlightedIndex(next);
      const nextItem = next >= 0 ? visibleModels[next] : undefined;
      if (nextItem) {
        optionRefs.current.get(nextItem.fullId)?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = stepHighlightedIndex(highlightedIndex, visibleModels, -1, {
        disabled,
        allowUnauthenticated,
      });
      setHighlightedIndex(prev);
      const prevItem = prev >= 0 ? visibleModels[prev] : undefined;
      if (prevItem) {
        optionRefs.current.get(prevItem.fullId)?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter") {
      const target = highlightedIndex >= 0 ? visibleModels[highlightedIndex] : undefined;
      if (target && isModelSelectable(target, { disabled, allowUnauthenticated })) {
        event.preventDefault();
        stageSelection(target);
      }
    }
  };

  const dialogInner = (
    <>
      {/* Header */}
      <header className="model-picker-header">
        <div className="model-picker-header-main">
          <div className="model-picker-icon-badge" aria-hidden="true">
            <Cpu className="size-4" />
          </div>
          <div className="min-w-0">
            {inline ? (
              <>
                <h2 className="model-picker-title">{t("title")}</h2>
                <p className="model-picker-subtitle">{t("subtitle")}</p>
              </>
            ) : (
              <>
                <DialogTitle className="model-picker-title">{t("title")}</DialogTitle>
                <DialogDescription className="model-picker-subtitle">
                  {t("subtitle")}
                </DialogDescription>
              </>
            )}
          </div>
        </div>

        <div className="model-picker-header-actions">
          {catalogOverride === undefined && (
            <button
              type="button"
              className="model-picker-icon-btn"
              title={t("refresh")}
              aria-label={t("refresh")}
              disabled={loading}
              onClick={() => setReloadTick(v => v + 1)}
            >
              <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} aria-hidden="true" />
            </button>
          )}
          {inline ? (
            <button
              type="button"
              className="model-picker-icon-btn"
              title={t("close")}
              aria-label={t("close")}
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <DialogClose asChild>
              <button
                type="button"
                className="model-picker-icon-btn"
                title={t("close")}
                aria-label={t("close")}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </DialogClose>
          )}
        </div>
      </header>

        {/* Disabled / Running Lock Banner */}
        {disabled && disabledReason && (
          <div className="model-picker-banner model-picker-banner-warn" role="status" data-model-picker-locked>
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{disabledReason}</span>
          </div>
        )}

        {/* Selection Error Banner */}
        {selectError && (
          <div className="model-picker-banner model-picker-banner-err" role="alert">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{selectError}</span>
          </div>
        )}

        {/* Search Input + Auth Scope Toggle */}
        <div className="model-picker-search-bar">
          <div className="model-picker-search-input-wrap">
            <Search className="model-picker-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              role="combobox"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-activedescendant={
                highlightedIndex >= 0 && visibleModels[highlightedIndex]
                  ? `${listboxId}-opt-${highlightedIndex}`
                  : undefined
              }
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              className="model-picker-search-input"
              data-model-picker-search
            />
            {query && (
              <button
                type="button"
                className="model-picker-clear-btn"
                aria-label={t("clearSearch")}
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          {unauthenticatedCount > 0 && authenticatedCount > 0 && (
            <button
              type="button"
              className="model-picker-auth-toggle"
              aria-pressed={showUnauthenticated}
              data-active={showUnauthenticated || undefined}
              onClick={() => setShowUnauthenticated(prev => !prev)}
            >
              <KeyRound className="size-3" aria-hidden="true" />
              <span>
                {showUnauthenticated
                  ? t("hideUnauthenticated")
                  : t("showUnauthenticated").replace("{count}", String(unauthenticatedCount))}
              </span>
            </button>
          )}
        </div>

        {/* Provider Filter Tabs */}
        {providerTabs.length > 0 && (
          <div className="model-picker-providers" role="tablist" aria-label={t("providerFilterAria")}>
            <button
              type="button"
              role="tab"
              aria-selected={activeProvider === "all"}
              data-provider-tab="all"
              data-active={activeProvider === "all" || undefined}
              className="model-picker-provider-tab"
              onClick={() => setSelectedProvider("all")}
            >
              <span>{t("allProviders")}</span>
              <span className="model-picker-provider-count">{scopedTotalCount}</span>
            </button>
            {providerTabs.map(provider => {
              const active = activeProvider === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-provider-tab={provider.id}
                  data-active={active || undefined}
                  className="model-picker-provider-tab"
                  onClick={() => setSelectedProvider(provider.id)}
                >
                  <i
                    className="model-picker-auth-dot"
                    data-authenticated={provider.authenticated ? "true" : "false"}
                    aria-hidden="true"
                  />
                  <span className="font-mono">{provider.id}</span>
                  <span className="model-picker-provider-count">{provider.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Model List Body */}
        <div id={listboxId} role="listbox" aria-label={t("title")} className="model-picker-list">
          {loading && !catalog ? (
            <div className="model-picker-state" role="status">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
              <span>{t("loading")}</span>
            </div>
          ) : loadError && !catalog ? (
            <div className="model-picker-state model-picker-state-err" role="alert">
              <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
              <p>{loadError}</p>
              <button
                type="button"
                className="model-picker-retry-btn"
                onClick={() => setReloadTick(v => v + 1)}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                <span>{t("retry")}</span>
              </button>
            </div>
          ) : visibleModels.length === 0 ? (
            <div className="model-picker-state" role="status">
              <p>
                {allModels.length === 0
                  ? t("emptyCatalog")
                  : !effectiveIncludeUnauth && unauthenticatedCount > 0 && !query.trim()
                    ? t("noAuthenticatedModels")
                    : t("noMatch")}
              </p>
              {(query.trim() || activeProvider !== "all") && (
                <button
                  type="button"
                  className="model-picker-retry-btn"
                  onClick={() => {
                    setQuery("");
                    setSelectedProvider("all");
                    searchInputRef.current?.focus();
                  }}
                >
                  <span>{t("clearFilters")}</span>
                </button>
              )}
            </div>
          ) : (
            visibleModels.map((item, idx) => {
              const isCurrent = item.fullId === normalizedValue;
              const isStaged = item.fullId === stagedModel;
              const isHighlighted = idx === highlightedIndex;
              const selectable = isModelSelectable(item, { disabled, allowUnauthenticated });
              const isSelecting = selectingId === item.fullId;
              const ctxLabel = formatContextWindow(item.contextWindow);

              return (
                <button
                  key={item.fullId}
                  id={`${listboxId}-opt-${idx}`}
                  ref={node => {
                    if (node) optionRefs.current.set(item.fullId, node);
                    else optionRefs.current.delete(item.fullId);
                  }}
                  type="button"
                  role="option"
                  aria-selected={isStaged}
                  aria-disabled={!selectable || Boolean(selectingId)}
                  disabled={!selectable || Boolean(selectingId)}
                  data-model-option={item.fullId}
                  data-provider={item.provider}
                  data-current={isCurrent ? "true" : undefined}
                  data-staged={isStaged ? "true" : undefined}
                  data-highlighted={isHighlighted ? "true" : undefined}
                  data-authenticated={item.authenticated ? "true" : "false"}
                  className="model-picker-item"
                  title={!item.authenticated && !allowUnauthenticated ? t("unauthenticatedHint") : item.fullId}
                  onMouseEnter={() => {
                    if (selectable) setHighlightedIndex(idx);
                  }}
                  onClick={() => stageSelection(item)}
                >
                  <div className="model-picker-item-left">
                    <div className="model-picker-item-title-row">
                      <i
                        className="model-picker-auth-dot"
                        data-authenticated={item.authenticated ? "true" : "false"}
                        aria-hidden="true"
                      />
                      <strong className="model-picker-item-name">{item.name || item.id}</strong>
                      {isCurrent && (
                        <span className="model-picker-current-badge" data-model-current-badge>
                          <Check className="size-3" aria-hidden="true" />
                          <span>{t("currentBadge")}</span>
                        </span>
                      )}
                      {!item.authenticated && (
                        <span className="model-picker-unauth-badge">{t("unauthenticatedBadge")}</span>
                      )}
                    </div>
                    <div className="model-picker-item-id-row">
                      <span className="model-picker-provider-pill">{item.provider}</span>
                      <code className="model-picker-full-id">{item.fullId}</code>
                    </div>
                  </div>

                  <div className="model-picker-item-right">
                    <span className="model-picker-cap-tag" data-cap="vision">
                      <Eye className="size-3" aria-hidden="true" />
                      <span>{t("visionBadge")}</span>
                    </span>
                    {item.reasoning && (
                      <span className="model-picker-cap-tag" data-cap="reasoning">
                        <Sparkles className="size-3" aria-hidden="true" />
                        <span>{t("reasoningBadge")}</span>
                      </span>
                    )}
                    <span className="model-picker-ctx-tag" title={`${item.contextWindow.toLocaleString()} tokens`}>
                      {ctxLabel}
                    </span>
                    {isSelecting && (
                      <Loader2 className="size-3.5 animate-spin text-primary shrink-0" aria-hidden="true" />
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {stagedModelItem && stagedModelItem.supportedServiceTiers.length > 0 && (
          <section className="model-picker-service-tier" aria-labelledby={`${listboxId}-service-tier`}>
            <div className="model-picker-service-tier-heading">
              <div>
                <h3 id={`${listboxId}-service-tier`}>{t("serviceTierTitle")}</h3>
                <p>{t("serviceTierHint")}</p>
              </div>
              <span className="model-picker-service-tier-model">{stagedModelItem.name || stagedModelItem.id}</span>
            </div>
            <div className="model-picker-service-tier-options" role="radiogroup" aria-label={t("serviceTierTitle")}>
              <button
                type="button"
                role="radio"
                aria-checked={effectiveStagedServiceTier === null}
                disabled={disabled || Boolean(selectingId)}
                data-service-tier="standard"
                className="model-picker-service-tier-option"
                onClick={() => setStagedServiceTier(null)}
              >
                <strong>{t("serviceTierStandard")}</strong>
                <span>{t("serviceTierStandardHint")}</span>
              </button>
              {stagedModelItem.supportedServiceTiers.includes("priority") && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveStagedServiceTier === "priority"}
                  disabled={disabled || Boolean(selectingId)}
                  data-service-tier="priority"
                  className="model-picker-service-tier-option"
                  onClick={() => setStagedServiceTier("priority")}
                >
                  <strong><Gauge className="size-3" aria-hidden="true" />{t("serviceTierFast")}</strong>
                  <span>{t("serviceTierFastHint")}</span>
                </button>
              )}
              {stagedModelItem.supportedServiceTiers.includes("ultrafast") && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveStagedServiceTier === "ultrafast"}
                  disabled={disabled || Boolean(selectingId)}
                  data-service-tier="ultrafast"
                  className="model-picker-service-tier-option"
                  onClick={() => setStagedServiceTier("ultrafast")}
                >
                  <strong><Rocket className="size-3" aria-hidden="true" />{t("serviceTierUltra")}</strong>
                  <span>{t("serviceTierUltraHint")}</span>
                </button>
              )}
            </div>
            <p className="model-picker-service-tier-cost">{t("serviceTierCostHint")}</p>
          </section>
        )}

        {/* Footer */}
        <footer className="model-picker-footer">
          <div className="model-picker-shortcuts" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {t("shortcutNavigate")}
            </span>
            <span>
              <kbd>↵</kbd> {t("shortcutSelect")}
            </span>
            <span>
              <kbd>Esc</kbd> {t("shortcutClose")}
            </span>
          </div>
          <div className="model-picker-footer-meta">
            <span>
              {t("modelsCount")
                .replace("{visible}", String(visibleModels.length))
                .replace("{authenticated}", String(authenticatedCount))}
            </span>
            <button
              type="button"
              className="model-picker-apply-btn"
              data-model-picker-apply
              disabled={disabled || !stagedModelItem || Boolean(selectingId)}
              onClick={() => void commitSelection()}
            >
              {selectingId && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              <span>{t(selectingId ? "applying" : "apply")}</span>
            </button>
          </div>
        </footer>
    </>
  );

  if (inline) {
    if (!open) return null;
    return (
      <div
        role="dialog"
        aria-label={t("title")}
        className="model-picker-dialog flex flex-col gap-0 p-0 sm:max-w-[640px]"
        data-model-picker-dialog
        onKeyDown={handleKeyDown}
      >
        {dialogInner}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="model-picker-dialog flex flex-col gap-0 p-0 sm:max-w-[640px]"
        data-model-picker-dialog
        onOpenAutoFocus={event => {
          event.preventDefault();
          searchInputRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={handleKeyDown}
      >
        {dialogInner}
      </DialogContent>
    </Dialog>
  );
}
