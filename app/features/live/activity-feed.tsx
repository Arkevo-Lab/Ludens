"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LogBlock } from "@/lib/activity";
import {
  activityContentView,
  activityProvenance,
  matchesActivity,
  printable,
  type ActivityFilter,
} from "@/features/live/activity-feed-model";
import type { ActivityFeedData } from "@/features/live/use-activity-feed";
import { useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "@/features/live/activity-feed.css";

interface ActivityFeedProps {
  feed: ActivityFeedData;
  expectedEpoch?: string | null;
  selectedBlock?: string;
  onSelect?: (block: LogBlock) => void;
  composer?: ReactNode;
}

const filters: ActivityFilter[] = [
  "all",
  "thinking",
  "text",
  "tool",
  "system",
  "diagnostic",
];
const sourceNames: Record<string, string> = {
  shiori: "Shiori",
  ludens: "Ludens",
  baseware: "Baseware",
  pet: "Ludens Pet",
  dashboard: "Dashboard",
};

function BlockIcon({ kind }: { kind: LogBlock["kind"] }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "thinking" ? (
        <>
          <path d="M9 18H7a4 4 0 0 1-1-7.9A5 5 0 0 1 15 6a4 4 0 0 1 3.9 6A3.5 3.5 0 0 1 18 19h-3" />
          <path d="M10 9c-2 0-2 4 0 4v7m4-12c2 0 2 5 0 5v7m-5-5h6" />
        </>
      ) : kind === "tool" ? (
        <path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z" />
      ) : kind === "system" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 3 3 5-6" />
        </>
      ) : kind === "diagnostic" ? (
        <>
          <path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-15-2 16" />
        </>
      ) : (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6m-6 4h6m-6 4h4" />
        </>
      )}
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useTranslations("activityFeed");
  const [feedback, setFeedback] = useState<{ text: string; status: "pending" | "done" | "error" } | null>(null);
  const attempt = useRef(0);
  const pending = useRef(false);
  const status = feedback?.text === text ? feedback.status : "idle";
  useLayoutEffect(() => {
    // A new streamed value owns its own feedback; old clipboard promises may still settle.
    pending.current = false;
    attempt.current += 1;
    setFeedback(null);
    return () => { attempt.current += 1; };
  }, [text]);
  useEffect(() => {
    if (status !== "done" && status !== "error") return;
    const timer = window.setTimeout(() => setFeedback(null), 1800);
    return () => window.clearTimeout(timer);
  }, [status, text]);
  return (
    <div className="block-copy-action">
      <Button type="button" variant="ghost" size="xs" className="block-copy-button"
        data-activity-copy aria-label={t("copyAria")} aria-disabled={status === "pending"}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          const current = ++attempt.current;
          setFeedback({ text, status: "pending" });
          try {
            await navigator.clipboard.writeText(text);
            if (attempt.current === current) setFeedback({ text, status: "done" });
          } catch {
            if (attempt.current === current) setFeedback({ text, status: "error" });
          } finally {
            if (attempt.current === current) pending.current = false;
          }
        }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" />
        </svg>
        {t("copyLabel")}
      </Button>
      <span className={`block-copy-feedback${status === "error" ? " block-copy-error" : ""}`}
        role="status" aria-atomic="true" data-activity-copy-status={status}>
        {status === "pending" ? t("copyPending") : status === "done" ? t("copyDone") : status === "error" ? t("copyFailed") : ""}
      </span>
    </div>
  );
}

function Content({ text, code = false }: { text: string; code?: boolean }) {
  const t = useTranslations("activityFeed");
  const [requestedExpanded, setExpanded] = useState(false);
  const { canExpand, expanded, text: visibleText, characters } = activityContentView(text, requestedExpanded);
  return (
    <div className={`block-content${code ? " block-code" : ""}`} data-activity-content>
      {canExpand ? (
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary data-activity-expand>
            {expanded ? t("collapseLabel") : t("expandLabel")}
            <span>{characters.toLocaleString()}{t("charsUnit")}</span>
          </summary>
          {expanded && <pre className="block-body block-full" tabIndex={0} role="region" aria-label={t("fullContentLabel")}>{visibleText}</pre>}
        </details>
      ) : null}
      {!expanded && <pre className="block-body">{visibleText}{canExpand ? "…" : ""}</pre>}
    </div>
  );
}

