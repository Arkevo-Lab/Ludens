/** RPC reads wait cleanly when a cold archive build is preparing; abort stops this reader only. */
export type ArchiveProgress = {
  bytes: number;
  totalBytes: number;
  projection?: { position: number; total: number; complete: boolean };
};
export type { ArchiveBuildState } from "./cold-build-protocol";

interface ArchivePreparingLike {
  code?: unknown;
  progress?: unknown;
  data?: { code?: unknown; progress?: unknown };
}

function extractArchivePreparing(error: unknown): { isPreparing: boolean; progress?: ArchiveProgress } {
  if (!error || typeof error !== "object") {
    return { isPreparing: false };
  }
  const err = error as ArchivePreparingLike;
  const code = err.code ?? err.data?.code;
  if (code !== "ARCHIVE_PREPARING") {
    return { isPreparing: false };
  }
  const rawProgress = err.progress ?? err.data?.progress;
  const progress =
    rawProgress && typeof rawProgress === "object"
      ? (rawProgress as ArchiveProgress)
      : undefined;
  return { isPreparing: true, progress };
}

export async function readArchiveJson<T>(
  reader: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  onProgress?: (progress: ArchiveProgress) => void,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await reader(signal);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      const preparing = extractArchivePreparing(error);
      if (!preparing.isPreparing) {
        throw error;
      }
      if (preparing.progress) {
        onProgress?.(preparing.progress);
      }
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        }, 250);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    }
  }
}
