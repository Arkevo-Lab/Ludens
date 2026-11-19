import type { AppRpcParams, ReplayRpcQuery } from "@ludens/protocol/app-rpc";

export type ReplayEvidenceSelection =
  | { kind: "frame"; record: string; sequence: number }
  | { kind: "item"; id: string };

export function replayRpcParams(scope: string, query: ReplayRpcQuery): AppRpcParams<"replay/get"> {
  const search = new URLSearchParams(scope);
  const epoch = search.get("epoch") || undefined;
  return {
    project: search.get("project") ?? "",
    run: search.get("run") ?? "",
    query: {
      ...query,
      ...(epoch && !query.epoch ? { epoch } : {}),
    },
  };
}

export function replayEvidenceParams(scope: string, selection: ReplayEvidenceSelection): AppRpcParams<"replay/get"> {
  return replayRpcParams(
    scope,
    selection.kind === "frame"
      ? { mode: "detail", record: selection.record, sequence: selection.sequence }
      : { mode: "detail", id: selection.id },
  );
}

export function replayEvidenceRequestKey(scope: string, selection: ReplayEvidenceSelection): string {
  const params = replayEvidenceParams(scope, selection);
  return `${params.project}:${params.run}:${params.query.epoch ?? ""}:${selection.kind}:${
    selection.kind === "frame" ? `${selection.record}:${selection.sequence}` : selection.id
  }`;
}