const provenanceLabels: Record<string, string> = {
  id: "id", at: "at", updatedAt: "updatedAt", eventId: "eventId", seq: "seq",
  "source.component": "sourceComponent", "source.implementation": "sourceImplementation",
  "source.implementationVersion": "sourceVersion", "trace.modelCallId": "modelCallId",
  "trace.toolCallId": "toolCallId", "trace.actionId": "actionId", "trace.traceId": "traceId",
  "trace.spanId": "spanId", "trace.parentSpanId": "parentSpanId", "trace.epoch": "epoch",
};

function extractToolSummary(block: LogBlock): { badge: string; detail: string; kind: "bash" | "file" | "observe" | "capability" | "generic" } | null {
  if (block.kind !== "tool") return null;
  const rawArgs = block.tool?.args;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : null;
  const name = block.title;
  if (name === "bash") {
    const cmd = typeof args?.command === "string" ? args.command : typeof rawArgs === "string" ? rawArgs : "";
    return { badge: "$ bash", detail: cmd.split("\n")[0]?.slice(0, 120) || "shell command", kind: "bash" };
  }
  if (name === "edit" || name === "write" || name === "read") {
    const filePath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
    return { badge: name.toUpperCase(), detail: filePath || name, kind: "file" };
  }
  if (name === "observe") {
    const cap = typeof args?.capability === "string" ? args.capability : "*";
    const limit = typeof args?.limit === "number" ? ` · limit=${args.limit}` : "";
    return { badge: "👁 observe", detail: `${cap}${limit}`, kind: "observe" };
  }
  if (name === "event_pool") {
    const act = typeof args?.action === "string" ? args.action : "pool";
    const detailText =
      typeof args?.title === "string" && args.title.trim()
        ? ` · ${args.title.trim()}`
        : typeof args?.text === "string" && args.text.trim()
          ? ` · ${args.text.trim().replace(/\s+/g, " ").slice(0, 64)}`
          : "";
    return { badge: "📬 event_pool", detail: `${act}${detailText}`, kind: "generic" };
  }
  if (name === "wait") {
    const sec = typeof args?.seconds === "number" ? `${args.seconds}s` : typeof args?.ms === "number" ? `${args.ms}ms` : "";
    return { badge: "⏱ wait", detail: sec || "pause", kind: "generic" };
  }
  if (name.startsWith("python/") || name.startsWith("controller/")) {
    return { badge: "⚡ capability", detail: name, kind: "capability" };
  }
  return null;
}

function extractUserPrompt(block: LogBlock): { text: string; mode: string } | null {
  if (block.title === "user_message" || block.data?.role === "user") {
    const text = typeof block.data?.text === "string" ? block.data.text : block.text;
    const mode = typeof block.data?.mode === "string" ? block.data.mode : "start";
    return { text, mode };
  }
  if (block.data?.role === "shiori_event") {
    const text = typeof block.data?.text === "string" ? block.data.text : block.text;
    const mode = typeof block.data?.mode === "string" ? block.data.mode : "help_request";
    return { text, mode };
  }
  return null;
}

