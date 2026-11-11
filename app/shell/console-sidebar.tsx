"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PixelMark } from "@/components/ui/pixel-mark";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";

export const consoleViewIds = ["live", "replay", "perf", "caps", "perception", "baseware", "workspaces", "docs", "settings", "dev"] as const;
export type ConsoleView = typeof consoleViewIds[number];
const navSections: Array<{ label: string; ids: ConsoleView[] }> = [
  { label: "navSectionWorkspace", ids: ["live", "replay", "perf", "caps", "perception"] },
  { label: "navSectionGlobal", ids: ["workspaces", "baseware", "docs"] },
];

function NavIcon({ kind }: { kind: ConsoleView }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === "live" ? (
        <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />
      ) : kind === "replay" ? (
        <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /><path d="m10 8 6 4-6 4Z" /></>
      ) : kind === "workspaces" ? (
        <><path d="M3 7h7l2-3h9v16H3Z" /><path d="M8 13h8M12 9v8" /></>
      ) : kind === "docs" ? (
        <>
          <path d="M5 3h11l3 3v15H5Z" /><path d="M9 9h7M9 13h7M9 17h4" />
        </>
      ) : kind === "caps" ? (
        <>
          <path d="M9 3H5v18h14V3h-4" /><path d="M9 3h6v4H9Z" /><path d="m9 16 2 2 4-4" />
        </>
      ) : kind === "perception" ? (
        <>
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
        </>
      ) : kind === "baseware" ? (
        <>
          <rect x="4" y="4" width="16" height="6" rx="1.5" />
          <rect x="4" y="14" width="16" height="6" rx="1.5" />
          <path d="M8 7h.01M8 17h.01M12 10v4" />
        </>
      ) : kind === "perf" ? (
        <path d="M4 19V11M10 19V5M16 19V8M22 19V2" strokeWidth="3" />
      ) : kind === "dev" ? (
        <>
          <path d="m4 17 5-5-5-5" /><path d="M12 19h8" />
        </>
      ) : (
        <>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
        </>
      )}
    </svg>
  );
}


let assembleUntil = 0;

