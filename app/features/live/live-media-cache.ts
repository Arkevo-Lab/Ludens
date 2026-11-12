"use client";

import { createElement, useEffect, useRef, useState } from "react";

export interface LiveMediaLease {
  objectUrl: string;
  release(): void;
}

interface CacheEntry {
  url: string;
  objectUrl: string;
  byteLength: number;
  refCount: number;
}

interface Waiter {
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: (objectUrl: string) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

interface InFlightRequest {
  url: string;
  controller: AbortController;
  waiters: Set<Waiter>;
  started: boolean;
}

export interface LiveMediaCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxConcurrent?: number;
  fetchImpl?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (objectUrl: string) => void;
}

function makeAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Reference-counted LRU Blob URL cache + bounded concurrency fetch queue for Live observation media.
 *
 * Guarantees:
 * - Mounted images hold `refCount > 0` and are NEVER revoked by LRU eviction (`URL.revokeObjectURL` only runs when `refCount === 0`).
 * - In-flight requests for the same URL are coalesced; underlying `fetch` only aborts when ALL subscribers abort.
 * - Queued requests scrolled past before starting are cancelled in `O(1)` without touching `/api/media` or `dashboardWorker`.
 * - Failed HTTP / network reads are NEVER negative-cached so explicit retries always hit the server cleanly.
 */
export class LiveMediaCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly fetchImpl: typeof fetch;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (objectUrl: string) => void;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly queue: InFlightRequest[] = [];
  private totalBytes = 0;
  private activeCount = 0;

  constructor(options: LiveMediaCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 160;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.createObjectUrl = options.createObjectUrl ?? (blob => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? (url => URL.revokeObjectURL(url));
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  refCountOf(url: string): number {
    return this.entries.get(url)?.refCount ?? 0;
  }

  /** Synchronous cache probe without incrementing `refCount` (touches LRU order on hit). */
  peek(url: string): string | null {
    const entry = this.entries.get(url);
    if (!entry) return null;
    this.touch(entry);
    return entry.objectUrl;
  }

  /** Synchronously acquires a lease if `url` is already cached; returns `null` on miss. */
  retain(url: string): LiveMediaLease | null {
    const entry = this.entries.get(url);
    if (!entry) return null;
    entry.refCount += 1;
    this.touch(entry);
    return this.createLease(entry);
  }

  /** Acquires a ref-counted `objectUrl` lease for `url`, coalescing concurrent reads. */
  acquire(url: string, signal?: AbortSignal): Promise<LiveMediaLease> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? makeAbortError());
    }
    const warm = this.retain(url);
    if (warm) {
      return Promise.resolve(warm);
    }

    return new Promise<string>((resolve, reject) => {
      let req = this.inFlight.get(url);
      if (!req) {
        req = {
          url,
          controller: new AbortController(),
          waiters: new Set(),
          started: false,
        };
        this.inFlight.set(url, req);
        this.queue.push(req);
      }

      const waiter: Waiter = {
        signal,
        settled: false,
        resolve,
        reject,
        onAbort: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          req!.waiters.delete(waiter);
          reject(signal?.reason ?? makeAbortError());
          if (req!.waiters.size === 0) {
            this.cancelRequest(req!);
          }
        },
      };

      req.waiters.add(waiter);
      if (signal) {
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.pumpQueue();
    }).then(objectUrl => {
      const entry = this.entries.get(url);
      if (entry && entry.objectUrl === objectUrl) {
        return this.createLease(entry);
      }
      let released = false;
      return {
        objectUrl,
        release: () => {
          if (released) return;
          released = true;
        },
      };
    });
  }

  /** Clears unpinned entries (or all entries when `force = true`). */
  clear(force = false): void {
    for (const req of [...this.inFlight.values()]) {
      this.cancelRequest(req);
    }
    this.queue.length = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (!force && entry.refCount > 0) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.byteLength;
      this.revokeObjectUrl(entry.objectUrl);
    }
  }

  /** Evicts a corrupt/undecodable entry so subsequent retries fetch cleanly from `/api/media`. */
  invalidate(url: string, expectedObjectUrl?: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    if (expectedObjectUrl && entry.objectUrl !== expectedObjectUrl) return;
    this.entries.delete(url);
    this.totalBytes -= entry.byteLength;
    this.revokeObjectUrl(entry.objectUrl);
  }

  private touch(entry: CacheEntry): void {
    this.entries.delete(entry.url);
    this.entries.set(entry.url, entry);
  }

  private createLease(entry: CacheEntry): LiveMediaLease {
    let released = false;
    return {
      objectUrl: entry.objectUrl,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(entry.url);
        if (!current || current !== entry) return;
        current.refCount = Math.max(0, current.refCount - 1);
        if (current.refCount === 0) {
          this.evictIfNeeded();
        }
      },
    };
  }

  private cancelRequest(req: InFlightRequest): void {
    if (this.inFlight.get(req.url) === req) {
      this.inFlight.delete(req.url);
    }
    if (!req.started) {
      const qIdx = this.queue.indexOf(req);
      if (qIdx >= 0) this.queue.splice(qIdx, 1);
    }
    req.controller.abort();
    for (const waiter of [...req.waiters]) {
      if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.reject(makeAbortError());
      }
    }
    req.waiters.clear();
  }

  private pumpQueue(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.waiters.size === 0 || next.controller.signal.aborted) {
        if (this.inFlight.get(next.url) === next) {
          this.inFlight.delete(next.url);
        }
        continue;
      }
      next.started = true;
      this.activeCount += 1;
      void this.executeFetch(next).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.pumpQueue();
      });
    }
  }

  private async executeFetch(req: InFlightRequest): Promise<void> {
    const { url, controller } = req;
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (controller.signal.aborted || req.waiters.size === 0) {
        await response.body?.cancel().catch(() => {});
        throw makeAbortError();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`Media read failed (${response.status})`), {
          httpStatus: response.status,
        });
      }
      const blob = await response.blob();
      if (controller.signal.aborted || req.waiters.size === 0) {
        throw makeAbortError();
      }

      const activeWaiters = [...req.waiters].filter(w => !w.settled && !w.signal?.aborted);
      if (this.inFlight.get(url) === req) {
        this.inFlight.delete(url);
      }
      for (const waiter of req.waiters) {
        if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      req.waiters.clear();

      if (activeWaiters.length === 0) return;

      const existing = this.entries.get(url);
      let targetEntry: CacheEntry;
      if (existing) {
        existing.refCount += activeWaiters.length;
        this.touch(existing);
        targetEntry = existing;
      } else {
        const objectUrl = this.createObjectUrl(blob);
        targetEntry = {
          url,
          objectUrl,
          byteLength: Math.max(1, blob.size || 0),
          refCount: activeWaiters.length,
        };
        this.entries.set(url, targetEntry);
        this.totalBytes += targetEntry.byteLength;
        this.evictIfNeeded();
      }

      for (const waiter of activeWaiters) {
        waiter.settled = true;
        waiter.resolve(targetEntry.objectUrl);
      }
    } catch (error) {
      if (this.inFlight.get(url) === req) {
        this.inFlight.delete(url);
      }
      const pending = [...req.waiters];
      req.waiters.clear();
      for (const waiter of pending) {
        if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (!waiter.settled) {
          waiter.settled = true;
          waiter.reject(error);
        }
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      // Guardrail: NEVER revoke an object URL while at least one DOM node still holds a lease.
      if (entry.refCount > 0) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.byteLength;
      this.revokeObjectUrl(entry.objectUrl);
    }
  }
}

