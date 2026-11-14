"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { MenuIcon, PanelLeftClose, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PixelMark, type PixelMarkState } from "@/components/ui/pixel-mark";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import type { ActiveCoreItem } from "@/shell/use-active-cores";

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

function corePixelState(core: ActiveCoreItem): PixelMarkState {
  if (core.pendingOutbound > 0) return "reasoning";
  if (core.consolidating) return "recording";
  if (core.mode === "auto") return "reasoning";
  return "waiting";
}

function coreModeKey(core: ActiveCoreItem): "activeCoresStatusConsolidating" | "activeCoresStatusAuto" | "activeCoresStatusManual" {
  if (core.consolidating) return "activeCoresStatusConsolidating";
  if (core.mode === "auto") return "activeCoresStatusAuto";
  return "activeCoresStatusManual";
}

function coreModeToken(core: ActiveCoreItem): "consolidating" | "auto" | "manual" {
  if (core.consolidating) return "consolidating";
  if (core.mode === "auto") return "auto";
  return "manual";
}

export interface ConsoleSidebarProps {
  view: ConsoleView;
  viewLink(view: ConsoleView): string;
  onNavigate(url: string): void;
  workspaceSlot?: ReactNode;
  mobileOpen?: boolean;
  onMobileOpenChange?(open: boolean): void;
  mobileTriggerRef?: RefObject<HTMLButtonElement | null>;
  collapsed?: boolean;
  onToggleCollapse?(): void;
  collapseShortcut?: string;
  desktopChrome?: boolean;
  activeCores?: ActiveCoreItem[];
  activeProjectId?: string;
  stoppingCoreId?: string | null;
  onOpenCore?(projectId: string): void;
  onStopCore?(projectId: string): void;
  activeCoresStopError?: string | null;
}