function extractSystemSummary(block: LogBlock): string | null {
  if (block.kind !== "system") return null;
  const data = block.data;
  if (block.title === "control" && data) {
    const mode = typeof data.mode === "string" ? data.mode.toUpperCase() : "CONTROL";
    const reason = typeof data.reason === "string" ? ` · ${data.reason}` : "";
    return `Control → ${mode}${reason}`;
  }
  if (block.title === "consolidation_start") return "Memory & Skill Consolidation started";
  if (block.title === "consolidation_end") {
    const outcome = typeof data?.outcome === "string" ? data.outcome : "done";
    return `Memory & Skill Consolidation (${outcome})`;
  }
  if (block.title.includes("compaction")) {
    const tokens = typeof data?.tokensBefore === "number" ? ` · ${data.tokensBefore.toLocaleString()} tokens` : "";
    return `${block.title.replaceAll("_", " ")}${tokens}`;
  }
  if (block.title === "pool_receipt" || data?.role === "pool_receipt") {
    const actor = data?.actor === "human" ? "human" : "shiori";
    const events = Array.isArray(data?.events) ? data.events : [];
    const seqs = events
      .map(item => (item && typeof item === "object" ? (item as { seq?: unknown }).seq : undefined))
      .filter((seq): seq is number => typeof seq === "number")
      .map(seq => `#${seq}`);
    const idCount = Array.isArray(data?.ids) ? data.ids.length : events.length;
    const target = seqs.length > 0 ? seqs.join(", ") : `${idCount} event${idCount === 1 ? "" : "s"}`;
    return actor === "human" ? `✓ Event Pool · human handled ${target}` : `📨 Event Pool · Shiori read ${target}`;
  }
  return null;
}

