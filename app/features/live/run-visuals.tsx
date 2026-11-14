"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "@/lib/locale";
import { useMediaResolver, useOptionalLudensRpc } from "@/lib/ludens-rpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ObservationMedia } from "@/features/live/observation-media";
import type { Call, Observation, PerceptionSnapshot, RunData, TraceSpan } from "@/lib/types";
import type { TimelineRecordDetail } from "@/lib/timeline-record";
import { requestWait, sseFallbackReason } from "@/lib/transport";
import { requestChartSeries, type RequestChartType } from "@/lib/request-chart";
import { mediaFailureMessage, observationTime, perceptionAgeMs, perceptionStateLabel, samplingDurationMs, selectObservations } from "@/features/live/observation-model";

export const seconds = (ms: number | null | undefined) =>
  ms == null ? "—" : (ms / 1000).toFixed(1) + " s";
export const compactDuration = (ms: number | null | undefined) =>
  ms == null
    ? "—"
    : ms < 1000
      ? `${ms > 0 && ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`
      : `${(ms / 1000).toFixed(1)}s`;
export const percent = (n: number | null | undefined) =>
  n == null ? "—" : (n * 100).toFixed(1) + "%";
export const bytes = (n: number | null | undefined) =>
  n == null ? "—" : (n / 1e6).toFixed(2) + " MB";
export const clockTime = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
export const requestBytes = (c: Call) =>
  c.transport === "websocket" ? c.frameBytes : c.wireBytes;
export const transport = (c: Call, t: (key: string) => string) =>
  c.transport === "websocket"
    ? "WS · " +
      (c.incremental == null ? t("transport.unknown") : c.incremental ? t("transport.incremental") : t("transport.full"))
    : c.transport === "sse"
      ? "SSE"
      : t("transport.unrecorded");
const observationOriginKeys = [
  "prompt_start",
  "tool_batch",
  "explicit",
  "cli",
  "observe_hook",
  "perception",
  "tool_result",
];
export function observationOrigin(origin: string, t: (key: string) => string): string {
  return observationOriginKeys.includes(origin) ? t("origin." + origin) : origin;
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function RequestChart({
  calls,
  type,
  selected,
  onSelect,
}: {
  calls: Call[];
  type: RequestChartType;
  selected?: string;
  onSelect(id: string): void;
}) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const waits = calls.map(requestWait);
  const { values, waitValues, hasData } = requestChartSeries(calls, type);
  if (!hasData) return <p className="request-chart-empty" data-chart-empty={type}>{t(`chart.empty.${type}`)}</p>;
  const maximum =
    type === "cache"
      ? 100
      : Math.max(
          1,
          ...values.filter((v): v is number => v !== null),
          ...waitValues.filter((value): value is number => value !== null),
        ) * 1.15;
  const x = (i: number) => 38 + ((i + 0.5) * 310) / Math.max(1, calls.length);
  const y = (v: number) => 133 - (v / maximum) * 108;
  const color =
    type === "latency"
      ? "var(--gold)"
      : type === "cache"
        ? "var(--sage)"
        : "var(--blue)";
  const segments: string[] = [];
  let path = "";
  values.forEach((value, i) => {
    if (value === null) {
      if (path) segments.push(path);
      path = "";
    } else path += (path ? " L " : "M ") + x(i) + " " + y(value);
  });
  if (path) segments.push(path);
  return (
    <svg
      className="request-chart"
      viewBox="0 0 370 170"
      role="img"
      aria-label={
        type === "latency"
          ? t("chart.ariaLatency")
          : type === "cache"
            ? t("chart.ariaCache")
            : t("chart.ariaBody")
      }
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1="38"
            x2="350"
            y1={y(f * maximum)}
            y2={y(f * maximum)}
            className="chart-grid"
          />
          <text x="29" y={y(f * maximum) + 4} textAnchor="end">
            {(f * maximum).toFixed(type === "body" ? 1 : 0)}
          </text>
        </g>
      ))}
      {type === "latency" &&
        calls.map((c, i) =>
          waitValues[i] === null ? null : (
            <rect
              key={c.id}
              x={x(i) - Math.max(1, 70 / calls.length)}
              y={y(waitValues[i]!)}
              width={Math.max(2, 140 / calls.length)}
              height={Math.max(0, 133 - y(waitValues[i]!))}
              fill="var(--wait)"
            />
          ),
        )}
      {segments.map((d, i) => (
        <path key={i} d={d} stroke={color} strokeWidth="2" fill="none" />
      ))}
      {calls.map((c, i) => (
        <g key={c.id}>
          {c.id === selected && (
            <line
              x1={x(i)}
              x2={x(i)}
              y1="18"
              y2="139"
              stroke="var(--muted-foreground)"
              strokeDasharray="3 4"
            />
          )}
          {values[i] !== null && calls.length < 70 && (
            <circle cx={x(i)} cy={y(values[i]!)} r="2.4" fill={color} />
          )}
          <rect
            className="chart-hit"
            x={x(i) - 155 / calls.length}
            y="16"
            width={310 / calls.length}
            height="124"
            fill="transparent"
            onClick={() => onSelect(c.id)}
          >
            <title>
              {"#" + c.index + " · " + (values[i]?.toFixed(2) ?? t("chart.noData"))}
              {type === "latency" &&
                " · " + waits[i].label + " " + seconds(waits[i].ms)}
            </title>
          </rect>
        </g>
      ))}
      <text x="38" y="158">
        {calls.length ? "#" + calls[0].index : t("chart.noRequests")}
      </text>
      <text x="350" y="158" textAnchor="end">
        {calls.length ? "#" + calls.at(-1)!.index : ""}
      </text>
    </svg>
  );
}

