"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { LocateFixed, Search, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readArchiveJson } from "@/lib/archive-client";
import type { ReplayItem, ReplaySearchResult, ReplayTrack } from "@/lib/replay-types";
import { useTranslations } from "@/lib/locale";
import { replayElapsedInput } from "@/features/replay/replay-navigation";
import { replayItemActive } from "@/features/replay/replay-model";
import { useRetryFocus } from "@/components/use-retry-focus";
import { prefersSmoothScrollBehavior } from "@/components/use-motion-preferences";

type Track = "all" | ReplayTrack;
interface SearchState {
  query: string; track: Track; items: ReplayItem[]; loading: boolean; error: string;
  cursor?: string; scan?: ReplaySearchResult["scan"]; coverage?: ReplaySearchResult["coverage"];
  stopped: boolean; page: number;
}

const TRACK_OPTIONS: readonly Track[] = ["all", "action", "model", "tool", "log"];

const wallClockShort = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Automatically scan bounded server pages, stopping at one readable result batch. */
export function ReplayEventSearch({ scope, startAt, at, refreshRevision = 0, itemUrl, onSelect, selectedId, inputId, inputRef }: {
  scope: string; startAt: number; at?: number; refreshRevision?: number; itemUrl(item: ReplayItem): string;
  onSelect(item: ReplayItem, trigger: HTMLElement): void; selectedId?: string;
  inputId: string; inputRef: Ref<HTMLInputElement>;
}) {
  const t = useTranslations("replayNavigation"), timeline = useTranslations("timelinePlayer");
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState<Track>("all");
  const [state, setState] = useState<SearchState | null>(null);
  const focus = useRetryFocus(!!state?.loading, state?.error);
  const current = useRef<SearchState | null>(null);
  const request = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const update = useCallback((next: SearchState) => { current.current = next; setState(next); }, []);

  const scrollClosestItemIntoView = useCallback((targetAt: number, items: ReplayItem[]) => {
    if (!items.length) return;
    let best = items[0];
    let bestDist = Math.abs(best.startAt - targetAt);
    for (const item of items) {
      const dist = replayItemActive(item, targetAt) ? 0 : Math.abs(item.startAt - targetAt);
      if (dist < bestDist) {
        best = item;
        bestDist = dist;
      }
    }
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-replay-item="${CSS.escape(best.id)}"]`);
      el?.scrollIntoView({ block: "center", behavior: prefersSmoothScrollBehavior() });
    });
  }, []);

  const scan = useCallback(async (initial: SearchState, targetAt?: number) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    let next = { ...initial, loading: true, stopped: false, error: "" };
    update(next);
    const cursors = new Set<string>();
    let pagesScanned = 0;
    try {
      for (;;) {
        const params = new URLSearchParams(scope);
        params.set("mode", "search"); params.set("q", next.query); params.set("track", next.track);
        if (next.cursor) {
          if (cursors.has(next.cursor)) throw new Error(timeline("paginationStalled"));
          cursors.add(next.cursor); params.set("cursor", next.cursor);
        }
        const page = await readArchiveJson<ReplaySearchResult>(`/api/replay?${params}`, controller.signal);
        if (controller.signal.aborted || request.current !== controller) return;
        pagesScanned += 1;
        const mergedItems = [...new Map([...next.items, ...page.items].map(item => [item.id, item])).values()];
        const items = targetAt !== undefined && mergedItems.length > 200 ? mergedItems.slice(-200) : mergedItems;
        next = { ...next, items, cursor: page.nextCursor, scan: page.scan, coverage: page.coverage };
        const reachedTarget =
          targetAt !== undefined
            ? (items.some(item => item.startAt >= targetAt) || pagesScanned >= 25)
            : items.length >= 100;
        const finished = !next.cursor || reachedTarget;
        update({ ...next, loading: !finished });
        if (finished) {
          if (targetAt !== undefined) scrollClosestItemIntoView(targetAt, items);
          return;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller) update({ ...next, loading: false,
        error: error instanceof Error ? error.message : String(error) });
    } finally { if (request.current === controller) request.current = null; }
  }, [scope, timeline, update, scrollClosestItemIntoView]);

  // Auto-load event stream on mount and when scope, refresh, or track filter changes; debounce text input.
  useEffect(() => {
    const trimmed = query.trim();
    const immediate = !current.current || current.current.track !== track || trimmed === "";
    if (immediate) {
      void scan({ query: trimmed, track, items: [], loading: true, error: "", stopped: false, page: 1 });
      return () => {
        request.current?.abort();
      };
    }
    debounceTimer.current = setTimeout(() => {
      void scan({ query: trimmed, track, items: [], loading: true, error: "", stopped: false, page: 1 });
    }, 220);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [scope, refreshRevision, track, query, scan]);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    request.current?.abort();
  }, [scope]);

  const run = () => void scan({ query: query.trim(), track, items: [], loading: true, error: "", stopped: false, page: 1 });
  const stop = () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    request.current?.abort(); request.current = null;
    if (current.current) update({ ...current.current, loading: false, stopped: true });
  };
  const changeQuery = (value: string) => { if (request.current) stop(); setQuery(value); };
  const changed = !!state && (state.query !== query.trim() || state.track !== track);
  const progress = state?.scan ? Math.min(100, Math.floor(state.scan.throughPosition / Math.max(1, state.scan.totalPositions) * 100)) : 0;
  const complete = !!state?.scan?.complete && !!state.coverage?.complete;
  const follow = (event: MouseEvent<HTMLAnchorElement>, item: ReplayItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); onSelect(item, event.currentTarget);
  };
  const isItemAtPlayhead = (item: ReplayItem) => {
    if (at === undefined) return false;
    if (item.track !== "log") return replayItemActive(item, at);
    return Math.abs(item.startAt - at) <= 1200;
  };

  const compactCountTemplate = t("compactCount");
  const countToken = state ? `${state.items.length}${state.cursor ? "+" : ""}` : "0";
  const compactCountLabel = compactCountTemplate.includes("{count}")
    ? compactCountTemplate.replace("{count}", countToken)
    : countToken;
  const fullStatusTitle = state
    ? state.loading
      ? t("searching").replace("{percent}", String(progress))
      : `${t("resultCount").replace("{count}", String(state.items.length)).replace("{page}", String(state.page))} · ${
          state.stopped ? t("searchStopped") : state.error ? t("searchFailed") : complete ? t("searchComplete") : state.cursor ? t("moreMatches") : t("searchPartial")
        }`
    : undefined;

  return <section className="replay-event-search" aria-label={t("eventSearchTitle")}>
    <form className="replay-search-form" onSubmit={event => { event.preventDefault(); run(); }}>
      <div className="replay-search-row-top">
        <Label htmlFor={inputId} className="sr-only">{t("searchLabel")}</Label>
        <div className="replay-search-input-wrap">
          <Search className="replay-search-icon" aria-hidden="true" />
          <Input
            id={inputId}
            ref={inputRef}
            value={query}
            maxLength={200}
            className="replay-search-input h-7 pl-7 pr-6 text-xs"
            placeholder={t("searchPlaceholder")}
            onChange={event => changeQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="replay-search-clear" aria-label={t("clearSearch")} onClick={() => changeQuery("")}>
              <X className="size-3" aria-hidden="true" />
            </button>
          )}
        </div>
        {state && !state.loading && at !== undefined && (state.items.length > 0 || Boolean(state.cursor)) && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="replay-locate-btn h-7 px-2"
            title={t("locatePlayhead")}
            aria-label={t("locatePlayhead")}
            onClick={() => {
              const lastStart = state.items.at(-1)?.startAt ?? -Infinity;
              const firstStart = state.items[0]?.startAt ?? Infinity;
              if (at >= firstStart - 1500 && (at <= lastStart + 1500 || !state.cursor)) {
                scrollClosestItemIntoView(at, state.items);
              } else if (at < firstStart) {
                void scan({ query: query.trim(), track, items: [], loading: true, error: "", stopped: false, page: 1 }, at);
              } else if (state.cursor) {
                void scan({ ...state, page: state.page + 1 }, at);
              }
            }}
          >
            <LocateFixed className="size-3.5" aria-hidden="true" />
            <span className="replay-locate-label">{t("locatePlayhead")}</span>
          </Button>
        )}
        {state?.loading && (
          <Button type="button" size="xs" variant="ghost" className="h-7 px-2" onClick={stop}>
            {t("stopSearch")}
          </Button>
        )}
        {state && !changed && (state.stopped || state.error) && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 px-2"
            onClick={event => { focus.remember(event.currentTarget); void scan(state); }}
          >
            {t("continueSearch")}
          </Button>
        )}
      </div>

      <div className="replay-search-row-bottom">
        <div className="replay-track-pills" role="group" aria-label={t("trackFilter")}>
          {TRACK_OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              className="replay-track-pill"
              data-active={track === option ? "true" : undefined}
              data-track={option}
              onClick={() => {
                if (track === option) return;
                if (request.current) stop();
                setTrack(option);
              }}
            >
              {option === "all" ? t("allTracks") : timeline(`track.${option}`)}
            </button>
          ))}
        </div>

        {state && (
          <div ref={focus.target} tabIndex={-1} className="replay-search-meta-bar outline-none" role="status" title={fullStatusTitle}>
            <span className="replay-search-meta-text mono">
              {state.loading ? `${progress}%` : compactCountLabel}
            </span>
            {!changed && !state.loading && !state.stopped && !state.error && state.cursor && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-5 px-1.5 text-[11px]"
                onClick={event => { focus.remember(event.currentTarget); void scan({ ...state, items: [], page: state.page + 1 }); }}
              >
                {t("nextResults")}
              </Button>
            )}
          </div>
        )}
      </div>
    </form>

    {state && <>
      {state.error && <Alert variant="destructive"><AlertDescription>
        <p>{t("searchFailed")}</p>
        <details className="mt-2 text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{state.error}</p></details>
        <Button type="button" variant="outline" size="xs" className="mt-2"
          onClick={event => { focus.remember(event.currentTarget); void scan({ ...state, items: [], cursor: undefined, scan: undefined, coverage: undefined, page: 1 }); }}>
          {t("restartSearch")}
        </Button>
      </AlertDescription></Alert>}

      {!state.items.length && !state.loading && !state.error && !state.stopped && (
        <p className="replay-search-empty">{t(complete ? "noResults" : "noResultsYet")}</p>
      )}

      <ol ref={listRef} className="replay-search-results">
        {state.items.map(item => {
          const activeNow = isItemAtPlayhead(item);
          const mappedStatus = item.status && ["completed","failed","cancelled","running","success","error","pending"].includes(item.status)
            ? timeline(`status.${({success:"completed",error:"failed",pending:"pending"} as Record<string,string>)[item.status] ?? item.status}`)
            : item.status;
          return (
            <li key={item.id}>
              <a
                href={itemUrl(item)}
                onClick={event => follow(event, item)}
                aria-current={item.id === selectedId ? "true" : undefined}
                data-active={activeNow ? "true" : undefined}
                data-replay-item={item.id}
              >
                <div className="replay-search-result-meta">
                  <span className={`replay-track-badge ${item.track}`}>{timeline(`track.${item.track}`)}</span>
                  <time className="font-mono tabular-nums">{replayElapsedInput(item.startAt - startAt, "seconds")}</time>
                  <span className="replay-search-walltime mono">{wallClockShort(item.startAt)}</span>
                  {mappedStatus && (
                    <span className={`replay-search-result-status ${/error|failed/.test(item.status ?? "") ? "failed" : ""}`}>
                      {mappedStatus}
                    </span>
                  )}
                </div>
                <p className="replay-search-result-label">{item.label}</p>
              </a>
            </li>
          );
        })}
      </ol>
    </>}
  </section>;
}
