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
  ChevronDown,
  Cpu,
  Eye,
  Gauge,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "@/lib/locale";
import { useOptionalLudensRpc } from "@/lib/ludens-rpc";

export type ModelServiceTier = "priority" | "ultrafast";

export const OMP_MODEL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = (typeof OMP_MODEL_EFFORTS)[number];

export function isModelEffort(value: unknown): value is ModelEffort {
  return typeof value === "string" && (OMP_MODEL_EFFORTS as readonly string[]).includes(value);
}

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
  supportedEfforts: ModelEffort[];
  defaultEffort: ModelEffort | null;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  providers: { id: string; count: number; authenticated: boolean }[];
  currentModel?: string | null;
  currentServiceTier?: ModelServiceTier | null;
  currentEffort?: ModelEffort | null;
}

export interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null | undefined;
  serviceTier?: ModelServiceTier | null;
  effort?: ModelEffort | null;
  projectId?: string | null;
  onSelect: (
    modelFullId: string,
    serviceTier: ModelServiceTier | null,
    effort: ModelEffort | null,
  ) => Promise<void> | void;
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
    const thousands = Math.round(tokens / 1_000);
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

export function effortForModel(
  item: AvailableModelItem | null | undefined,
  effort: ModelEffort | null | undefined,
): ModelEffort | null {
  if (!effort || !item?.supportedEfforts.includes(effort)) return null;
  return effort === item.defaultEffort ? null : effort;
}

export function normalizeSelectedEffort(
  item: AvailableModelItem | null | undefined,
  chosen: ModelEffort | null | undefined,
): ModelEffort | null {
  if (!chosen || !item?.supportedEfforts.includes(chosen)) return null;
  return chosen === item.defaultEffort ? null : chosen;
}

const EFFORT_LABEL_KEYS: Record<
  ModelEffort,
  "effortMin" | "effortLow" | "effortMedium" | "effortHigh" | "effortXHigh" | "effortMax"
> = {
  minimal: "effortMin",
  low: "effortLow",
  medium: "effortMedium",
  high: "effortHigh",
  xhigh: "effortXHigh",
  max: "effortMax",
};

/**
 * Speed indicator for `Standard` (`Gauge`), `Fast` (`Zap`), and `Ultra` (`Rocket`).
 * By default renders only premium tiers (`Fast` / `Ultra`); pass `showStandard` (used in the
 * Live Composer current-model pill) so every speed — including `Standard` — displays a crisp icon.
 */