interface TimelineRecordQuery {
  project: string;
  run: string;
  record: string;
  sequence: number;
  source: { call?: string; observation?: string };
}

function TimelineRecordData({ query }: { query: TimelineRecordQuery }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const rpcCtx = useOptionalLudensRpc();
  const [record, setRecord] = useState<TimelineRecordDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!rpcCtx) {
      setError(mediaFailureMessage(0, rootT));
      return;
    }
    const controller = new AbortController();
    void rpcCtx
      .call(
        "run/timelineRecord",
        {
          project: query.project,
          run: query.run,
          record: query.record,
          sequence: query.sequence,
          source: query.source,
        },
        { signal: controller.signal },
      )
      .then(result => {
        if (!controller.signal.aborted) {
          setRecord(result as unknown as TimelineRecordDetail);
        }
      })
      .catch(err => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => controller.abort();
  }, [query.project, query.run, query.record, query.sequence, query.source.call, query.source.observation, rpcCtx, rootT]);
  if (error) return <p role="status">{error}</p>;
  if (!record) return <p role="status">{t("record.loading")}</p>;
  if (record.data === undefined && record.space === undefined) return <p>{t("record.empty")}</p>;
  return <pre className="observation-text">{JSON.stringify({ data: record.data, space: record.space }, null, 2)}</pre>;
}

function TimelineRecordDetails({
  snapshot,
  query,
}: {
  snapshot: PerceptionSnapshot;
  query: TimelineRecordQuery;
}) {
  const t = useTranslations("runVisuals");
  const [open, setOpen] = useState(false);
  const queryKey = `${query.project}:${query.run}:${query.record}:${query.sequence}:${query.source.call ?? query.source.observation ?? ""}`;
  return (
    <details className="observation-metadata" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t("record.summary")} #{snapshot.sequence} · {t("record.detail")}</summary>
      {open && <TimelineRecordData key={queryKey} query={query} />}
    </details>
  );
}

function observationMachineId(o?: Observation): string | null {
  if (!o) return null;
  const ctrl = o.controller?.startsWith("controller/") ? o.controller.slice("controller/".length) : o.controller;
  if (ctrl && ctrl.includes("/")) {
    return ctrl.split("/")[0] || null;
  }
  const sources = o.perception?.snapshot?.sources;
  if (Array.isArray(sources)) {
    for (const src of sources) {
      if (src && typeof src === "object") {
        const rec = src as Record<string, unknown>;
        if (typeof rec.machineId === "string" && rec.machineId) return rec.machineId;
        if (typeof rec.controllerId === "string" && rec.controllerId.includes("/")) {
          const stripped = rec.controllerId.startsWith("controller/")
            ? rec.controllerId.slice("controller/".length)
            : rec.controllerId;
          if (stripped.includes("/")) return stripped.split("/")[0] || null;
        }
      }
    }
  }
  return null;
}

function cleanErrorPrefix(message: string): string {
  return message.replace(/(?:LudensError:\s*|Error:\s*)+/gi, "").trim() || message;
}