function ActivityBlock({
  block,
  selected,
  onSelect,
}: {
  block: LogBlock;
  selected: boolean;
  onSelect?: (block: LogBlock) => void;
}) {
  const t = useTranslations("activityFeed");
  const source = block.source?.component;
  const sourceName = source ? (sourceNames[source] ?? source) : t("sourceUnknown");
  const provenance = activityProvenance(block);
  const time = new Date(block.at);
  const at = Number.isNaN(time.getTime())
    ? block.at
    : time.toLocaleTimeString("zh-CN", { hour12: false });
  const toolSummary = extractToolSummary(block);
  const userPrompt = extractUserPrompt(block);
  const systemSummary = extractSystemSummary(block);
  return (
    <article
      className={`block-item block-${block.kind}${userPrompt ? " block-user-turn" : ""}${selected ? " block-selected" : ""}${block.status === "error" ? " block-error" : ""}`}
      aria-label={`${t(`kind.${block.kind}`)}: ${block.title}`}
      data-activity-block={block.id}
      data-user-mode={userPrompt?.mode}
    >
      <div className="block-main">
        <div className="block-heading">
          <div className="block-icon"><BlockIcon kind={block.kind} /></div>
          <span className="block-source" title={source}>
            {sourceName}
          </span>
          <Badge variant="secondary" className="rounded px-1.5 py-0 text-[11px]">{t(`kind.${block.kind}`)}</Badge>
          {userPrompt && (
            <span className="codex-user-badge" data-mode={userPrompt.mode}>
              {userPrompt.mode === "steer"
                ? "⚡ STEER"
                : userPrompt.mode === "event"
                  ? "📥 EVENT POOL"
                  : userPrompt.mode === "help_request"
                    ? "🆘 HELP REQUEST"
                    : userPrompt.mode === "notice"
                      ? "📌 NOTICE"
                      : "▶ PROMPT"}
            </span>
          )}
          {toolSummary && (
            <span className="codex-tool-pill" data-tool-kind={toolSummary.kind}>
              <b>{toolSummary.badge}</b>
              <code>{toolSummary.detail}</code>
            </span>
          )}
          {systemSummary && !userPrompt && (
            <span className="codex-system-pill">{systemSummary}</span>
          )}
          <time dateTime={block.at} title={block.at}>
            {at}
          </time>
          <Badge variant={block.status === "error" ? "destructive" : "outline"}
            className={`ml-auto px-1.5 py-0 text-[10px]${block.status === "running" ? " border-primary/40 text-primary" : ""}`}>
            {block.outcome === "raised" ? t("outcomeRaised") : block.outcome === "unmet" ? t("outcomeUnmet") : t(`status.${block.status}`)}
          </Badge>
        </div>
        <div className="block-title-row">
          {onSelect ? (
            <button
              type="button"
              className="block-title rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(block)}
              title={t("locateTitle")}
            >
              {block.title}
            </button>
          ) : (
            <span className="block-title">{block.title}</span>
          )}
        </div>
        {userPrompt && userPrompt.text !== block.text && (
          <p className="codex-user-prompt-text">{userPrompt.text}</p>
        )}
        {block.kind === "tool" && block.tool ? (
          <div className="block-tool-fields">
            {block.tool.intent && (
              <section className="block-field">
                <h4>{t("intentHeading")}</h4>
                <Content text={block.tool.intent} />
              </section>
            )}
            {block.tool.args !== undefined && (
              <section className="block-field">
                <h4>{t("argsHeading")}</h4>
                <Content text={printable(block.tool.args)} code />
              </section>
            )}
            {block.tool.result !== undefined ? (
              <section className="block-field">
                <h4>{t("resultHeading")}</h4>
                <Content text={printable(block.tool.result)} code />
              </section>
            ) : block.status === "running" ? (
              <p className="block-pending">{t("pendingResult")}</p>
            ) : null}
          </div>
        ) : (
          <Content text={block.text} code={block.kind === "diagnostic"} />
        )}
        <div className="block-actions"><CopyButton text={block.text} /></div>
        <details className="block-provenance" data-activity-provenance>
          <summary>{t("provenanceTitle")}</summary>
          <dl>
            {provenance.map(({ field, value }) => (
              <div className="block-provenance-row" key={field} data-activity-source={field}>
                <dt title={field}>{provenanceLabels[field] ? t(`provenance.${provenanceLabels[field]}`) : field}</dt>
                <dd>{value === "" ? '\"\"' : value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </article>
  );
}

export function ActivityFeed({ feed, expectedEpoch, selectedBlock, onSelect, composer }: ActivityFeedProps) {
  const { filter, query, setFilter, setQuery } = feed;
  const t = useTranslations("activityFeed");
  const consistent = expectedEpoch === undefined || feed.scope?.epoch === expectedEpoch;
  const page = consistent ? feed.blocks.filter(block => matchesActivity(block, filter, query)) : [];
  const selected = consistent ? page.find(block => block.id === selectedBlock) ?? feed.selected : undefined;
  const pinned = selected && !page.some(block => block.id === selected.id) ? selected : undefined;
  const loading = feed.loading;
  const missingSelection = Boolean(selectedBlock && feed.selectionReady && !selected && consistent && !feed.error);
  const list = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const initiallyPositioned = useRef(false);
  const positionLatest = useRef(false);
  const previousAnchor = useRef<{ id: string; top: number } | null>(null);
  const selectionPresent = Boolean(selected);
  const positionedRevision = useRef(feed.resetRevision);
  useLayoutEffect(() => {
    if (positionedRevision.current === feed.resetRevision) return;
    positionedRevision.current = feed.resetRevision;
    initiallyPositioned.current = false;
    previousAnchor.current = null;
    positionLatest.current = true;
  }, [feed.resetRevision]);
  useEffect(() => {
    if (selectedBlock && selectionPresent)
      nodes.current.get(selectedBlock)?.scrollIntoView({ block: "nearest" });
  }, [selectedBlock, selectionPresent]);
  useLayoutEffect(() => {
    if (loading || feed.loadingOlder) return;
    const anchor = previousAnchor.current;
    if (anchor && list.current) {
      const node = nodes.current.get(anchor.id);
      if (node) list.current.scrollTop += node.getBoundingClientRect().top - anchor.top;
      previousAnchor.current = null;
    }
    if (positionLatest.current || (!initiallyPositioned.current && page.length > 0 && !selectedBlock)) {
      list.current?.scrollTo({ top: list.current.scrollHeight });
      initiallyPositioned.current = true;
      positionLatest.current = false;
    }
  }, [feed.blocks, feed.loadingOlder, loading, page.length, selectedBlock]);
  const renderBlock = (block: LogBlock) => (
    <div key={block.id} ref={(node) => {
      if (node) nodes.current.set(block.id, node);
      else nodes.current.delete(block.id);
    }}>
      <ActivityBlock block={block} selected={block.id === selectedBlock} onSelect={onSelect} />
    </div>
  );
  return (
    <section className="feed-panel" aria-label={t("panelLabel")}>
      <header className="feed-heading">
        <h2>{t("feedTitle")}</h2>
        <span title={t("totalTitle")}>
          {loading ? t("loadingLabel") : `${feed.total.toLocaleString()}${t("itemsUnit")}`}
        </span>
      </header>
      <div className="feed-filters" role="group" aria-label={t("filtersLabel")}>
        {filters.map((kind) => (
          <Button type="button" key={kind} size="xs" variant={filter === kind ? "default" : "outline"}
            className={kind === "diagnostic" && filter !== kind ? "border-dashed text-muted-foreground" : undefined}
            aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
            {kind === "all" ? t("filterAll") : t(`kind.${kind}`)}
          </Button>
        ))}
      </div>
      <div className="feed-search-row">
        <label className="relative min-w-0 flex-1">
          <svg className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" />
          </svg>
          <Input className="h-8 pl-8 text-xs" aria-label={t("searchAria")} type="search" placeholder={t("searchPlaceholder")}
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Button type="button" variant="outline" size="sm" className="shrink-0" title={t("latestTitle")} disabled={!feed.scope}
          onClick={() => { positionLatest.current = true; feed.latest(); }}>
          {t("latestLabel")} <span aria-hidden="true">↓</span>
        </Button>
      </div>
      {feed.error && <Alert variant="destructive" className="mx-4 mb-3 w-auto px-3 py-2">
        <AlertDescription className="text-xs">{t("loadErrorPrefix")}{feed.error}{page.length > 0 ? t("loadErrorCachedSuffix") : ""}</AlertDescription>
      </Alert>}
      {missingSelection && !loading && <Alert role="status" className="mx-4 mb-3 w-auto px-3 py-2">
        <AlertDescription className="text-xs">{t("missingSelectionNotice")}</AlertDescription>
      </Alert>}
      <div ref={list} className="feed-list" aria-busy={loading || feed.loadingOlder}>
        {pinned && <div className="feed-pinned">
          <p className="feed-notice">{t("pinnedNotice")}</p>{renderBlock(pinned)}
        </div>}
        {feed.hasMore && consistent && <Button type="button" variant="outline" size="sm"
          className="mx-[18px] mt-3 h-auto w-[calc(100%-36px)] flex-wrap gap-x-2 whitespace-normal px-3 py-2 text-xs"
          disabled={loading || feed.loadingOlder} onClick={() => {
            const first = page[0];
            const node = first && nodes.current.get(first.id);
            if (node) previousAnchor.current = { id: first.id, top: node.getBoundingClientRect().top };
            void feed.earlier();
          }}>
          {feed.loadingOlder ? t("loadingEarlier") : t("loadEarlier")}
          <span className="text-muted-foreground">{t("earlierHint")}</span>
        </Button>}
        {page.map(renderBlock)}
        {page.length === 0 && !pinned && <div className="feed-empty">
          <BlockIcon kind={filter === "all" ? "text" : filter} />
          <p>{loading ? t("emptyLoading") : feed.error ? t("emptyReadFailed") : !consistent ? t("scopeMismatch") : feed.total === 0 && filter === "all" && !query
            ? t("emptyNone") : t("emptyFiltered")}</p>
          <span>{!loading && (feed.error || !consistent) ? t("retryLatestHint") : !loading && !query ? t("emptyHintDefault") : query ? t("emptyHintQuery") : ""}</span>
        </div>}
      </div>
      {composer}
      <footer className="feed-footer">
        <span>{t("footerInWindow")} {page.length.toLocaleString()}{t("itemsUnit")} {t("footerHistoryTotal")} {feed.total.toLocaleString()}{t("itemsUnit")}
          {pinned ? t("pinnedKept") : ""}</span>
        <span>{feed.historical ? t("footerHistorical") : filter === "all" ? t("footerDiagnostic") : t(`kind.${filter}`)}</span>
      </footer>
    </section>
  );
}
