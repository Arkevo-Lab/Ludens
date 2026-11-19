"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/components/use-motion-preferences";
import {
  localDashboardLink,
  type ActivityDisplay,
} from "@/lib/desktop";
import "@/features/pet/pet-settings.css";
import { useLocale, useTranslations } from "@/lib/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type NotificationEntry = {
  input: Extract<ActivityDisplay, { type: "show" }>["input"];
  closing: boolean;
};

const NOTIFICATION_EXIT_MS = 160;

function clearNotificationTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  id: string,
) {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

/** Native affordances around the same Web console; no second run view. */
export function DesktopBridge({
  onNavigate,
}: {
  onNavigate(url: string): void;
}) {
  const t = useTranslations("desktopBridge");
  const { locale, ready } = useLocale();
  const [messages, setMessages] = useState<Map<string, NotificationEntry>>(() => new Map());
  const closeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [error, setError] = useState(false);
  const navigate = useRef(onNavigate);
  useEffect(() => {
    navigate.current = onNavigate;
  }, [onNavigate]);
  useEffect(() => {
    const companion = window.ludens?.companion;
    if (ready && companion) void companion.setLocale(locale).catch(() => {});
  }, [locale, ready]);
  useEffect(() => {
    const timers = closeTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    const timers = closeTimers.current;
    for (const [id, entry] of messages) {
      if (!entry.closing) {
        clearNotificationTimer(timers, id);
      } else if (!timers.has(id)) {
        const timer = setTimeout(() => {
          timers.delete(id);
          setMessages((previous) => {
            const current = previous.get(id);
            if (!current?.closing) return previous;
            const next = new Map(previous);
            next.delete(id);
            return next;
          });
        }, NOTIFICATION_EXIT_MS);
        timers.set(id, timer);
      }
    }
    for (const id of [...timers.keys()]) {
      if (!messages.has(id)) clearNotificationTimer(timers, id);
    }
  }, [messages]);
  useEffect(() => {
    const companion = window.ludens?.companion;
    if (!companion) return;
    const open = (input: string) => {
      const url = localDashboardLink(input, window.location.href);
      if (url) navigate.current(url);
    };
    const offDisplay = companion.activity.onDisplay((event) => {
      if (event.type === "hide") {
        if (prefersReducedMotion()) {
          clearNotificationTimer(closeTimers.current, event.displayId);
          setMessages((previous) => {
            if (!previous.has(event.displayId)) return previous;
            const next = new Map(previous);
            next.delete(event.displayId);
            return next;
          });
          return;
        }
        setMessages((previous) => {
          const current = previous.get(event.displayId);
          if (!current || current.closing) return previous;
          const next = new Map(previous);
          next.set(event.displayId, { ...current, closing: true });
          return next;
        });
        return;
      }
      clearNotificationTimer(closeTimers.current, event.displayId);
      setMessages((previous) => {
        const next = new Map(previous);
        next.set(event.displayId, { input: event.input, closing: false });
        return next;
      });
    });
    const offOpen = companion.activity.onOpen(open);
    return () => {
      offDisplay();
      offOpen();
    };
  }, []);
  const action = async (name: "open" | "dismiss", id: string) => {
    setError(false);
    try {
      await window.ludens?.companion?.activity[name](id);
    } catch {
      setError(true);
    }
  };
  return (
    <aside
      className="desktop-notifications"
      aria-label={t("notificationsLabel")}
      aria-live="polite"
    >
      {[...messages].map(([id, { input, closing }]) => (
        <article
          className={`desktop-notification ${input.status === "error" ? "is-error" : ""}`}
          data-closing={closing ? "true" : undefined}
          key={id}
        >
          <div>
            <span className="desktop-notification-label">
              LUDENS PET · {input.block?.kind ?? t("activityFallback")}
            </span>
            <Button type="button" variant="ghost" size="icon-xs"
              aria-label={t("dismiss")}
              onClick={() => { if (!closing) void action("dismiss", id); }}
            >
              ×
            </Button>
          </div>
          <strong>{input.title}</strong>
          {input.description && <p>{input.description}</p>}
          <Button type="button" variant="outline" size="sm"
            onClick={() => { if (!closing) void action("open", id); }}
          >
            {t("viewDetails")} ↗
          </Button>
        </article>
      ))}
      {error && (
        <Alert variant="destructive"><AlertDescription>{t("actionFailed")}</AlertDescription></Alert>
      )}
    </aside>
  );
}