function formatAgeSpan(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec >= 3600) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec}s`;
}

export function ObservationPanel({
  data,
  call,
  latestCall,
  selectedImage,
  onImage,
  onOpenReplayAt,
  compact = false,
  priority = false,
}: {
  data: RunData;
  call?: Call;
  latestCall?: Call;
  selectedImage?: string;
  onImage(id: string): void;
  onOpenReplayAt?: (frame: { run?: string; at?: number; record: string; sequence: number }) => void;
  compact?: boolean;
  priority?: boolean;
}) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const { inputs, others, observation, showingInput } = selectObservations(
    data.observations, call, selectedImage,
  );
  const machineStreams = (() => {
    const byMachine = new Map<string, Observation>();
    for (const item of [...inputs, ...others, ...data.observations]) {
      const mId = observationMachineId(item);
      if (mId) byMachine.set(mId, item);
    }
    return [...byMachine.entries()].map(([machineId, latestObs]) => ({ machineId, latestObs }));
  })();
  const activeMachineId = observationMachineId(observation);
  const text = showingInput ? call?.inputText : observation?.text;
  const perception = observation?.perception ?? (showingInput ? call?.perception : undefined);
  const snapshot = perception?.snapshot;
  const recordRead = showingInput ? call?.perception : perception;
  const reads = showingInput ? call?.perceptionReads ?? (recordRead ? [recordRead] : []) : recordRead ? [recordRead] : [];
  const records = [...new Map(reads.filter(read => !read.deliveryError).flatMap(read => read.records?.map(record => record.snapshot)
    ?? (read.snapshot ? [read.snapshot] : [])).filter(record => record.timeline)
    .map(record => [record.timeline!.recordId, record])).values()];
  const age = perceptionAgeMs(perception);
  const samplingMs = samplingDurationMs(snapshot);
  const timestamp = (o: Observation) => o.perception ? o.perception.snapshot?.recordedAt : o.at;
  const duration = (ms: number | null | undefined) => ms != null && ms < 1000
    ? ms.toFixed(1) + " ms" : seconds(ms);
  const mediaResolver = useMediaResolver();
  const media = (o: Observation) =>
    mediaResolver.resolve({ kind: "asset", project: data.project, run: data.run, id: o.id }) ?? "";
  const samples = (items: Observation[], label: string) => (
    <div className="sample-strip">
      {items.map((o) => (
        <button
          type="button"
          key={o.id}
          className={"sample focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" + (o.id === observation?.id ? " selected" : "")}
          onClick={() => onImage(o.id)}
          aria-pressed={o.id === observation?.id}
          title={[o.controller, timestamp(o)].filter(Boolean).join(" · ")}
        >
          <ObservationMedia key={media(o)} observation={o} url={media(o)} thumbnail />
          <small>
            {observationMachineId(o) ? `[${observationMachineId(o)}] ` : ""}
            {o.mediaStorage === "unrecorded" ? t("panel.unrecorded") : label}
          </small>
          <small>{observationTime(timestamp(o), rootT)}</small>
        </button>
      ))}
    </div>
  );
  const readDetails = (<>
      {data.perception && (
        <div className="screen-meta">
          <span>{t("panel.perceptionProcess")} · {perceptionStateLabel(data.perception.state, rootT)}</span>
          {data.perception.pid && <span>PID {data.perception.pid}</span>}
          {data.perception.generation && <span title={data.perception.generation}>{t("panel.generation")} {data.perception.generation.slice(0, 8)}</span>}
          {data.perception.codeSHA && <span title={data.perception.codeSHA}>{t("panel.version")} {data.perception.codeSHA.slice(0, 8)}</span>}
        </div>
      )}
      {perception && (
        <details className="observation-metadata" open={perception.ok === false || !!perception.deliveryError}>
          <summary>
            {t("panel.thisQuery")} · {perception.ok === true ? t("panel.querySuccess") : perception.ok === false ? t("panel.queryFailed") : t("panel.queryUnknown")}
            {perception.deliveryError ? " · " + t("panel.deliveryFailed") : ""}
            {perception.legacyRepeated === true ? " · " + t("panel.legacyRepeated") : ""}
          </summary>
          <dl className="fact-grid">
            <div><dt>{t("fact.readMs")}</dt><dd>{duration(perception.durationMs)}</dd></div>
            <div><dt>{t("fact.ageAtRead")}</dt><dd>{age === null ? t("unknown") : seconds(age)}</dd></div>
            <div><dt>{t("fact.recordedAt")}</dt><dd title={snapshot?.recordedAt}>{observationTime(snapshot?.recordedAt, rootT)}</dd></div>
            <div><dt>{t("fact.samplingMs")}</dt><dd title={snapshot?.sampling?.clock}>{samplingMs === null ? t("unknown") : duration(samplingMs)}</dd></div>
            <div><dt>{t("fact.generation")}</dt><dd title={snapshot?.generation ?? undefined}>{snapshot?.generation?.slice(0, 12) ?? t("unknown")}</dd></div>
            <div><dt>{t("fact.sourceTime")}</dt><dd title={snapshot?.sampledAt}>{observationTime(snapshot?.sampledAt, rootT)}</dd></div>
            {snapshot && <div><dt>{t("fact.sequence")}</dt><dd>{snapshot.sequence}</dd></div>}
          </dl>
          {perception.query && <details>
            <summary>{t("panel.readRange")}{perception.hasMore ? " · " + t("panel.hasMore") : ""}</summary>
            <pre className="observation-text">{JSON.stringify({ query: perception.query,
              hasMore: perception.hasMore, nextAfter: perception.nextAfter, availability: perception.availability }, null, 2)}</pre>
          </details>}
          {(perception.deliveryError || perception.error || perception.status?.error) && (
            <pre className="observation-text">{perception.deliveryError || perception.error || perception.status?.error}</pre>
          )}
          {snapshot?.sources && (
            <details>
              <summary>{t("panel.samplingSources")}</summary>
              <pre className="observation-text">{JSON.stringify(snapshot.sources, null, 2)}</pre>
            </details>
          )}
        </details>
      )}
      {records.map(record => (
        <TimelineRecordDetails
          key={record.timeline!.recordId}
          snapshot={record}
          query={{
            project: data.project,
            run: data.run,
            record: record.timeline!.recordId,
            sequence: record.timeline!.sequence,
            source: showingInput && call
              ? { call: call.id }
              : observation
                ? { observation: observation.id }
                : {},
          }}
        />
      ))}
    </>);
  return (
    <section
      className={"surface observation-panel" + (compact ? " compact" : "") + (priority ? " observation-priority" : "")}
    >
      <div className="surface-heading">
        <h2>{showingInput ? t("panel.inputTitle") : t("panel.samplesTitle")}</h2>
        <span>
          {call
            ? t("panel.request") +
              " #" +
              String(call.index).padStart(3, "0") +
              (latestCall && latestCall.id !== call.id
                ? t("panel.latestRequestSuffix").replace("{number}", String(latestCall.index).padStart(3, "0"))
                : "")
            : t("panel.waitingRequest")}
        </span>
      </div>
      {priority &&
        latestCall &&
        call &&
        latestCall.id !== call.id &&
        (latestCall.perception?.ok === false || Boolean(latestCall.perception?.deliveryError)) && (
          <p className="observation-query-warning" role="status">
            {t("panel.newerFailurePrefix").replace("{number}", String(latestCall.index).padStart(3, "0"))}
            {cleanErrorPrefix(
              latestCall.perception?.deliveryError ||
                latestCall.perception?.error ||
                t("panel.queryFailed"),
            )}
            {t("panel.keepingLastVisual").replace("{number}", String(call.index).padStart(3, "0"))}
          </p>
        )}
      {priority && (perception?.ok === false || perception?.deliveryError || data.perception?.state === "error") && (
        <p className="observation-query-warning" role="status">
          {perception?.deliveryError
            ? cleanErrorPrefix(perception.deliveryError)
            : perception?.ok === false
              ? t("panel.thisQuery") + " · " + t("panel.queryFailed")
              : t("panel.perceptionProcess") + " · " + perceptionStateLabel("error", rootT)}
          {" · " + t("panel.detailsBelow")}
        </p>
      )}
      {!priority && readDetails}
      {machineStreams.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1.5 px-3 pb-2 text-xs"
          role="group"
          aria-label="Multi-Machine Observation Streams"
          data-observation-machine-streams
        >
          {machineStreams.map(({ machineId, latestObs }) => {
            const isSelectedMachine = activeMachineId === machineId;
            return (
              <button
                key={machineId}
                type="button"
                onClick={() => onImage(latestObs.id)}
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors " +
                  (isSelectedMachine
                    ? "border-primary bg-primary/15 font-semibold text-primary"
                    : "border-border/70 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground")
                }
              >
                <span className={"size-1.5 rounded-full " + (isSelectedMachine ? "bg-primary" : "bg-muted-foreground")} />
                <span>{machineId}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className={"screen" + (priority && (!observation || !observation.mediaType.startsWith("image/") || observation.mediaStorage === "unrecorded") ? " screen-content" : "")}>
        {observation ? (
          <ObservationMedia
            key={data.project + ":" + data.run}
            observation={observation}
            url={media(observation)}
            prefetchUrls={inputs
              .filter(item => item.id !== observation.id && item.mediaStorage !== "unrecorded" && item.mediaType.startsWith("image/"))
              .slice(0, 6)
              .map(media)
              .filter(Boolean)}
            alt={(showingInput ? t("panel.altInput") : t("panel.altSaved")) + " · " + observation.controller + " · " + observationTime(timestamp(observation), rootT)}
          />
        ) : text ? (
          <pre className="observation-text">{text}</pre>
        ) : records.length ? (
          <p>{t("panel.recordsPrefix")} {records.length} {t("panel.recordsSuffix")}</p>
        ) : (
          <div className="empty-state">
            <span className="empty-symbol">◫</span>
            <h3>{call ? t("empty.noInput") : t("empty.waiting")}</h3>
            <p>{perception?.status?.state === "unimplemented"
              ? t("empty.unimplementedHint")
              : t("empty.hint")}</p>
          </div>
        )}
      </div>
      <div className="screen-meta">
        {activeMachineId && (
          <span className="rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary" data-observation-machine={activeMachineId}>
            {activeMachineId}
          </span>
        )}
        <span>
          {observation
            ? (() => {
                const ts = timestamp(observation);
                const obsMs = ts ? Date.parse(ts) : NaN;
                const refMs = Date.parse(data.updatedAt);
                const hasValidTime = Number.isFinite(obsMs);
                const ageDelta =
                  priority && hasValidTime && Number.isFinite(refMs) && refMs - obsMs >= 15_000
                    ? ` · ${formatAgeSpan(refMs - obsMs)}${t("meta.agoSuffix")}`
                    : "";
                return (
                  observationOrigin(observation.origin, t) +
                  (hasValidTime
                    ? " · " +
                      (observation.perception ? t("meta.recordedAt") : "") +
                      observationTime(ts, rootT) +
                      ageDelta
                    : "")
                );
              })()
            : text ? t("meta.textObservation") : records.length ? t("meta.records") : t("meta.noMedia")}
        </span>
        {onOpenReplayAt &&
          (snapshot?.timeline?.recordId ?? observation?.timeline?.recordId) &&
          (snapshot?.timeline?.sequence ?? observation?.timeline?.sequence) != null && (
            <button
              type="button"
              className="codex-replay-jump-link"
              onClick={() => {
                const rawTs = (observation ? timestamp(observation) : undefined) ?? snapshot?.recordedAt;
                const parsedAt = rawTs ? Date.parse(rawTs) : NaN;
                onOpenReplayAt({
                  run: data.run,
                  at: Number.isFinite(parsedAt) ? parsedAt : undefined,
                  record: (snapshot?.timeline?.recordId ?? observation?.timeline?.recordId)!,
                  sequence: Number(snapshot?.timeline?.sequence ?? observation?.timeline?.sequence),
                });
              }}
            >
              ⏱ {observationTime(timestamp(observation!) ?? snapshot?.recordedAt, rootT)} ↗
            </button>
          )}
        {observation?.sourceSequence != null && (
          <span>{t("meta.sourceFrame")} {observation.sourceSequence}</span>
        )}
        {observation?.timeline?.video && <span>{t("meta.videoRestore")}</span>}
        {!showingInput && (
          <Button type="button" variant="ghost" size="xs" onClick={() => onImage("")}>
            {t("meta.backToInput")}
          </Button>
        )}
      </div>
      {priority ? inputs.length > 1 && (
        <details className="observation-metadata observation-inputs">
          <summary>{t("panel.modelInput")} · {inputs.length}</summary>
          {samples(inputs, t("panel.modelInput"))}
        </details>
      ) : !!inputs.length && samples(inputs, t("panel.modelInput"))}
      {priority && (data.perception || perception || records.length > 0) && (
        <details className="observation-metadata observation-diagnostics">
          <summary>{t("panel.perceptionDetails")}</summary>
          {readDetails}
        </details>
      )}
      {observation && text && (
        <details className="observation-metadata">
          <summary>{showingInput ? t("panel.textWithObservation") : t("panel.observationText")}</summary>
          <pre className="observation-text">{text}</pre>
        </details>
      )}
      {!!others.length && (
        <details className="observation-metadata">
          <summary>{t("panel.otherSamples")} · {others.length}</summary>
          <p>{t("panel.otherHint")}</p>
          {samples(others, t("panel.recorded"))}
        </details>
      )}
      {observation && (
        <details className="observation-metadata">
          <summary>
            {t("panel.observationDetails")} <span>{observation.controller}</span>
          </summary>
          <dl className="fact-grid">
            {observation.hook && (
              <div>
                <dt>{t("panel.observeVersion")}</dt>
                <dd title={observation.hook.codeSHA}>{observation.hook.codeSHA.slice(0, 12)}</dd>
              </div>
            )}
            <div>
              <dt>{t("panel.capture")}</dt>
              <dd>{seconds(observation.captureMs)}</dd>
            </div>
            <div>
              <dt>{t("panel.encode")}</dt>
              <dd>{seconds(observation.encodeMs)}</dd>
            </div>
            <div>
              <dt>{t("panel.frameDelta")}</dt>
              <dd>{observation.sourceSequenceDelta ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("panel.afterExecution")}</dt>
              <dd>
                {observation.afterExecutionMs == null
                  ? "—"
                  : observation.afterExecutionMs.toFixed(1) + " ms"}
              </dd>
            </div>
          </dl>
          {observation.request && (
            <pre>{JSON.stringify(observation.request, null, 2)}</pre>
          )}
        </details>
      )}
    </section>
  );
}

function TraceList({ data, call }: { data: RunData; call?: Call }) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const all = data.telemetry.spans;
  const selected = call ? all.filter((s) => s.modelCallId === call.id) : all;
  const roots = new Set(selected.map((s) => s.traceId + ":" + s.spanId));
  // Expand explicit descendants; native spans may not all carry the business request ID.
  const visible = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of all)
      if (
        s.parentSpanId &&
        visible.has(s.traceId + ":" + s.parentSpanId) &&
        !visible.has(s.traceId + ":" + s.spanId)
      ) {
        visible.add(s.traceId + ":" + s.spanId);
        changed = true;
      }
  }
  // Include parents after descendants, without pulling in sibling requests.
  changed = true;
  while (changed) {
    changed = false;
    for (const s of all)
      if (
        visible.has(s.traceId + ":" + s.spanId) &&
        s.parentSpanId &&
        !visible.has(s.traceId + ":" + s.parentSpanId)
      ) {
        visible.add(s.traceId + ":" + s.parentSpanId);
        changed = true;
      }
  }
  const spans = all.filter((s) => visible.has(s.traceId + ":" + s.spanId));
  const primary = spans.filter(
    (s) =>
      s.kind !== "python" ||
      !spans.some(
        (p) =>
          p.kind === "capability" &&
          p.spanId === s.spanId &&
          p.traceId === s.traceId,
      ),
  );
  const depth = (s: TraceSpan) => {
    let n = 0,
      parent = s.parentSpanId;
    const seen = new Set([s.spanId]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const p = primary.find(
        (a) => a.traceId === s.traceId && a.spanId === parent,
      );
      if (!p) break;
      n++;
      parent = p.parentSpanId;
    }
    return Math.min(5, n);
  };
  return (
    <>
      <p className="help-text">
        {t("trace.help")}
      </p>
      {!primary.length ? (
        <div className="empty-state">
          <h3>{t("trace.emptyTitle")}</h3>
          <p>{t("trace.emptyHint")}</p>
        </div>
      ) : (
        <div className="trace-list">
          {primary.map((s) => (
            <details
              className="trace-row"
              key={s.id}
              style={{ marginLeft: depth(s) * 15 }}
            >
              <summary>
                <span
                  className={"source-dot " + (s.source?.component ?? "unknown")}
                />
                <span className="trace-name">
                  <b>{s.name}</b>
                  <small>
                    {s.source?.component ?? t("trace.unknownSource")} · {s.kind}
                  </small>
                </span>
                <span className="mono">{seconds(s.durationMs)}</span>
                <span className={"outcome " + (s.kind === "python-local" && s.outcome === "error" ? "unknown" : s.outcome)}>
                  {s.kind === "python-local" && s.outcome === "error" ? t("trace.threw")
                    : s.outcome === "success" && s.kind === "compaction"
                    ? s.operation === "maintenance"
                      ? t("trace.maintenanceDone")
                      : t("trace.candidateReady")
                    : s.outcome === "success" && s.kind === "compaction-http"
                      ? t("trace.headersArrived")
                      : t("outcome." + s.outcome)}
                </span>
              </summary>
              <dl className="fact-grid">
                <div>
                  <dt>Trace</dt>
                  <dd>{s.traceId}</dd>
                </div>
                <div>
                  <dt>Span</dt>
                  <dd>{s.spanId}</dd>
                </div>
                {s.operationId && (
                  <div>
                    <dt>Operation</dt>
                    <dd>{s.operationId}</dd>
                  </div>
                )}
                <div>
                  <dt>{t("trace.startedAt")}</dt>
                  <dd>{clockTime(s.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t("trace.sourceEvents")}</dt>
                  <dd>
                    #{s.startSeq} →{" "}
                    {s.endSeq == null ? t("trace.waitingFinal") : "#" + s.endSeq}
                  </dd>
                </div>
                {s.rpc && (
                  <div>
                    <dt>Client RPC</dt>
                    <dd>
                      {s.rpc.calls} calls · {s.rpc.controllerCalls} ctrl · {s.rpc.observeCalls} obs · {seconds(s.rpc.durationMs)}
                    </dd>
                  </div>
                )}
                {s.timing && (
                  <div>
                    <dt>Timing</dt>
                    <dd>
                      import {s.timing.importDurationMs ?? 0} ms · exec {s.timing.executionDurationMs ?? 0} ms
                    </dd>
                  </div>
                )}
              </dl>
              {s.kind === "python-local" && s.outcome === "error" && <p className="help-text">{t("trace.pythonLocalNote")}</p>}
              {s.error && <pre className={s.kind === "python-local" ? "help-text" : "error-text"}>{s.error}</pre>}
              {spans
                .filter(
                  (p) =>
                    p.kind === "python" &&
                    p.traceId === s.traceId &&
                    p.spanId === s.spanId,
                )
                .map((p) => (
                  <p className="help-text" key={p.id}>
                    Python · {p.name}{" "}
                    {p.codeSHA && "· " + p.codeSHA.slice(0, 12)}
                  </p>
                ))}
            </details>
          ))}
        </div>
      )}
    </>
  );
}

export function RequestDetails({
  data,
  call,
  panel,
  onPanel,
  onSelect,
  onInspect,
}: {
  data: RunData;
  call?: Call;
  panel: string;
  onPanel(tab: string): void;
  onSelect(id: string): void;
  onInspect(): void;
}) {
  const t = useTranslations("runVisuals");
  const { t: rootT } = useLocale();
  const fallback = call
    ? sseFallbackReason(call, Date.parse(data.updatedAt))
    : null;
  const wait = call ? requestWait(call) : null;
  const activePanel = ["trace", "tools", "skills", "events"].includes(panel) ? panel : "events";
  return (
    <section className="surface request-details">
      <div className="surface-heading">
        <h2>
          {call ? t("panel.request") + " #" + String(call.index).padStart(3, "0") : t("request.runEvidence")}
        </h2>
        <Button type="button" variant="ghost" size="xs" onClick={onInspect}>
          {t("request.viewImage")}
        </Button>
      </div>
      {call && (
        <>
          <div className="request-facts">
            <div>
              <span>{t("request.totalTime")}</span>
              <strong>{seconds(call.durationMs)}</strong>
            </div>
            <div>
              <span>{wait!.label}</span>
              <strong>{seconds(wait!.ms)}</strong>
            </div>
            <div>
              <span>
                {call.transport === "websocket"
                  ? t("request.afterFirstEvent")
                  : t("request.afterHeaders")}
              </span>
              <strong>
                {seconds(
                  call.transport === "websocket"
                    ? call.phases.afterFirstStreamMs
                    : call.phases.afterHeadersMs,
                )}
              </strong>
            </div>
            <div>
              <span>{t("request.body")}</span>
              <strong>{bytes(requestBytes(call))}</strong>
            </div>
            <div>
              <span>{t("request.cacheHit")}</span>
              <strong>{percent(call.cacheHit)}</strong>
            </div>
            <div>
              <span>{t("request.decodeSpeed")}</span>
              <strong>{call.outputTokensPerSecond != null ? `${call.outputTokensPerSecond.toFixed(1)} tok/s` : "—"}</strong>
            </div>
          </div>
          <p className="request-caption">
            {transport(call, t)} · {t("request.input")} {call.inputTokens.toLocaleString()} tokens
            {call.outputTokens != null ? ` · ${t("request.output")} ${call.outputTokens.toLocaleString()} tokens` : ""}{" "}
            ·{" "}
            {call.transport === "websocket"
              ? call.wsFrames + " " + t("request.frames")
              : call.attempts + " " + t("request.attempts")}{" "}
            · {clockTime(call.at)}
            {fallback && " · " + t("request.sseFallback") + fallback}
          </p>
        </>
      )}
      <Tabs value={activePanel} onValueChange={onPanel} className="gap-0">
        <div className="overflow-x-auto overflow-y-hidden border-y border-[var(--line)] bg-[var(--surface-inset)]">
          <TabsList variant="line" className="h-10 w-max min-w-full justify-start gap-2 rounded-none px-4" aria-label={t("request.evidenceLabel")}>
            {[
              ["trace", t("tabs.trace")],
              ["tools", t("tabs.tools")],
              ["skills", t("tabs.skills")],
              ["events", t("tabs.events")],
            ].map(([id, text]) => (
              <TabsTrigger
                type="button"
                value={id}
                className="flex-none h-10 rounded-none px-3 text-xs data-[state=active]:text-[var(--gold)] after:!bottom-0 after:!bg-[var(--gold)]"
                onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
                key={id}
              >
                {text}
                {id === "events" && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] tabular-nums">{data.notices.length}</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="trace" className="detail-body">
          <TraceList data={data} call={call} />
        </TabsContent>
        <TabsContent value="tools" className="detail-body">
          {call?.tools.map((tool) => (
            <article className="tool-evidence" key={tool.id}>
              <div className="evidence-heading">
                <b>{tool.name}</b>
                <Badge variant={tool.ok === false ? "destructive" : "outline"} className="px-1.5 py-0 text-[10px]">
                  {tool.ok == null ? t("tools.running") : tool.ok ? t("outcome.success") : t("outcome.error")}
                </Badge>
              </div>
              {tool.intent && <p>{tool.intent}</p>}
              <pre>{tool.args.command ?? JSON.stringify(tool.args, null, 2)}</pre>
              <p className="help-text">
                {tool.name === "exec" &&
                  t("tools.execPrefix") + " " + seconds(tool.commandMs) + " · "}
                {t("tools.wholeTool")} {seconds(tool.durationMs)}
                {tool.name === "bash"
                  ? t("tools.bashNote")
                  : t("tools.genericNote")}
              </p>
            </article>
          ))}
          {!call?.tools.length && (
            <p className="empty-state">{t("tools.empty")}</p>
          )}
          <p className="help-text">
            {t("tools.waitNote")}
          </p>
        </TabsContent>
        <TabsContent value="skills" className="detail-body">
          <p className="help-text">{t("skills.help")}</p>
          {[...data.skills].reverse().map((e) => (
            <button
              type="button"
              className="evidence-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={e.seq}
              onClick={() => e.modelCallId && onSelect(e.modelCallId)}
            >
              <Badge variant="outline" className="rounded px-1.5 py-0.5 font-mono text-[10px]">{e.action}</Badge>
              <span>
                <b>{e.path}</b>
                <small>
                  {clockTime(e.at)} ·{" "}
                  {e.ok == null ? t("tools.running") : e.ok ? t("outcome.success") : t("outcome.error")}
                  {e.hash ? " · " + e.hash.slice(0, 12) : ""}
                </small>
              </span>
              <span>↗</span>
            </button>
          ))}
          {!data.skills.length && (
            <p className="empty-state">{t("skills.empty")}</p>
          )}
          <p className="help-text">{t("skills.hint")}</p>
        </TabsContent>
        <TabsContent value="events" className="detail-body">
          <p className="help-text">{t("events.help")}</p>
          {[...data.notices].reverse().map((n) => (
            <button
              type="button"
              className="evidence-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={n.seq}
              onClick={() => n.modelCallId && onSelect(n.modelCallId)}
            >
              <span className={"notice-dot" + (n.failed ? " failed" : "")} />
              <span>
                <b>{n.type}</b>
                <p>{n.text}</p>
                {n.details && (
                  <dl className="fact-grid">
                    {n.details.map((d) => (
                      <div key={d.label}>
                        <dt>{d.label}</dt>
                        <dd>{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <small>{clockTime(n.at)}</small>
              </span>
            </button>
          ))}
          {!data.notices.length && (
            <p className="empty-state">{t("events.empty")}</p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
