"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Boxes,
  CheckCircle2,
  Clock,
  Eye,
  FileCode2,
  FlaskConical,
  History,
  Monitor,
  Sparkles,
  Timer,
  TrendingUp,
} from "lucide-react";
import type {
  CapabilityEntry,
  CapabilityEnvEntry,
  CapabilityEvalRecord,
  CapabilityEvalStatus,
  CapabilitiesResult,
  CapabilityRuntime,
} from "@/lib/capabilities";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { useLocale, useTranslations } from "@/lib/locale";
import { useReadResource } from "@/components/use-read-resource";
import { useRetryFocus } from "@/components/use-retry-focus";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface WorkspaceCatalogProps {
  project: string;
  workspace: string | null;
  ready: boolean;
  catalogError?: string;
  catalogLoading?: boolean;
  onRetryCatalog(): void;
  onNavigate(href: string): void;
}

const EVAL_STATUS_ORDER: CapabilityEvalStatus[] = [
  "verified",
  "adapting",
  "stale",
  "failed",
  "unverified",
  "missing",
];

const STATUS_STROKE_COLORS: Record<CapabilityEvalStatus, string> = {
  verified: "#16a34a",
  adapting: "#7c3aed",
  stale: "#d97706",
  failed: "#dc2626",
  unverified: "#64748b",
  missing: "#94a3b8",
};

const SERIES_PALETTE = [
  "#16a34a",
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#0d9488",
  "#db2777",
];

function shortSha(sha?: string | null) {
  return sha ? sha.slice(0, 8) : null;
}

function shortCapabilityLabel(id: string) {
  const colon = id.lastIndexOf(":");
  if (colon >= 0 && colon < id.length - 1) return id.slice(colon + 1);
  return id.replace(/^python\//, "");
}

function isRatioRewardKey(key: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) return false;
  if (/_passed$|_cases$|^samples$|^sum$|^count$|_frames$/i.test(key)) return false;
  return /rate|accuracy|coverage|ratio|score|tracking|precision|recall|f1/i.test(key)
    || (!Number.isInteger(value) && value >= 0 && value <= 1);
}

function extractPrimaryReward(rewards?: Record<string, number> | null): { key: string; value: number; normalized: number; isRatio: boolean } | null {
  if (!rewards) return null;
  const entries = Object.entries(rewards).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  if (!entries.length) return null;
  const preferredKeys = ["pass_rate", "accuracy", "coverage", "score"];
  for (const key of preferredKeys) {
    const val = rewards[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      return { key, value: val, normalized: Math.max(0, Math.min(1, val)), isRatio: isRatioRewardKey(key, val) };
    }
  }
  const ratioEntry = entries.find(([k, v]) => isRatioRewardKey(k, v));
  if (ratioEntry) {
    return { key: ratioEntry[0], value: ratioEntry[1], normalized: Math.max(0, Math.min(1, ratioEntry[1])), isRatio: true };
  }
  const [firstKey, firstVal] = entries[0];
  return { key: firstKey, value: firstVal, normalized: firstVal > 0 ? 1 : 0, isRatio: false };
}

function formatRewardValue(value: number) {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(4)).toString();
}

