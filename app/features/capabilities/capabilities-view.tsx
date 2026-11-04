"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  Clock,
  Eye,
  FileCode2,
  FlaskConical,
  History,
  Monitor,
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

function shortSha(sha?: string | null) {
  return sha ? sha.slice(0, 8) : null;
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
                    {Object.entries(item.evalRewards).map(([key, value]) => (
                      <span key={key}>
                        <small>{key}</small>
                        <b>{formatRewardValue(value)}</b>
                      </span>
                    ))}
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