export function ConsoleSidebar({ view, viewLink, onNavigate }: {
  view: ConsoleView;
  viewLink(view: ConsoleView): string;
  onNavigate(url: string): void;
}) {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const st = useTranslations("consoleSidebar");
  const id = useId();
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLElement>(null);
  const [assemble, setAssemble] = useState(false);
  const lastSidebarFocus = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 680px)");
    let animation = 0;
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body)
        lastSidebarFocus.current = sidebar.current?.contains(event.target) ? event.target : null;
    };
    const forgetOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !sidebar.current?.contains(event.target)) lastSidebarFocus.current = null;
    };
    const revealInMiddle = (target: HTMLElement) => {
      const middle = scrollArea.current;
      if (!middle?.contains(target)) return;
      const bounds = middle.getBoundingClientRect(), item = target.getBoundingClientRect();
      // Match the scroll area's padding, including the link's outer focus ring.
      if (item.top < bounds.top + 6) middle.scrollTop += item.top - bounds.top - 6;
      else if (item.bottom > bounds.bottom - 6) middle.scrollTop += item.bottom - bounds.bottom + 6;
    };
    const restoreVisibleFocus = () => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(() => {
        const active = document.activeElement;
        const previous = lastSidebarFocus.current;
        // CSS may hide and blur the old control before the media-query event arrives.
        // Only reuse that control if focus is still on BODY and it is now hidden.
        const target = active instanceof HTMLElement && active !== document.body ? active
          : previous?.isConnected && !previous.getClientRects().length ? previous : null;
        if (!target || !sidebar.current?.contains(target)) return;
        if (narrow.matches) {
          if (!expanded && (scrollArea.current?.contains(target) || footer.current?.contains(target))) menuButton.current?.focus();
          else if (expanded) {
            const bounds = target.getBoundingClientRect();
            if (bounds.top < 0 || bounds.bottom > window.innerHeight)
              target.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        } else if (target === menuButton.current) {
          const current = sidebar.current.querySelector<HTMLElement>('a[aria-current="page"]')
            ?? sidebar.current.querySelector<HTMLElement>(".brand");
          current?.focus({ preventScroll: true });
          if (current) revealInMiddle(current);
        } else revealInMiddle(target);
      });
    };
    document.addEventListener("focusin", rememberFocus);
    document.addEventListener("pointerdown", forgetOutsidePointer, true);
    window.addEventListener("resize", restoreVisibleFocus);
    return () => {
      cancelAnimationFrame(animation);
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("pointerdown", forgetOutsidePointer, true);
      window.removeEventListener("resize", restoreVisibleFocus);
    };
  }, [expanded]);
  // The orange cursor pixel steps to the active link. Scrolling and resizing reposition it without the stepped travel.
  useLayoutEffect(() => {
    const root = sidebar.current, pixel = cursor.current;
    if (!root || !pixel) return;
    const place = (travel: boolean) => {
      const link = root.querySelector<HTMLElement>("nav a.active");
      const box = link?.getBoundingClientRect();
      if (!box?.height) { delete root.dataset.cursor; return; }
      const origin = root.getBoundingClientRect();
      pixel.dataset.travel = String(travel && root.dataset.cursor !== undefined);
      pixel.style.transform = `translate(${Math.round(box.left - origin.left + 2)}px, ${Math.round(box.top - origin.top + (box.height - 6) / 2)}px)`;
      root.dataset.cursor = "";
    };
    place(true);
    const follow = () => place(false);
    const observer = new ResizeObserver(follow);
    observer.observe(root);
    if (scrollArea.current) { observer.observe(scrollArea.current); scrollArea.current.addEventListener("scroll", follow, { passive: true }); }
    const area = scrollArea.current;
    return () => { observer.disconnect(); area?.removeEventListener("scroll", follow); };
  }, [view, expanded]);
  // The brand assembles itself once per browser session. The deadline lives outside the component so a remount
  // or a development double-run of the effect picks the animation up instead of skipping or repeating it.
  useEffect(() => {
    try {
      if (!window.sessionStorage.getItem("ludens:brand-assembled")) {
        window.sessionStorage.setItem("ludens:brand-assembled", "1");
        assembleUntil = Date.now() + 1200;
      }
    } catch { /* Without session storage the brand simply stays still. */ }
    const left = assembleUntil - Date.now();
    if (left <= 0) return;
    setAssemble(true);
    const done = window.setTimeout(() => setAssemble(false), left);
    return () => window.clearTimeout(done);
  }, []);
  const closeMenu = () => {
    if (!expanded) return;
    setExpanded(false);
    if (menuButton.current?.getClientRects().length) menuButton.current.focus();
  };
  const renderLink = (id: ConsoleView) => <a key={id} href={viewLink(id)}
    className={view === id ? "active" : undefined} aria-current={view === id ? "page" : undefined}
    onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); closeMenu(); onNavigate(viewLink(id));
    }}>
    <NavIcon kind={id} /><span>{t(`nav.${id}`)}</span>
  </a>;
  return <aside ref={sidebar} className="sidebar" data-expanded={expanded}>
    <a className="brand" href={viewLink("live")} onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); closeMenu(); onNavigate(viewLink("live"));
    }}><PixelMark assemble={assemble} /><span>Ludens</span></a>
    <i ref={cursor} className="nav-cursor" aria-hidden="true" />
    <div className="sidebar-menu-control">
      <Button ref={menuButton} type="button" variant="ghost" size="sm" className="sidebar-menu-toggle"
        aria-expanded={expanded} aria-controls={`${id}-content ${id}-footer`}
        onClick={() => setExpanded(value => !value)}>
        {expanded ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
        {st(expanded ? "menuClose" : "menuOpen")}
      </Button>
    </div>
    <div ref={scrollArea} id={`${id}-content`} className="sidebar-scroll-area">
      <nav className="sidebar-navigation" aria-label={dt("consoleNav")}>
        {navSections.map(section => <div key={section.label} className="nav-section">
          <small>{t(section.label)}</small>{section.ids.map(renderLink)}
        </div>)}
      </nav>
    </div>
    <footer ref={footer} id={`${id}-footer`} className="sidebar-footer">
      <nav className="sidebar-settings" aria-label={t("nav.settings")}>{renderLink("settings")}</nav>
    </footer>
  </aside>;
}
