import type { WorkspaceStorageOverride } from "@ludens/protocol/storage";
import {
  type WorkspaceConfigSummary as CoreWorkspaceConfigSummary,
  type WorkspaceStudioSnapshot as CoreWorkspaceStudioSnapshot,
} from "@ludens/core/core/query/workspaces";

export * from "@ludens/core/core/query/workspaces";

export interface WorkspaceConfigSummary extends Omit<CoreWorkspaceConfigSummary, "storage"> {
  storage?: WorkspaceStorageOverride;
}

export interface WorkspaceStudioSnapshot extends Omit<CoreWorkspaceStudioSnapshot, "config"> {
  config: WorkspaceConfigSummary | null;
}

export interface WorkspaceStudioConfigPatch {
  model?: string;
  serviceTier?: CoreWorkspaceConfigSummary["serviceTier"] | null;
  effort?: CoreWorkspaceConfigSummary["effort"] | null;
  seconds?: number;
  requests?: number;
  compactionThreshold?: number | null;
  diagnostics?: "normal" | "full";
  pet?: boolean;
  dashboard?: boolean;
  port?: number | null;
  game?: string | null;
  cuaCommand?: string | null;
  connection?: CoreWorkspaceConfigSummary["connection"] | null;
  machines?: CoreWorkspaceConfigSummary["machines"] | null;
  storage?: WorkspaceStorageOverride | null;
}