export function ConsoleSidebar({
  view,
  viewLink,
  onNavigate,
  workspaceSlot,
  mobileOpen,
  onMobileOpenChange,
  mobileTriggerRef,
  collapsed = false,
  onToggleCollapse,
  collapseShortcut,
  desktopChrome = false,
  activeCores = [],
  activeProjectId,
  stoppingCoreId = null,
  onOpenCore,
  onStopCore,
  activeCoresStopError = null,
}: ConsoleSidebarProps) {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const st = useTranslations("consoleSidebar");
  const ct = useTranslations("desktopChrome");
  const id = useId();
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLElement>(null);
  const [assemble, setAssemble] = useState(false);
  const lastSidebarFocus = useRef<HTMLElement | null>(null);
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const expanded = mobileOpen ?? uncontrolledExpanded;
  const setExpanded = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(expanded) : next;
    if (mobileOpen === undefined) setUncontrolledExpanded(resolved);
    onMobileOpenChange?.(resolved);
  }, [expanded, mobileOpen, onMobileOpenChange]);
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
      if (!narrow.matches && expanded) setExpanded(false);
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
          if (!expanded && (scrollArea.current?.contains(target) || footer.current?.contains(target))) {
            const fallbackTrigger = mobileTriggerRef?.current?.getClientRects().length
              ? mobileTriggerRef.current
              : menuButton.current;
            fallbackTrigger?.focus();
          } else if (expanded) {
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
  }, [expanded, mobileTriggerRef, setExpanded]);
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
    const area = scrollArea.current;
    const foot = footer.current;
    if (area) { observer.observe(area); area.addEventListener("scroll", follow, { passive: true }); }
    if (foot) { observer.observe(foot); }
    return () => { observer.disconnect(); area?.removeEventListener("scroll", follow); };
  }, [view, expanded, collapsed]);
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
  const closeMenu = useCallback(() => {
    if (!expanded) return;
    setExpanded(false);
    requestAnimationFrame(() => {
      if (mobileTriggerRef?.current?.getClientRects().length) {
        mobileTriggerRef.current.focus();
      } else if (menuButton.current?.getClientRects().length) {
        menuButton.current.focus();
      }
    });
  }, [expanded, mobileTriggerRef, setExpanded]);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      closeMenu();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded, closeMenu]);
  const renderLink = (id: ConsoleView) => <a key={id} href={viewLink(id)}
    className={view === id ? "active" : undefined} aria-current={view === id ? "page" : undefined}
    onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); closeMenu(); onNavigate(viewLink(id));
    }}>
    <NavIcon kind={id} /><span>{t(`nav.${id}`)}</span>
  </a>;
  const collapseTitle = collapseShortcut
    ? ct("toggleSidebarHint")
        .replace("{action}", ct("collapseSidebar"))
        .replace("{shortcut}", collapseShortcut)
    : ct("collapseSidebar");
  return <>
    {expanded && <div className="sidebar-backdrop" aria-hidden="true" onClick={closeMenu} />}
    <aside
      ref={sidebar}
      className="sidebar"
      data-expanded={expanded}
      data-collapsed={collapsed ? "true" : undefined}
      data-desktop-chrome={desktopChrome ? "true" : undefined}
    >
      <div className="sidebar-brand-row">
        <a className="brand" href={viewLink("live")} onClick={event => {
          if (!isPlainNavigationClick(event)) return;
          event.preventDefault(); closeMenu(); onNavigate(viewLink("live"));
        }}><PixelMark assemble={assemble} /><span>Ludens</span></a>
        <div className="sidebar-header-controls">
          {onToggleCollapse && !desktopChrome && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="sidebar-collapse-toggle"
              aria-label={ct("collapseSidebar")}
              title={collapseTitle}
              onClick={onToggleCollapse}
            >
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </Button>
          )}
          <div className="sidebar-menu-control">
            <Button ref={menuButton} type="button" variant="ghost" size="icon-sm" className="sidebar-menu-toggle"
              aria-expanded={expanded} aria-controls={`${id}-content ${id}-footer`}
              aria-label={st(expanded ? "menuClose" : "menuOpen")}
              title={st(expanded ? "menuClose" : "menuOpen")}
              onClick={() => (expanded ? closeMenu() : setExpanded(true))}>
              {expanded ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </div>
      <i ref={cursor} className="nav-cursor" aria-hidden="true" />
      <div ref={scrollArea} id={`${id}-content`} className="sidebar-scroll-area">
        <nav className="sidebar-navigation" aria-label={dt("consoleNav")}>
          {navSections.map(section => <div key={section.label} className="nav-section">
            <small>{t(section.label)}</small>{section.ids.map(renderLink)}
          </div>)}
        </nav>
        {collapsed ? (
          <section
            className="sidebar-active-cores-rail"
            aria-label={st("activeCoresTitle")}
            data-active-cores-rail=""
          >
            {activeCores.length > 0 ? (
              <ul role="list" className="sidebar-active-cores-rail-list">
                {activeCores.map(core => {
                  const isCurrent = core.projectId === activeProjectId;
                  const openLabel = st("activeCoresOpenAria").replace("{name}", core.name);
                  const modeToken = coreModeToken(core);
                  const sosLabel = core.pendingOutbound > 0
                    ? st("activeCoresOutboundBadge").replace("{count}", String(core.pendingOutbound))
                    : "";
                  return (
                    <li key={core.projectId}>
                      <button
                        type="button"
                        className="sidebar-active-cores-pill"
                        data-active={isCurrent || undefined}
                        data-mode={modeToken}
                        data-sos={core.pendingOutbound > 0 || undefined}
                        aria-label={sosLabel ? `${openLabel} · ${sosLabel}` : openLabel}
                        aria-current={isCurrent ? "true" : undefined}
                        title={sosLabel ? `${core.name} · ${sosLabel}` : core.name}
                        onClick={() => {
                          closeMenu();
                          if (onOpenCore) onOpenCore(core.projectId);
                          else onNavigate(`?view=live&project=${encodeURIComponent(core.projectId)}`);
                        }}
                      >
                        <span className="sidebar-active-cores-pill-dot" aria-hidden="true" />
                        <span className="sidebar-active-cores-pill-label">{core.name}</span>
                        {core.pendingOutbound > 0 && (
                          <span aria-hidden="true">🆘</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sidebar-active-cores-empty">{st("activeCoresEmpty")}</p>
            )}
          </section>
        ) : (
          <section
            className="sidebar-active-cores"
            aria-labelledby={`${id}-active-cores-heading`}
            data-active-cores=""
          >
            <div className="sidebar-active-cores-header">
              <h2 id={`${id}-active-cores-heading`} className="sidebar-active-cores-heading">
                {st("activeCoresTitle")}
              </h2>
              {activeCores.length > 0 && (
                <span className="sidebar-active-cores-count">
                  {st("activeCoresCount").replace("{count}", String(activeCores.length))}
                </span>
              )}
            </div>
            {activeCoresStopError && (
              <p className="sidebar-active-cores-error" role="alert">
                {activeCoresStopError}
              </p>
            )}
            {activeCores.length > 0 ? (
              <ul role="list" className="sidebar-active-cores-list">
                {activeCores.map(core => {
                  const isCurrent = core.projectId === activeProjectId;
                  const isStopping = stoppingCoreId === core.projectId;
                  const modeToken = coreModeToken(core);
                  const modeLabel = st(coreModeKey(core));
                  const originLabel = core.launchedBy === "cli"
                    ? st("activeCoresOriginCli")
                    : core.launchedBy === "app"
                      ? st("activeCoresOriginApp")
                      : null;
                  const openLabel = st("activeCoresOpenAria").replace("{name}", core.name);
                  const stopLabel = st("activeCoresStopAria").replace("{name}", core.name);
                  const outboundTitle = core.pendingOutbound > 0
                    ? st("activeCoresOutboundBadge").replace("{count}", String(core.pendingOutbound))
                    : "";
                  const buttonLabel = outboundTitle ? `${openLabel} · ${outboundTitle}` : openLabel;
                  return (
                    <li
                      key={core.projectId}
                      className="sidebar-active-core-item"
                      data-active={isCurrent || undefined}
                      data-sos={core.pendingOutbound > 0 || undefined}
                      data-project-id={core.projectId}
                    >
                      <button
                        type="button"
                        className="sidebar-active-core-open"
                        aria-label={buttonLabel}
                        aria-current={isCurrent ? "true" : undefined}
                        title={buttonLabel}
                        onClick={() => {
                          closeMenu();
                          if (onOpenCore) onOpenCore(core.projectId);
                          else onNavigate(`?view=live&project=${encodeURIComponent(core.projectId)}`);
                        }}
                      >
                        <span className="sidebar-active-core-mark">
                          <PixelMark
                            size={14}
                            state={corePixelState(core)}
                            loading={core.mode === "auto" || core.consolidating}
                            filled={modeToken === "manual"}
                          />
                        </span>
                        <span className="sidebar-active-core-body">
                          <span className="sidebar-active-core-top">
                            <span className="sidebar-active-core-name">{core.name}</span>
                          </span>
                          <span className="sidebar-active-core-badges">
                            <span className="sidebar-active-core-mode" data-mode={modeToken}>
                              {modeLabel}
                            </span>
                            {originLabel && (
                              <span
                                className="sidebar-active-core-origin"
                                data-origin={core.launchedBy}
                              >
                                {originLabel}
                              </span>
                            )}
                            {core.pendingOutbound > 0 && (
                              <span
                                className="sidebar-active-core-sos"
                                title={outboundTitle}
                              >
                                <span aria-hidden="true">🆘</span>
                                <span>{core.pendingOutbound}</span>
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="sidebar-active-core-stop"
                        disabled={isStopping || !onStopCore}
                        aria-label={stopLabel}
                        title={st(isStopping ? "activeCoresStopping" : "activeCoresStop")}
                        onClick={() => onStopCore?.(core.projectId)}
                      >
                        <span aria-hidden="true">{isStopping ? "…" : "■"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sidebar-active-cores-empty">{st("activeCoresEmpty")}</p>
            )}
          </section>
        )}
      </div>
      <footer ref={footer} id={`${id}-footer`} className="sidebar-footer">
        {workspaceSlot && <div className="sidebar-workspace-slot">{workspaceSlot}</div>}
        <nav className="sidebar-settings" aria-label={t("nav.settings")}>{renderLink("settings")}</nav>
      </footer>
    </aside>
  </>;
}