function formatDuration(ms?: number | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function replayRecordHref(project: string, recordId: string) {
  return "/?" + new URLSearchParams({
    view: "replay",
    ...(project ? { project } : {}),
    replayRecord: recordId,
    replaySequence: "1",
  });
}

function NavigationLink({ href, onNavigate, children, primary = false }: {
  href: string; onNavigate(href: string): void; children: ReactNode; primary?: boolean;
}) {
  return <Button asChild variant={primary ? "default" : "outline"} size="sm" className="h-auto min-h-8 max-w-full whitespace-normal py-2 text-left">
    <a href={href} onClick={event => { if (isPlainNavigationClick(event)) { event.preventDefault(); onNavigate(href); } }}>{children}</a>
  </Button>;
}

function useGuideHref(project: string) {
  const { locale } = useLocale();
  return (doc: string) => "/?" + new URLSearchParams({ view: "docs", doc, docLang: locale, ...(project ? { project } : {}) });
}

function TriadSummaryBar({
  capabilities,
  envs,
  summary,
  selectedStatus,
  onSelectStatus,
}: {
  capabilities: CapabilityEntry[];
  envs: CapabilityEnvEntry[];
  summary: Record<CapabilityEvalStatus, number>;
  selectedStatus: CapabilityEvalStatus | "all";
  onSelectStatus(status: CapabilityEvalStatus | "all"): void;
}) {
  const t = useTranslations("capabilitiesView");
  const total = capabilities.length;
  const observed = capabilities.filter(item => item.observe).length;
  const boundEvals = capabilities.filter(item => item.evalId).length;
  return (
    <section className="triad-overview" aria-label={t("triadSummaryLabel")} data-capability-triad-summary>
      <div className="triad-pillars">
        <div className="triad-pillar">
          <div className="triad-pillar-head">
            <FileCode2 className="size-4 text-primary" aria-hidden="true" />
            <span>{t("pillarCapabilities")}</span>
          </div>
          <strong>{total}</strong>
          <small>{t("observedCount").replace("{count}", String(observed))}</small>
        </div>
        <div className="triad-pillar">
          <div className="triad-pillar-head">
            <FlaskConical className="size-4 text-primary" aria-hidden="true" />
            <span>{t("pillarEvals")}</span>
          </div>
          <strong>{boundEvals}</strong>
          <small>{t("boundCount").replace("{bound}", String(boundEvals)).replace("{total}", String(total))}</small>
        </div>
        <div className="triad-pillar">
          <div className="triad-pillar-head">
            <Boxes className="size-4 text-primary" aria-hidden="true" />
            <span>{t("pillarEnvs")}</span>
          </div>
          <strong>{envs.length}</strong>
          <small>{envs.length} {t("surrogateEnvsUnit")}</small>
        </div>
      </div>
      {total > 0 && (
        <div className="triad-status-filters" role="toolbar" aria-label={t("triadSummaryLabel")}>
          <button
            type="button"
            className="triad-filter-chip"
            data-active={selectedStatus === "all" || undefined}
            aria-pressed={selectedStatus === "all"}
            onClick={() => onSelectStatus("all")}
          >
            <span>{t("filterAll")}</span>
            <b>{total}</b>
          </button>
          {EVAL_STATUS_ORDER.map(status => {
            const count = summary[status] ?? 0;
            if (count === 0 && selectedStatus !== status) return null;
            return (
              <button
                key={status}
                type="button"
                className="triad-filter-chip"
                data-status={status}
                data-active={selectedStatus === status || undefined}
                aria-pressed={selectedStatus === status}
                onClick={() => onSelectStatus(selectedStatus === status ? "all" : status)}
              >
                <i className="triad-status-dot" data-status={status} aria-hidden="true" />
                <span>{t(`evalStatuses.${status}`)}</span>
                <b>{count}</b>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TriadAnalyticsDeck({
  capabilities,
  envs,
  summary,
}: {
  capabilities: CapabilityEntry[];
  envs: CapabilityEnvEntry[];
  summary: Record<CapabilityEvalStatus, number>;
}) {
  const t = useTranslations("capabilitiesView");
  const [focusedCapId, setFocusedCapId] = useState<string | null>(null);
  const total = capabilities.length;
  if (total === 0) return null;

  const verifiedCount = summary.verified ?? 0;
  const verifiedPct = Math.round((verifiedCount / total) * 100);
  const observedCount = capabilities.filter(c => c.observe).length;
  const boundEvalCount = capabilities.filter(c => c.evalId).length;
  const boundEnvCount = capabilities.filter(c => c.evalEnvId).length;

  // Donut segments (r = 42, C = 263.89)
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let accumulatedFraction = 0;
  const donutSegments = EVAL_STATUS_ORDER.map(status => {
    const count = summary[status] ?? 0;
    const fraction = count / total;
    const dash = fraction * circumference;
    const offset = -accumulatedFraction * circumference;
    accumulatedFraction += fraction;
    return { status, count, dash, offset, color: STATUS_STROKE_COLORS[status] };
  }).filter(seg => seg.count > 0);

  // Trajectory series (chronological oldest -> newest per capability)
  const trajectorySeries = capabilities
    .map((cap, idx) => {
      const chronological = [...(cap.history ?? [])].reverse();
      const points = chronological
        .map(run => {
          const primary = extractPrimaryReward(run.rewards);
          if (!primary) return null;
          return {
            runId: run.runId,
            evaluatedAt: run.evaluatedAt,
            outcome: run.adaptation ? "adapting" : run.outcome,
            durationMs: run.durationMs,
            metricKey: primary.key,
            rawValue: primary.value,
            normalized: primary.normalized,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        id: cap.id,
        label: shortCapabilityLabel(cap.id),
        color: SERIES_PALETTE[idx % SERIES_PALETTE.length],
        points,
      };
    })
    .filter(s => s.points.length > 0);

  const allRuns = capabilities.flatMap(c => c.history ?? []);
  const passedRuns = allRuns.filter(r => r.outcome === "passed" && !r.adaptation).length;
  const historicalPassRate = allRuns.length > 0 ? Math.round((passedRuns / allRuns.length) * 100) : 0;
  const latestPrimaries = capabilities
    .map(c => extractPrimaryReward(c.evalRewards))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  const avgLatestScore = latestPrimaries.length > 0
    ? Math.round((latestPrimaries.reduce((acc, p) => acc + p.normalized, 0) / latestPrimaries.length) * 100)
    : 0;

  // Duration profile
  const durationRows = capabilities
    .map((cap, idx) => {
      const durations = (cap.history ?? [])
        .map(r => r.durationMs)
        .filter((d): d is number => typeof d === "number" && d > 0);
      const latestMs = cap.latestRecord?.durationMs ?? durations[0] ?? 0;
      const minMs = durations.length > 0 ? Math.min(...durations) : latestMs;
      const maxMs = durations.length > 0 ? Math.max(...durations) : latestMs;
      const metricsCount = Object.keys(cap.evalRewards ?? {}).length;
      const runsCount = cap.history?.length ?? (cap.latestRecord ? 1 : 0);
      return {
        id: cap.id,
        label: shortCapabilityLabel(cap.id),
        status: cap.evalStatus ?? "missing",
        color: SERIES_PALETTE[idx % SERIES_PALETTE.length],
        latestMs,
        minMs,
        maxMs,
        metricsCount,
        runsCount,
      };
    })
    .sort((a, b) => b.latestMs - a.latestMs || b.metricsCount - a.metricsCount);

  const maxDurationMs = Math.max(100, ...durationRows.map(r => Math.max(r.latestMs, r.maxMs)));

  return (
    <section className="triad-analytics-deck" aria-label={t("analyticsSectionLabel")} data-capability-analytics>
      {/* Chart 1: Triad Verification Donut & 3-Layer Coverage */}
      <article className="triad-chart-card" data-triad-chart="health">
        <header className="triad-chart-header">
          <div className="triad-chart-title">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            <h4>{t("healthChartTitle")}</h4>
          </div>
          <span className="triad-chart-pill">{verifiedCount}/{total} {t("healthChartVerifiedRate")}</span>
        </header>
        <div className="triad-health-body">
          <div className="triad-donut-wrap">
            <svg viewBox="0 0 110 110" className="triad-donut-svg" role="img" aria-label={t("healthChartTitle")}>
              <circle cx="55" cy="55" r={radius} fill="none" stroke="var(--border)" strokeWidth="10" />
              {donutSegments.map(seg => (
                <circle
                  key={seg.status}
                  cx="55"
                  cy="55"
                  r={radius}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="10"
                  strokeDasharray={`${seg.dash} ${circumference}`}
                  strokeDashoffset={seg.offset}
                  strokeLinecap={donutSegments.length === 1 ? "round" : "butt"}
                  transform="rotate(-90 55 55)"
                />
              ))}
              <text x="55" y="53" textAnchor="middle" className="triad-donut-value">{verifiedPct}%</text>
              <text x="55" y="68" textAnchor="middle" className="triad-donut-sub">{t("healthChartVerifiedRate")}</text>
            </svg>
          </div>
          <div className="triad-coverage-bars">
            <div className="triad-coverage-item">
              <div className="triad-coverage-head">
                <span>{t("coverageCapabilityObserve")}</span>
                <b>{observedCount}/{total}</b>
              </div>
              <div className="triad-coverage-track">
                <div className="triad-coverage-fill" data-layer="capability" style={{ width: `${Math.round((observedCount / total) * 100)}%` }} />
              </div>
            </div>
            <div className="triad-coverage-item">
              <div className="triad-coverage-head">
                <span>{t("coverageEvalBound")}</span>
                <b>{boundEvalCount}/{total}</b>
              </div>
              <div className="triad-coverage-track">
                <div className="triad-coverage-fill" data-layer="eval" style={{ width: `${Math.round((boundEvalCount / total) * 100)}%` }} />
              </div>
            </div>
            <div className="triad-coverage-item">
              <div className="triad-coverage-head">
                <span>{t("coverageEnvClosedLoop")}</span>
                <b>{boundEnvCount}/{Math.max(1, boundEvalCount)} · {envs.length} env</b>
              </div>
              <div className="triad-coverage-track">
                <div className="triad-coverage-fill" data-layer="env" style={{ width: `${Math.round((boundEnvCount / Math.max(1, boundEvalCount)) * 100)}%` }} />
              </div>
            </div>
          </div>
        </div>
      </article>

      {/* Chart 2: Chronological Reward Evolution Trajectory */}
      <article className="triad-chart-card" data-triad-chart="trajectory">
        <header className="triad-chart-header">
          <div className="triad-chart-title">
            <TrendingUp className="size-4 text-primary" aria-hidden="true" />
            <div>
              <h4>{t("trajectoryChartTitle")}</h4>
              <p className="triad-chart-subtitle">{t("trajectoryChartSubtitle")}</p>
            </div>
          </div>
        </header>
        {trajectorySeries.length === 0 ? (
          <p className="triad-chart-empty">{t("trajectoryEmpty")}</p>
        ) : (
          <>
            <div className="triad-series-legend" role="toolbar" aria-label={t("trajectoryChartTitle")}>
              <button
                type="button"
                className="triad-series-chip"
                data-active={focusedCapId === null || undefined}
                onClick={() => setFocusedCapId(null)}
              >
                <span>{t("filterAll")}</span>
              </button>
              {trajectorySeries.map(series => (
                <button
                  key={series.id}
                  type="button"
                  className="triad-series-chip"
                  data-active={focusedCapId === series.id || undefined}
                  onClick={() => setFocusedCapId(focusedCapId === series.id ? null : series.id)}
                >
                  <i style={{ background: series.color }} aria-hidden="true" />
                  <span>{series.label}</span>
                  <b>{Math.round(series.points[series.points.length - 1]!.normalized * 100)}%</b>
                </button>
              ))}
            </div>
            <svg viewBox="0 0 380 132" className="triad-trajectory-svg" role="img" aria-label={t("trajectoryChartTitle")}>
              {[0, 0.5, 1].map(level => {
                const y = 108 - level * 88;
                return (
                  <g key={level}>
                    <line x1="34" x2="366" y1={y} y2={y} className="triad-chart-grid" />
                    <text x="28" y={y + 3.5} textAnchor="end" className="triad-chart-axis-text">
                      {Math.round(level * 100)}%
                    </text>
                  </g>
                );
              })}
              {trajectorySeries.map(series => {
                const dimmed = focusedCapId !== null && focusedCapId !== series.id;
                const count = series.points.length;
                const coords = series.points.map((pt, i) => {
                  const x = count === 1 ? 200 : 42 + (i / (count - 1)) * 316;
                  const y = 108 - pt.normalized * 88;
                  return { x, y, pt };
                });
                const linePath = coords.length === 1
                  ? `M 42 ${coords[0]!.y} L 358 ${coords[0]!.y}`
                  : coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
                const areaPath = coords.length > 1
                  ? `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} 108 L ${coords[0]!.x.toFixed(1)} 108 Z`
                  : null;
                return (
                  <g key={series.id} opacity={dimmed ? 0.18 : 1} data-trajectory-series={series.id}>
                    {areaPath && (focusedCapId === series.id || trajectorySeries.length === 1) && (
                      <path d={areaPath} fill={series.color} fillOpacity="0.12" />
                    )}
                    <path
                      d={linePath}
                      fill="none"
                      stroke={series.color}
                      strokeWidth={focusedCapId === series.id ? "2.6" : "2"}
                      strokeDasharray={coords.length === 1 ? "4 4" : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    {coords.map((c, i) => (
                      <g key={`${series.id}-${c.pt.runId}-${i}`}>
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r={c.pt.outcome === "passed" ? 3.6 : 4.2}
                          fill={c.pt.outcome === "passed" ? series.color : "var(--card)"}
                          stroke={c.pt.outcome === "failed" ? "#dc2626" : c.pt.outcome === "adapting" ? "#7c3aed" : series.color}
                          strokeWidth="2"
                        >
                          <title>{`${series.label} · ${c.pt.metricKey}: ${formatRewardValue(c.pt.rawValue)} (${c.pt.outcome})`}</title>
                        </circle>
                      </g>
                    ))}
                  </g>
                );
              })}
            </svg>
            <footer className="triad-chart-footer">
              <span>{t("trajectoryTotalRuns").replace("{count}", String(allRuns.length))}</span>
              <span>·</span>
              <span>{t("trajectoryHistoricalPass").replace("{rate}", String(historicalPassRate))}</span>
              <span>·</span>
              <span>{t("trajectoryAvgReward").replace("{score}", String(avgLatestScore))}</span>
            </footer>
          </>
        )}
      </article>

      {/* Chart 3: Evaluation Runtime & Assertion Density */}
      <article className="triad-chart-card" data-triad-chart="duration">
        <header className="triad-chart-header">
          <div className="triad-chart-title">
            <BarChart3 className="size-4 text-primary" aria-hidden="true" />
            <div>
              <h4>{t("durationChartTitle")}</h4>
              <p className="triad-chart-subtitle">{t("durationChartSubtitle")}</p>
            </div>
          </div>
        </header>
        {durationRows.every(r => r.latestMs === 0 && r.metricsCount === 0) ? (
          <p className="triad-chart-empty">{t("durationEmpty")}</p>
        ) : (
          <ul className="triad-duration-bars" role="list">
            {durationRows.map(row => {
              const latestPct = Math.max(3, Math.round((row.latestMs / maxDurationMs) * 100));
              const minPct = Math.round((row.minMs / maxDurationMs) * 100);
              const maxPct = Math.round((row.maxMs / maxDurationMs) * 100);
              return (
                <li key={row.id} className="triad-duration-row" data-duration-row={row.id}>
                  <div className="triad-duration-meta">
                    <code className="triad-duration-name">{row.label}</code>
                    <div className="triad-duration-badges">
                      {row.metricsCount > 0 && (
                        <span className="triad-duration-tag">{t("durationMetricsCount").replace("{count}", String(row.metricsCount))}</span>
                      )}
                      {row.runsCount > 0 && (
                        <span className="triad-duration-tag">{t("durationRunsCount").replace("{count}", String(row.runsCount))}</span>
                      )}
                      <strong className="triad-duration-val">{formatDuration(row.latestMs) ?? "—"}</strong>
                    </div>
                  </div>
                  <div className="triad-duration-track">
                    {row.maxMs > row.minMs && (
                      <div
                        className="triad-duration-range"
                        style={{ left: `${minPct}%`, width: `${Math.max(2, maxPct - minPct)}%` }}
                        title={`${formatDuration(row.minMs)} – ${formatDuration(row.maxMs)}`}
                      />
                    )}
                    <div
                      className="triad-duration-fill"
                      data-status={row.status}
                      style={{ width: `${row.latestMs > 0 ? latestPct : 0}%`, background: row.color }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}

function CapabilitySparkline({ item }: { item: CapabilityEntry }) {
  const t = useTranslations("capabilitiesView");
  const history = item.history ?? [];
  if (history.length === 0) return null;
  const chronological = [...history].reverse();
  const points = chronological
    .map(run => {
      const primary = extractPrimaryReward(run.rewards);
      return {
        runId: run.runId,
        outcome: run.adaptation ? "adapting" : run.outcome,
        normalized: primary ? primary.normalized : run.outcome === "passed" ? 1 : 0,
        rawValue: primary?.value ?? (run.outcome === "passed" ? 1 : 0),
        metricKey: primary?.key ?? "outcome",
        isRatio: primary?.isRatio ?? true,
      };
    });
  const first = points[0]!;
  const latest = points[points.length - 1]!;
  const deltaPct = Math.round((latest.normalized - first.normalized) * 100);
  const coords = points.map((pt, i) => {
    const x = points.length === 1 ? 90 : 8 + (i / (points.length - 1)) * 164;
    const y = 34 - pt.normalized * 26;
    return { x, y, pt };
  });
  const linePath = coords.length === 1
    ? `M 8 ${coords[0]!.y} L 172 ${coords[0]!.y}`
    : coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1]?.x ?? 172} 38 L ${coords[0]?.x ?? 8} 38 Z`;

  return (
    <div className="triad-sparkline-strip" data-capability-sparkline={item.id}>
      <div className="triad-sparkline-info">
        <div className="triad-sparkline-head">
          <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
          <span className="triad-sparkline-title">{t("sparklineLabel")}</span>
          <code className="triad-sparkline-key">{latest.metricKey}</code>
          {points.length > 1 && deltaPct !== 0 && (
            <span className="triad-sparkline-delta" data-positive={deltaPct > 0 || undefined}>
              {deltaPct > 0 ? `+${deltaPct}%` : `${deltaPct}%`}
            </span>
          )}
        </div>
        <div className="triad-outcome-dots" aria-label={t("sparklineRuns").replace("{count}", String(points.length))}>
          {points.map((pt, idx) => (
            <span
              key={`${pt.runId}-${idx}`}
              className="triad-outcome-dot"
              data-outcome={pt.outcome}
              title={`${pt.runId}: ${pt.metricKey}=${formatRewardValue(pt.rawValue)} (${pt.outcome})`}
            />
          ))}
          <small className="triad-outcome-count">{t("sparklineRuns").replace("{count}", String(points.length))}</small>
        </div>
      </div>
      <svg viewBox="0 0 180 40" className="triad-sparkline-svg" aria-hidden="true">
        <path d={areaPath} fill="var(--primary)" fillOpacity="0.1" />
        <path d={linePath} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((c, idx) => (
          <circle
            key={`${c.pt.runId}-${idx}`}
            cx={c.x}
            cy={c.y}
            r={idx === coords.length - 1 ? 3.4 : 2.4}
            fill={c.pt.outcome === "passed" ? "#16a34a" : c.pt.outcome === "adapting" ? "#7c3aed" : "#dc2626"}
          />
        ))}
      </svg>
    </div>
  );
}

function ReplayRecordLinks({
  records,
  project,
  onNavigate,
}: {
  records: string[];
  project: string;
  onNavigate(href: string): void;
}) {
  const t = useTranslations("capabilitiesView");
  if (!records.length) return null;
  return (
    <div className="triad-record-links" data-capability-adaptation-records>
      {records.map(recordId => {
        const href = replayRecordHref(project, recordId);
        return (
          <a
            key={recordId}
            href={href}
            className="triad-record-link"
            data-capability-record-link={recordId}
            onClick={event => {
              if (isPlainNavigationClick(event)) {
                event.preventDefault();
                onNavigate(href);
              }
            }}
          >
            <code>{recordId.slice(0, 12)}</code>
            <span>{t("openReplayRecord").replace("{id}", recordId.slice(0, 8))}</span>
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
        );
      })}
    </div>
  );
}

function CapabilityHistoryDrawer({
  item,
  project,
  onNavigate,
}: {
  item: CapabilityEntry;
  project: string;
  onNavigate(href: string): void;
}) {
  const t = useTranslations("capabilitiesView");
  const history: CapabilityEvalRecord[] = item.history ?? [];
  if (!history.length && !item.latestRecord?.details) return null;
  return (
    <div className="triad-drawers">
      {history.length > 0 && (
        <details className="triad-drawer" data-capability-history={item.id}>
          <summary>
            <span className="inline-flex items-center gap-1.5">
              <History className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {t("historyToggle").replace("{count}", String(history.length))}
            </span>
            {item.latestRecord && <code>{item.latestRecord.runId}</code>}
          </summary>
          <ol className="triad-history-list">
            {history.map(run => {
              const isAdapting = !!run.adaptation;
              const statusKey = isAdapting ? "adapting" : run.outcome;
              const statusLabel = isAdapting
                ? t("runOutcomeAdapting")
                : run.outcome === "passed"
                  ? t("runOutcomePassed")
                  : t("runOutcomeFailed");
              const duration = formatDuration(run.durationMs);
              return (
                <li key={run.runId} className="triad-history-row" data-eval-run={run.runId} data-eval-outcome={statusKey}>
                  <div className="triad-history-head">
                    <span className="triad-run-badge" data-outcome={statusKey}>{statusLabel}</span>
                    <time dateTime={run.evaluatedAt}>{new Date(run.evaluatedAt).toLocaleString()}</time>
                    {duration && <span className="triad-history-duration">{duration}</span>}
                    <span className="triad-history-shas">
                      <code>cap #{shortSha(run.capabilityCodeSHA)}</code>
                      {run.evalCodeSHA && <code>eval #{shortSha(run.evalCodeSHA)}</code>}
                      {run.envCodeSHA && <code>env #{shortSha(run.envCodeSHA)}</code>}
                    </span>
                  </div>
                  {run.rewards && Object.keys(run.rewards).length > 0 && (
                    <div className="capability-eval-rewards">
                      {Object.entries(run.rewards).map(([key, value]) => (
                        <span key={key}>{key}: {formatRewardValue(value)}</span>
                      ))}
                    </div>
                  )}
                  {run.adaptation && (
                    <div className="triad-history-adaptation">
                      <p>{run.adaptation.reason}</p>
                      <ReplayRecordLinks records={run.adaptation.records} project={project} onNavigate={onNavigate} />
                    </div>
                  )}
                  {!run.adaptation && run.error && (
                    <p className="capability-eval-error">{run.error.type}: {run.error.message}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
      {item.latestRecord?.details && Object.keys(item.latestRecord.details).length > 0 && (
        <details className="triad-drawer" data-capability-details={item.id}>
          <summary>
            <span>{t("latestDetailsToggle")}</span>
            <code>{Object.keys(item.latestRecord.details).join(", ")}</code>
          </summary>
          <pre className="triad-details-pre">{JSON.stringify(item.latestRecord.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function WorkspaceTriadDeclarations({
  items,
  title,
  project,
  onNavigate,
}: {
  items: CapabilityEntry[];
  title: string;
  project: string;
  onNavigate(href: string): void;
}) {
  const t = useTranslations("capabilitiesView");
  return (
    <ul className="triad-capability-list" role="list" aria-label={title}>
      {items.map(item => {
        const capSha = shortSha(item.codeSHA);
        const evalBinding = item.eval;
        const envBinding = item.evalEnv ?? evalBinding?.env ?? null;
        const staleSet = new Set(item.staleReasons ?? []);
        const duration = formatDuration(item.latestRecord?.durationMs);
        const adaptation = item.latestRecord?.adaptation;
        return (
          <li key={item.id} className="capability-declaration triad-card" data-capability-declaration={item.id}>
            <div className="triad-card-header">
              <div className="triad-card-title-row">
                <h4 className="capability-declaration-name">
                  <code>{item.id}</code>
                  {item.evalStatus && (
                    <Badge
                      variant="outline"
                      className="capability-eval-status"
                      data-capability-eval-status={item.evalStatus}
                    >
                      {t(`evalStatuses.${item.evalStatus}`)}
                    </Badge>
                  )}
                  {item.observe && (
                    <Badge variant="outline" className="triad-observe-badge" data-capability-observe>
                      <Eye className="size-3" aria-hidden="true" />
                      {t("observeBadge")}
                    </Badge>
                  )}
                </h4>
                <div className="triad-origin-meta">
                  {item.origin && <code>{item.origin.path}:{item.origin.line}</code>}
                  {capSha && <code>#{capSha}</code>}
                </div>
              </div>
              <div className="capability-declaration-description">
                <p>{item.description || <span className="text-muted-foreground">{t("noDescription")}</span>}</p>
              </div>
            </div>

            <div className="triad-topology" data-capability-triad={item.id}>
              <div className="triad-node" data-node="capability" data-stale={staleSet.has("capability") || undefined}>
                <div className="triad-node-head">
                  <span className="triad-node-kind">{t("nodeCapability")}</span>
                  {staleSet.has("capability") && <span className="triad-drift-badge">{t("shaDrift")}</span>}
                  {capSha && <code className="triad-node-sha">#{capSha}</code>}
                </div>
                <code className="triad-node-id">{item.origin ? `${item.origin.path}:${item.origin.function}` : item.id}</code>
                <p className="triad-node-desc">{item.description || t("noDescription")}</p>
              </div>

              <div className="triad-arrow" aria-hidden="true"><ArrowRight className="size-4" /></div>

              <div className="triad-node" data-node="eval" data-stale={staleSet.has("eval") || undefined} data-unbound={!item.evalId || undefined}>
                <div className="triad-node-head">
                  <span className="triad-node-kind">{t("nodeEval")}</span>
                  {staleSet.has("eval") && <span className="triad-drift-badge">{t("shaDrift")}</span>}
                  {evalBinding?.codeSHA && <code className="triad-node-sha">#{shortSha(evalBinding.codeSHA)}</code>}
                </div>
                {item.evalId ? (
                  <>
                    <p className="capability-eval-id">
                      <span className="sr-only">{t("evalFunction")}</span>
                      <code data-capability-eval-id={item.evalId}>{item.evalId}</code>
                    </p>
                    <p className="triad-node-desc">{evalBinding?.description || t("noDescription")}</p>
                  </>
                ) : (
                  <>
                    <span className="triad-node-empty">{t("unboundEval")}</span>
                    <p className="triad-node-desc">{t("unboundEvalHint")}</p>
                  </>
                )}
              </div>

              <div className="triad-arrow" aria-hidden="true"><ArrowRight className="size-4" /></div>

              <div className="triad-node" data-node="env" data-stale={staleSet.has("env") || undefined} data-unbound={!item.evalEnvId || undefined}>
                <div className="triad-node-head">
                  <span className="triad-node-kind">{t("nodeEnv")}</span>
                  {staleSet.has("env") && <span className="triad-drift-badge">{t("shaDrift")}</span>}
                  {envBinding?.codeSHA && <code className="triad-node-sha">#{shortSha(envBinding.codeSHA)}</code>}
                </div>
                {item.evalEnvId ? (
                  <>
                    <code className="triad-node-id" data-capability-env-id={item.evalEnvId}>{item.evalEnvId}</code>
                    <p className="triad-node-desc">{envBinding?.description || t("noDescription")}</p>
                  </>
                ) : (
                  <>
                    <span className="triad-node-empty">{t("unboundEnv")}</span>
                    <p className="triad-node-desc">{t("unboundEnvHint")}</p>
                  </>
                )}
              </div>
            </div>

            {item.evalStatus === "stale" && item.staleReasons && item.staleReasons.length > 0 && (
              <p className="triad-stale-banner" data-capability-stale-reasons={item.staleReasons.join(",")}>
                <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {t("staleReasonPrefix")}
                  <strong>{item.staleReasons.map(reason => `@${reason === "capability" ? "capability" : reason === "eval" ? "eval_capability" : "eval_env"}`).join(", ")}</strong>
                </span>
              </p>
            )}

            {(item.evalRewards && Object.keys(item.evalRewards).length > 0 || item.evalEvaluatedAt) && (
              <div className="triad-metrics-row">
                {item.evalRewards && Object.keys(item.evalRewards).length > 0 && (
                  <div className="capability-eval-rewards" data-capability-eval-rewards>
                    {Object.entries(item.evalRewards).map(([key, value]) => {
                      const ratio = isRatioRewardKey(key, value);
                      const pct = ratio ? Math.round(Math.max(0, Math.min(1, value)) * 100) : null;
                      return (
                        <span key={key} data-reward-ratio={ratio || undefined}>
                          <small>{key}</small>
                          <b>{formatRewardValue(value)}</b>
                          {pct !== null && (
                            <i className="triad-reward-meter" aria-hidden="true">
                              <em style={{ width: `${pct}%` }} data-high={pct >= 95 || undefined} />
                            </i>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
                {item.evalEvaluatedAt && (
                  <div className="triad-eval-timestamp">
                    <CheckCircle2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span>{t("evaluatedAtLabel")} <time dateTime={item.evalEvaluatedAt}>{new Date(item.evalEvaluatedAt).toLocaleString()}</time></span>
                    {duration && <span>· {t("durationLabel")} {duration}</span>}
                  </div>
                )}
              </div>
            )}

            <CapabilitySparkline item={item} />

            {adaptation && (
              <div className="triad-adaptation-box" data-capability-adaptation={item.id}>
                <div className="triad-adaptation-head">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                  <strong>{item.evalStatus === "adapting" ? t("adaptationGateTitle") : t("adaptationHistoryTitle")}</strong>
                </div>
                <p className="capability-eval-error" data-capability-eval-error>{item.evalError ?? adaptation.reason}</p>
                <ReplayRecordLinks records={adaptation.records} project={project} onNavigate={onNavigate} />
              </div>
            )}

            {!adaptation && item.evalError && (
              <p className="capability-eval-error" data-capability-eval-error>{item.evalError}</p>
            )}

            <CapabilityHistoryDrawer item={item} project={project} onNavigate={onNavigate} />
          </li>
        );
      })}
    </ul>
  );
}

function SurrogateEnvsCatalog({ envs }: { envs: CapabilityEnvEntry[] }) {
  const t = useTranslations("capabilitiesView");
  return (
    <Card className="min-w-0" data-capability-source="envs">
      <CardContent className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h3 className="flex items-center gap-2.5 text-base font-semibold">
              <Boxes className="size-5 shrink-0 text-primary" aria-hidden="true" />
              {t("envsTitle")}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{envs.length} {t("envsUnit")}</span>
            </div>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("envsDescription")}</p>
        {envs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("envsEmpty")}</p>
        ) : (
          <ul className="triad-env-grid" role="list" aria-label={t("envsTitle")}>
            {envs.map(env => (
              <li key={env.id} className="triad-env-card" data-capability-env={env.id}>
                <div className="triad-env-head">
                  <h4><code>{env.name}</code></h4>
                  <div className="triad-origin-meta">
                    <code>{env.origin.path}:{env.origin.line}</code>
                    <code>#{shortSha(env.codeSHA)}</code>
                  </div>
                </div>
                <code className="triad-env-full-id">{env.id}</code>
                <p className="triad-env-desc">{env.description || t("noDescription")}</p>
                <div className="triad-env-bindings">
                  {env.boundCapabilities.length > 0 ? (
                    <>
                      <span className="triad-env-binding-label">{t("boundCapabilitiesLabel")}:</span>
                      {env.boundCapabilities.map(capId => (
                        <code key={capId} className="triad-env-bound-chip">{capId}</code>
                      ))}
                    </>
                  ) : (
                    <span className="triad-env-context-note">{t("contextManagedEnv")}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceCapabilityDeclarations({ items, title }: { items: CapabilityEntry[]; title: string }) {
  const t = useTranslations("capabilitiesView");
  return <div className="capability-declarations">
    <div className="capability-declaration-columns" aria-hidden="true"><span>{t("capabilityCol")}</span><span>{t("descriptionCol")}</span><span>{t("controlCol")}</span></div>
    <ul className="capability-declaration-list" role="list" aria-label={title}>
      {items.map(item => <li key={item.id} className="capability-declaration" data-capability-declaration={item.id}>
        <h4 className="capability-declaration-name"><code>{item.id}</code></h4>
        <div className="capability-declaration-description">
          <p>{item.description || <span className="text-muted-foreground">{t("noDescription")}</span>}</p>
        </div>
        <dl className="capability-declaration-control"><dt>{t("controlCol")}</dt><dd>
          <span data-capability-control>{item.requiresControl === null ? "—" : t(item.requiresControl ? "needsControl" : "noControl")}</span>
          {item.readOnly !== null && <span data-capability-read-only>{t(item.readOnly ? "readOnlySuffix" : "sideEffectsSuffix")}</span>}
        </dd></dl>
      </li>)}
    </ul>
  </div>;
}

function ConnectionCheck({ project, workspace }: { project: string; workspace: string }) {
  const t = useTranslations("capabilitiesView");
  const [value, setValue] = useState<CapabilityRuntime | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), request = useRef<AbortController | null>(null);
  const check = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/capabilities/runtime?" + new URLSearchParams({ project, workspace }),
        { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("runtimeReadFailed"));
      if (request.current === controller && !controller.signal.aborted) { setValue(result); setError(""); }
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setLoading(false); } }
  };
  useEffect(() => {
    void check();
    return () => { const controller = request.current; request.current = null; controller?.abort(); };
  }, [project, workspace]);
  const status = loading ? "runtimeChecking" : error ? value ? "runtimeStale" : "runtimeReadFailed" : !value ? "runtimeUnchecked" : value.host === "unavailable" ? "runtimeUnavailable"
    : value.controlConnected === null ? "runtimeUnknown" : value.controlConnected ? "runtimeConnected" : "runtimeDisconnected";
  return <Card className="min-w-0" data-capability-runtime><CardContent className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><Activity className="size-5 text-primary" /><h2 className="text-base font-semibold">{t("runtimeTitle")}</h2></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={loading} className="aria-disabled:opacity-50" onClick={() => void check()}>{t(loading ? "runtimeChecking" : "checkRuntime")}</Button></div>
    <p role="status" className="text-sm">{t(status)}</p><p className="text-xs leading-relaxed text-muted-foreground">{t("runtimeReadOnly")}</p>
    {error && <Alert variant="destructive"><AlertDescription>{t("runtimeReadFailed")}<details className="mt-2 text-xs"><summary>{t("errorDetails")}</summary><p className="mt-2 break-all">{error}</p></details></AlertDescription></Alert>}
    {value && <div className="space-y-1 text-xs text-muted-foreground"><p>{t("checkedAt")} <time dateTime={value.checkedAt}>{new Date(value.checkedAt).toLocaleString()}</time></p>
      {value.runId && <p className="break-all">{t("hostRunLabel")}: <code>{value.runId}</code></p>}</div>}
  </CardContent></Card>;
}

function WorkspaceCapabilities({ project, workspace, ready, catalogError, catalogLoading, onRetryCatalog, onNavigate }: WorkspaceCatalogProps) {
  const t = useTranslations("capabilitiesView"), guide = useGuideHref(project);
  const capsLoad = useReadResource<CapabilitiesResult>(project && workspace ? "/api/capabilities?" + new URLSearchParams({ project, workspace }) : null, t("readFailed"));
  const caps = capsLoad.value;
  const [statusFilter, setStatusFilter] = useState<CapabilityEvalStatus | "all">("all");
  const catalogFocus = useRetryFocus(!!catalogLoading, catalogError);
  const links = { device: { doc: "tutorials/devices", label: "deviceGuide" }, workspace: { doc: "tutorials/workspace", label: "capabilityGuide" } };
  const workspaceItems = caps?.groups.find(group => group.id === "workspace")?.items ?? [];
  const filteredWorkspaceItems = statusFilter === "all"
    ? workspaceItems
    : workspaceItems.filter(item => item.evalStatus === statusFilter);
  const deviceItems = caps?.groups.find(group => group.id === "device")?.items ?? [];
  const envs = caps?.envs ?? [];
  const evalSummary = caps?.evalSummary ?? { missing: 0, unverified: 0, stale: 0, adapting: 0, failed: 0, verified: 0 };

  return <div ref={catalogFocus.target} className="grid min-w-0 grid-cols-1 gap-5" tabIndex={-1} role="region" aria-label={t("overviewLabel")} aria-busy={capsLoad.loading}>
    {catalogError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><p>{t("catalogFailed")}</p><details className="mt-1 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{catalogError}</pre></details></div>
      <Button type="button" variant="outline" size="sm" aria-disabled={catalogLoading} className="aria-disabled:opacity-50" onClick={event => { if (!catalogLoading) { catalogFocus.remember(event.currentTarget); onRetryCatalog(); } }}>{t(catalogLoading ? "retrying" : "retryCatalog")}</Button></AlertDescription></Alert>}
    {project && workspace && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{t("readOnlyRefreshHint")}</p>
      <Button type="button" size="sm" variant="outline" aria-disabled={capsLoad.loading} className="aria-disabled:opacity-50" onClick={() => { if (!capsLoad.loading) capsLoad.retry(); }}>{t(capsLoad.loading ? "retrying" : capsLoad.error ? "retryRead" : "refresh")}</Button></div>}
    {capsLoad.error && <Alert variant="destructive"><AlertDescription><p>{t("loadErrorTitle")}</p><details className="mt-1 text-xs"><summary>{t("errorDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{capsLoad.error}</pre></details>{caps && <p className="mt-1">{t("showingCached")}</p>}</AlertDescription></Alert>}
    {!caps ? !ready || capsLoad.loading ? <Card><CardContent role="status"><h3 className="text-sm font-semibold">{t(!ready ? "loadingWorkspaces" : "loadingTitle")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("loadingDesc")}</p></CardContent></Card>
      : !catalogError && !capsLoad.error ? <Card><CardContent className="space-y-4"><h3 className="text-base font-semibold">{t("emptyTitle")}</h3><p className="text-sm text-muted-foreground">{t("emptyDesc")}</p><div className="flex flex-wrap gap-2">
        <NavigationLink href="/?view=workspaces&create=1" onNavigate={onNavigate} primary>{t("createWorkspace")}</NavigationLink><NavigationLink href="/?view=workspaces" onNavigate={onNavigate}>{t("viewWorkspaces")}</NavigationLink></div></CardContent></Card> : null : <>
      <TriadSummaryBar
        capabilities={workspaceItems}
        envs={envs}
        summary={evalSummary}
        selectedStatus={statusFilter}
        onSelectStatus={setStatusFilter}
      />

      <TriadAnalyticsDeck
        capabilities={workspaceItems}
        envs={envs}
        summary={evalSummary}
      />

      <Card className="min-w-0" data-capability-source="workspace">
        <CardContent className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <h3 className="flex items-center gap-3 text-base font-semibold">
                <FileCode2 className="size-5 shrink-0 text-primary" />
                {t("groupTitles.workspace")}
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{t(`sourceStates.${caps.sources.workspace.status}`)}</Badge>
                <span>
                  {caps.sources.workspace.status === "error" || caps.sources.workspace.status === "missing"
                    ? "—"
                    : String(workspaceItems.length)}{" "}
                  {t("capabilitiesUnit")}
                </span>
              </div>
            </div>
            <NavigationLink href={guide(links.workspace.doc)} onNavigate={onNavigate}>
              <BookOpen />{t(links.workspace.label)}
            </NavigationLink>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sourceDescriptions.workspace")}</p>
          {caps.sources.workspace.status === "error" ? (
            <p className="text-sm text-destructive">{t("sourceFailure")}</p>
          ) : workspaceItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sourceEmpty.workspace")}</p>
          ) : filteredWorkspaceItems.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <span>{t("filterEmpty")}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setStatusFilter("all")}>
                {t("clearFilter")}
              </Button>
            </div>
          ) : (
            <WorkspaceTriadDeclarations
              items={filteredWorkspaceItems}
              title={t("groupTitles.workspace")}
              project={project}
              onNavigate={onNavigate}
            />
          )}
          {caps.sources.workspace.issueCount > 0 && (
            <p className="text-xs text-muted-foreground">{t("diagnosticsTitle")}: {caps.sources.workspace.issueCount}</p>
          )}
        </CardContent>
      </Card>

      <SurrogateEnvsCatalog envs={envs} />

      <Card className="min-w-0" data-capability-source="device">
        <CardContent className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <h3 className="flex items-center gap-3 text-base font-semibold">
                <Monitor className="size-5 shrink-0 text-primary" />
                {t("groupTitles.device")}
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{t(`sourceStates.${caps.sources.device.status}`)}</Badge>
                <span>
                  {caps.sources.device.status === "error" || caps.sources.device.status === "missing"
                    ? "—"
                    : String(deviceItems.length)}{" "}
                  {t("capabilitiesUnit")}
                </span>
              </div>
            </div>
            <NavigationLink href={guide(links.device.doc)} onNavigate={onNavigate}>
              <BookOpen />{t(links.device.label)}
            </NavigationLink>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sourceDescriptions.device")}</p>
          {caps.deviceSnapshot && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {caps.deviceSnapshot.generatedAt ? (
                  <>
                    {t("snapshotAt")}{" "}
                    <time dateTime={caps.deviceSnapshot.generatedAt}>
                      {new Date(caps.deviceSnapshot.generatedAt).toLocaleString()}
                    </time>
                  </>
                ) : (
                  t("snapshotTimeUnknown")
                )}
              </p>
              {caps.deviceSnapshot.drivers.length > 0 && (
                <p className="break-words">
                  {t("recordedDrivers")}:{" "}
                  {caps.deviceSnapshot.drivers
                    .map(driver => `${driver.id}${driver.version ? ` (${driver.version})` : ""}`)
                    .join(", ")}
                </p>
              )}
            </div>
          )}
          {caps.sources.device.status === "error" ? (
            <p className="text-sm text-destructive">{t("sourceFailure")}</p>
          ) : deviceItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sourceEmpty.device")}</p>
          ) : (
            <DeviceCapabilityDeclarations items={deviceItems} title={t("groupTitles.device")} />
          )}
          {caps.sources.device.issueCount > 0 && (
            <p className="text-xs text-muted-foreground">{t("diagnosticsTitle")}: {caps.sources.device.issueCount}</p>
          )}
        </CardContent>
      </Card>

      {caps.issues.length > 0 && <details className="rounded-lg border p-4 text-xs"><summary className="cursor-pointer">{t("diagnosticsTitle")} ({caps.issues.length})</summary><div className="mt-3 space-y-2">{caps.issues.map((issue, index) => <p key={index} className="break-all">{issue.error}</p>)}</div></details>}
      <p className="text-xs text-muted-foreground">{t("checkedAt")} <time dateTime={caps.checkedAt}>{new Date(caps.checkedAt).toLocaleString()}</time></p>
    </>}
    {project && workspace && <ConnectionCheck key={JSON.stringify([project, workspace])} project={project} workspace={workspace} />}
  </div>;
}

export function CapabilitiesView(props: WorkspaceCatalogProps) {
  const t = useTranslations("capabilitiesView");
  return <div className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-6"><header className="space-y-2"><h1>{t("title")}</h1><p className="text-sm leading-relaxed text-muted-foreground">{t("description")}</p></header>
    <WorkspaceCapabilities {...props} />
  </div>;
}