export const liveMediaCache = new LiveMediaCache();

const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type ObserverCallback = () => void;
let sharedObserver: IntersectionObserver | null = null;
const observedElements = new WeakMap<Element, ObserverCallback>();

function observeViewportEntry(element: Element, onEnter: ObserverCallback): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onEnter();
    return () => {};
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cb = observedElements.get(entry.target);
          if (cb) {
            sharedObserver?.unobserve(entry.target);
            observedElements.delete(entry.target);
            cb();
          }
        }
      },
      { rootMargin: "360px 0px" },
    );
  }
  observedElements.set(element, onEnter);
  sharedObserver.observe(element);
  return () => {
    observedElements.delete(element);
    sharedObserver?.unobserve(element);
  };
}

export function CachedObservationImg({
  src,
  alt,
  width,
  height,
  className,
  cache = liveMediaCache,
  onError,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  cache?: LiveMediaCache;
  onError?: () => void;
}) {
  const isServer = typeof window === "undefined";
  const imgRef = useRef<HTMLImageElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [resolved, setResolved] = useState<{ sourceUrl: string; objectUrl: string } | null>(() => {
    if (isServer) return null;
    const hit = cache.peek(src);
    return hit ? { sourceUrl: src, objectUrl: hit } : null;
  });

  useEffect(() => {
    let active = true;
    let lease: LiveMediaLease | null = cache.retain(src);
    if (lease) {
      setResolved({ sourceUrl: src, objectUrl: lease.objectUrl });
      return () => {
        active = false;
        lease?.release();
        lease = null;
      };
    }

    const controller = new AbortController();
    const startLoad = () => {
      void cache
        .acquire(src, controller.signal)
        .then(acquired => {
          if (!active || controller.signal.aborted) {
            acquired.release();
            return;
          }
          lease = acquired;
          setResolved({ sourceUrl: src, objectUrl: acquired.objectUrl });
        })
        .catch(() => {
          if (!active || controller.signal.aborted) return;
          onErrorRef.current?.();
        });
    };

    const el = imgRef.current;
    const unobserve = el ? observeViewportEntry(el, startLoad) : (startLoad(), () => {});

    return () => {
      active = false;
      controller.abort();
      unobserve();
      lease?.release();
      lease = null;
    };
  }, [src, cache]);

  if (isServer) {
    return createElement("img", {
      src,
      alt,
      width,
      height,
      className,
      loading: "lazy",
      decoding: "async",
    });
  }

  const warmUrl = resolved?.sourceUrl === src ? resolved.objectUrl : cache.peek(src);
  return createElement("img", {
    ref: imgRef,
    src: warmUrl ?? TRANSPARENT_PIXEL,
    "data-media-ready": warmUrl ? "true" : undefined,
    alt,
    width,
    height,
    className,
    decoding: "async",
    onError: warmUrl
      ? () => {
          cache.invalidate(src, warmUrl);
          onErrorRef.current?.();
        }
      : undefined,
  });
}