export function ServiceTierBadge({
  tier,
  iconOnly = false,
  showStandard = false,
  className,
}: {
  tier: ModelServiceTier | null | undefined;
  iconOnly?: boolean;
  showStandard?: boolean;
  className?: string;
}) {
  const t = useTranslations("modelPicker");
  if (!tier && !showStandard) return null;
  const resolved = tier ?? "standard";
  const Icon = resolved === "ultrafast" ? Rocket : resolved === "priority" ? Zap : Gauge;
  const label = t(
    resolved === "ultrafast"
      ? "serviceTierUltra"
      : resolved === "priority"
        ? "serviceTierFast"
        : "serviceTierStandard",
  );
  const hint = t(
    resolved === "ultrafast"
      ? "serviceTierUltraHint"
      : resolved === "priority"
        ? "serviceTierFastHint"
        : "serviceTierStandardHint",
  );
  return (
    <span
      className={["service-tier-badge", className].filter(Boolean).join(" ")}
      data-service-tier={resolved}
      data-icon-only={iconOnly || undefined}
      title={`${label} · ${hint}`}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}

/** Compact reasoning effort badge rendered when an explicit non-default effort is configured. */
export function ModelEffortBadge({
  effort,
  compact = false,
  className,
}: {
  effort: ModelEffort | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations("modelPicker");
  if (!effort || !isModelEffort(effort)) return null;
  const label = t(EFFORT_LABEL_KEYS[effort]);
  return (
    <span
      className={["model-effort-badge", className].filter(Boolean).join(" ")}
      data-model-effort={effort}
      data-compact={compact || undefined}
      title={t("effortTooltip").replace("{effort}", label)}
    >
      {!compact && <Sparkles className="size-2.5 shrink-0" aria-hidden="true" />}
      <span>{label}</span>
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
  effort,
  projectId,
  onSelect,
  disabled = false,
  disabledReason,
  allowUnauthenticated = false,
  catalogOverride,
  inline = false,
}: ModelPickerDialogProps) {
  const t = useTranslations("modelPicker");
  const rpcCtx = useOptionalLudensRpc();
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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
  const [stagedModel, setStagedModel] = useState<string | null>(
    () => (value?.trim() || catalogOverride?.currentModel?.trim() || "") || null,
  );
  const [stagedServiceTier, setStagedServiceTier] = useState<ModelServiceTier | null>(
    () => (serviceTier !== undefined ? serviceTier : catalogOverride?.currentServiceTier ?? null),
  );
  const [stagedEffort, setStagedEffort] = useState<ModelEffort | null>(
    () => (effort !== undefined ? effort : catalogOverride?.currentEffort ?? null),
  );

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
    if (!rpcCtx) {
      setLoadError(t("loadFailed"));
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const version = ++requestVersionRef.current;
    setLoading(true);
    setLoadError(null);
    const trimmedProject = projectId?.trim();

    void rpcCtx
      .call(
        "models/list",
        trimmedProject ? { workspaceId: trimmedProject } : undefined,
        { signal: controller.signal },
      )
      .then(payload => {
        if (controller.signal.aborted || version !== requestVersionRef.current) return;
        setFetchedCatalog(payload as unknown as AvailableModelsCatalog);
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
  }, [open, projectId, reloadTick, catalogOverride, rpcCtx, t]);

  const catalog = catalogOverride !== undefined ? catalogOverride : fetchedCatalog;
  const allModels = catalog?.models ?? [];
  const normalizedValue = (value?.trim() || catalog?.currentModel?.trim() || "") || null;
  const initialServiceTier = serviceTier !== undefined ? serviceTier : catalog?.currentServiceTier ?? null;
  const initialEffort = effort !== undefined ? effort : catalog?.currentEffort ?? null;

  useEffect(() => {
    if (!open) return;
    setStagedModel(normalizedValue);
    setStagedServiceTier(initialServiceTier);
    setStagedEffort(initialEffort);
  }, [open, normalizedValue, initialServiceTier, initialEffort]);

  const currentModelItem = allModels.find(item => item.fullId === normalizedValue);
  const stagedModelItem = allModels.find(item => item.fullId === stagedModel);
  const effectiveInitialServiceTier = serviceTierForModel(currentModelItem, initialServiceTier);
  const effectiveInitialEffort = effortForModel(currentModelItem, initialEffort);
  const effectiveStagedServiceTier = serviceTierForModel(stagedModelItem, stagedServiceTier);
  const effectiveStagedEffort = effortForModel(stagedModelItem, stagedEffort);

  useEffect(() => {
    if (!open || !stagedModel) return;
    const node = cardRefs.current.get(stagedModel);
    if (!node) return;
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "nearest" });
    }) : 0;
    return () => {
      if (typeof window !== "undefined" && raf) window.cancelAnimationFrame(raf);
    };
  }, [open, stagedModel]);

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

  const stageSelection = useCallback(
    (item: AvailableModelItem) => {
      if (selectingId || !isModelSelectable(item, { disabled, allowUnauthenticated })) return;
      setSelectError(null);
      setStagedModel(item.fullId);
      setStagedServiceTier(current => serviceTierForModel(item, current));
      setStagedEffort(current => effortForModel(item, current));
    },
    [selectingId, disabled, allowUnauthenticated],
  );

  const commitItem = useCallback(
    async (
      item: AvailableModelItem | undefined,
      nextTier: ModelServiceTier | null,
      nextEffort: ModelEffort | null,
    ) => {
      if (!item || selectingId || !isModelSelectable(item, { disabled, allowUnauthenticated })) return;
      setSelectError(null);
      setSelectingId(item.fullId);
      try {
        await onSelect(item.fullId, nextTier, nextEffort);
        onOpenChange(false);
      } catch (error) {
        setSelectError(error instanceof Error ? error.message : String(error));
      } finally {
        setSelectingId(null);
      }
    },
    [selectingId, disabled, allowUnauthenticated, onSelect, onOpenChange],
  );

  const commitSelection = useCallback(
    () => commitItem(stagedModelItem, effectiveStagedServiceTier, effectiveStagedEffort),
    [commitItem, stagedModelItem, effectiveStagedServiceTier, effectiveStagedEffort],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const targetEl = event.target as HTMLElement;
    if (
      targetEl.closest(
        "[data-service-tier], [data-effort-option], [data-model-picker-apply]",
      )
    ) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = stepHighlightedIndex(highlightedIndex, visibleModels, 1, {
        disabled,
        allowUnauthenticated,
      });
      setHighlightedIndex(next);
      const nextItem = next >= 0 ? visibleModels[next] : undefined;
      if (nextItem) {
        cardRefs.current.get(nextItem.fullId)?.scrollIntoView({ block: "nearest" });
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
        cardRefs.current.get(prevItem.fullId)?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter") {
      const target = highlightedIndex >= 0 ? visibleModels[highlightedIndex] : undefined;
      if (target && isModelSelectable(target, { disabled, allowUnauthenticated })) {
        event.preventDefault();
        if (target.fullId === stagedModel) {
          void commitSelection();
        } else {
          stageSelection(target);
        }
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
            const isExpanded = isStaged && selectable;
            const isSelecting = selectingId === item.fullId;
            const ctxLabel = formatContextWindow(item.contextWindow);

            const resolvedDisplayEffort =
              effectiveStagedEffort ?? item.defaultEffort ?? null;
            const effortSummaryLabel = resolvedDisplayEffort
              ? `${t(EFFORT_LABEL_KEYS[resolvedDisplayEffort])}${
                  effectiveStagedEffort === null ? ` (${t("effortDefaultTag")})` : ""
                }`
              : t("effortFixedHint");
            const speedSummaryLabel =
              effectiveStagedServiceTier === "ultrafast"
                ? t("serviceTierUltra")
                : effectiveStagedServiceTier === "priority"
                  ? t("serviceTierFast")
                  : t("serviceTierStandard");
            const isUnchangedCurrent =
              isCurrent &&
              effectiveStagedServiceTier === effectiveInitialServiceTier &&
              effectiveStagedEffort === effectiveInitialEffort;

            return (
              <div
                key={item.fullId}
                ref={node => {
                  if (node) cardRefs.current.set(item.fullId, node);
                  else cardRefs.current.delete(item.fullId);
                }}
                className="model-picker-card"
                data-model-card={item.fullId}
                data-expanded={isExpanded ? "true" : undefined}
                data-current={isCurrent ? "true" : undefined}
              >
                <button
                  id={`${listboxId}-opt-${idx}`}
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
                  onDoubleClick={() => {
                    if (!selectable) return;
                    const nextTier = serviceTierForModel(item, stagedServiceTier);
                    const nextEffort = effortForModel(item, stagedEffort);
                    void commitItem(item, nextTier, nextEffort);
                  }}
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
                      {isCurrent && !isExpanded && effectiveInitialEffort && (
                        <ModelEffortBadge effort={effectiveInitialEffort} compact />
                      )}
                      {isCurrent && !isExpanded && (
                        <ServiceTierBadge tier={effectiveInitialServiceTier} iconOnly showStandard />
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
                    {selectable && (
                      <ChevronDown
                        className={
                          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150" +
                          (isExpanded ? " rotate-180 text-foreground" : " opacity-60")
                        }
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div
                    className="model-picker-inline-drawer"
                    data-model-inline-options={item.fullId}
                  >
                    <div className="model-picker-inline-controls">
                      {/* Effort Row */}
                      <div className="model-picker-inline-row" data-inline-row="effort">
                        <span className="model-picker-inline-label">
                          <Sparkles className="size-3" aria-hidden="true" />
                          <span>{t("effortTitle")}</span>
                        </span>
                        {item.supportedEfforts.length > 0 ? (
                          <div
                            className="model-picker-seg-group"
                            role="radiogroup"
                            aria-label={t("effortTitle")}
                          >
                            {item.supportedEfforts.map(level => {
                              const isDefault = item.defaultEffort === level;
                              const isChecked = resolvedDisplayEffort === level;
                              const levelLabel = t(EFFORT_LABEL_KEYS[level]);
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  role="radio"
                                  aria-checked={isChecked}
                                  disabled={Boolean(selectingId)}
                                  data-effort-option={level}
                                  data-default-effort={isDefault ? "true" : undefined}
                                  title={
                                    isDefault
                                      ? `${levelLabel} (${t("effortDefaultTag")})`
                                      : levelLabel
                                  }
                                  className="model-picker-seg-pill"
                                  onClick={() =>
                                    setStagedEffort(normalizeSelectedEffort(item, level))
                                  }
                                >
                                  <span>{levelLabel}</span>
                                  {isDefault && (
                                    <i
                                      className="model-picker-default-dot"
                                      aria-hidden="true"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="model-picker-inline-muted">
                            {t("effortFixedHint")}
                          </span>
                        )}
                      </div>

                      {/* Speed Row */}
                      <div className="model-picker-inline-row" data-inline-row="speed">
                        <span className="model-picker-inline-label">
                          <Zap className="size-3" aria-hidden="true" />
                          <span>{t("speedTitle")}</span>
                        </span>
                        <div className="model-picker-inline-speed-wrap">
                          <div
                            className="model-picker-seg-group"
                            role="radiogroup"
                            aria-label={t("speedTitle")}
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-checked={effectiveStagedServiceTier === null}
                              disabled={Boolean(selectingId)}
                              data-service-tier="standard"
                              title={t("serviceTierStandardHint")}
                              className="model-picker-seg-pill"
                              onClick={() => setStagedServiceTier(null)}
                            >
                              <Gauge className="size-3 shrink-0" aria-hidden="true" />
                              <span>{t("serviceTierStandard")}</span>
                            </button>
                            {item.supportedServiceTiers.includes("priority") && (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={effectiveStagedServiceTier === "priority"}
                                disabled={Boolean(selectingId)}
                                data-service-tier="priority"
                                title={t("serviceTierFastHint")}
                                className="model-picker-seg-pill"
                                onClick={() => setStagedServiceTier("priority")}
                              >
                                <Zap className="size-3 shrink-0" aria-hidden="true" />
                                <span>{t("serviceTierFast")}</span>
                              </button>
                            )}
                            {item.supportedServiceTiers.includes("ultrafast") && (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={effectiveStagedServiceTier === "ultrafast"}
                                disabled={Boolean(selectingId)}
                                data-service-tier="ultrafast"
                                title={t("serviceTierUltraHint")}
                                className="model-picker-seg-pill"
                                onClick={() => setStagedServiceTier("ultrafast")}
                              >
                                <Rocket className="size-3 shrink-0" aria-hidden="true" />
                                <span>{t("serviceTierUltra")}</span>
                              </button>
                            )}
                          </div>
                          {item.supportedServiceTiers.length === 0 && (
                            <span className="model-picker-inline-muted">
                              {t("speedStandardOnlyHint")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Contextual summary + inline Apply button */}
                    <div className="model-picker-inline-footer">
                      <span
                        className="model-picker-inline-cost"
                        data-premium={effectiveStagedServiceTier ? "true" : undefined}
                      >
                        {effectiveStagedServiceTier
                          ? t("serviceTierCostHint")
                          : t("inlineSummary")
                              .replace("{effort}", effortSummaryLabel)
                              .replace("{speed}", speedSummaryLabel)}
                      </span>
                      <button
                        type="button"
                        className="model-picker-inline-apply"
                        data-model-picker-apply
                        data-unchanged={isUnchangedCurrent ? "true" : undefined}
                        disabled={Boolean(selectingId)}
                        onClick={() => void commitSelection()}
                      >
                        {isSelecting ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            <span>{t("applying")}</span>
                          </>
                        ) : isUnchangedCurrent ? (
                          <>
                            <Check className="size-3.5" aria-hidden="true" />
                            <span>{t("activeUnchangedBtn")}</span>
                            <kbd>↵</kbd>
                          </>
                        ) : (
                          <>
                            <span>{t(isCurrent ? "applyChangesBtn" : "switchModelBtn")}</span>
                            <kbd>↵</kbd>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

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
        className="model-picker-dialog flex flex-col gap-0 p-0 sm:max-w-[660px]"
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
        className="model-picker-dialog flex flex-col gap-0 p-0 sm:max-w-[660px]"
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
