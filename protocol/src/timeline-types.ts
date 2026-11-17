import type { TimelineArchiveLocation } from "./storage";
export type { TimelineArchiveLocation } from "./storage";

/** A logical image retained as a frame of a workspace-owned video segment. */
export interface VideoFrameReference {
  pts: number;
  timeBase: [number, number];
  width: number;
  height: number;
  status?: "gap";
  reason?: string;
}

export interface TimelineAssetReference {
  asset: string;
  video?: VideoFrameReference;
}

export type TimelineSegmentStatus = "pending" | "ready" | "evicted" | "error";

export interface TimelineVideoStatus {
  status: TimelineSegmentStatus | (string & {});
  format?: string;
  error?: string;
  readableBytes?: number;
  lastReadablePts?: number | null;
  archive?: TimelineArchiveLocation;
  evictedAt?: string;
  evictedReason?: "quota" | "ttl" | "manual" | (string & {});
}

export function hasTimelineArchive(archive: unknown): archive is TimelineArchiveLocation {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) return false;
  const candidate = archive as Record<string, unknown>;
  return (
    (candidate.backend === "directory" || candidate.backend === "s3") &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0
  );
}
