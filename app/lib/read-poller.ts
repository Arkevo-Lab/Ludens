export interface ReadPollerOptions {
  /** Multiplier applied to non-zero poll delays while `document.visibilityState === "hidden"`. Default: 4. */
  hiddenMultiplier?: number;
  /** Minimum delay (ms) while the document is hidden. Default: 10000. */
  hiddenMinDelayMs?: number;
}

/** Schedule read-only snapshots without treating a pause as a new selection. */
export class ReadPoller {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private pendingImmediate = false;
  private enabled: boolean;
  private readonly hiddenMultiplier: number;
  private readonly hiddenMinDelayMs: number;
  private readonly removeVisibilityListener?: () => void;

  constructor(
    private read: (signal: AbortSignal) => Promise<number>,
    enabled: boolean,
    options: ReadPollerOptions = {},
  ) {
    this.enabled = enabled;
    this.hiddenMultiplier = options.hiddenMultiplier ?? 4;
    this.hiddenMinDelayMs = options.hiddenMinDelayMs ?? 10_000;

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const onVisibilityChange = () => {
        if (this.controller.signal.aborted || !this.enabled) return;
        if (document.visibilityState === "visible") {
          void this.readOnce();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      this.removeVisibilityListener = () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }
  }

  private effectiveDelay(delay: number): number {
    if (delay <= 0) return 0;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      this.hiddenMultiplier > 1
    ) {
      return Math.max(this.hiddenMinDelayMs, Math.round(delay * this.hiddenMultiplier));
    }
    return delay;
  }

  /** Explicit selection/reset reads are allowed even while automatic refresh is paused. */
  async readOnce() {
    if (this.running || this.controller.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    let delay = 2500;
    try {
      delay = await this.read(this.controller.signal);
    } finally {
      this.running = false;
      if (!this.controller.signal.aborted) {
        if (this.pendingImmediate) {
          this.pendingImmediate = false;
          void this.readOnce();
        } else if (this.enabled) {
          const nextDelay = this.effectiveDelay(delay);
          this.timer = setTimeout(() => {
            void this.readOnce();
          }, nextDelay);
        }
      }
    }
  }

  /** Trigger a fresh read immediately, or queue one right after an already-in-flight read finishes. */
  nudge() {
    if (this.controller.signal.aborted) return;
    if (this.running) {
      this.pendingImmediate = true;
      return;
    }
    void this.readOnce();
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled || this.controller.signal.aborted) return;
    this.enabled = enabled;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (enabled) void this.readOnce();
  }

  dispose() {
    this.pendingImmediate = false;
    this.removeVisibilityListener?.();
    this.controller.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
