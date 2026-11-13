"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  FolderIcon,
  PanelLeft,
  RotateCw,
  Search,
  Sparkles,
  XIcon,
} from "lucide-react";
import { workspaceName } from "@/features/workspaces/workspace-picker";
import type { DesktopPlatform } from "@/lib/desktop";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";
import type { ConsoleView } from "@/shell/console-sidebar";
import { formatDesktopShortcut } from "@/shell/use-desktop-window";

export const QUICK_SWITCHER_VIEW_IDS: readonly ConsoleView[] = [
  "live",
  "replay",
  "perf",
  "caps",
  "perception",
  "workspaces",
  "baseware",
  "docs",
  "settings",
] as const;

export interface QuickSwitcherItem {
  id: string;
  group: "workspaces" | "views" | "actions";
  title: string;
  subtitle?: string;
  keywords?: string;
  badge?: string;
  shortcut?: string;
  icon:
    | "workspace"
    | "view"
    | "sidebar"
    | "back"
    | "forward"
    | "reload"
    | "pet";
  onSelect(): void;
}

export function filterQuickSwitcherItems(
  items: readonly QuickSwitcherItem[],
  rawQuery: string,
): QuickSwitcherItem[] {
  const tokens = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return [...items];
  return items.filter((item) => {
    const haystack =
      `${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface DesktopQuickSwitcherProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  platform: DesktopPlatform;
  projects: Project[];
  currentProject: string;
  currentView: ConsoleView;
  viewLink(view: ConsoleView): string;
  onNavigate(url: string): void;
  onSelectWorkspace(projectId: string): void;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack(): void;
  onGoForward(): void;
  onReload(): void;
  companionAvailable?: boolean;
  companionVisible?: boolean;
  onToggleCompanion?(): void;
}

function ItemIcon({ kind }: { kind: QuickSwitcherItem["icon"] }) {
  const cls = "desktop-qs-item-icon size-4";
  switch (kind) {
    case "workspace":
      return <FolderIcon className={cls} aria-hidden="true" />;
    case "sidebar":
      return <PanelLeft className={cls} aria-hidden="true" />;
    case "back":
      return <ArrowLeft className={cls} aria-hidden="true" />;
    case "forward":
      return <ArrowRight className={cls} aria-hidden="true" />;
    case "reload":
      return <RotateCw className={cls} aria-hidden="true" />;
    case "pet":
      return <Sparkles className={cls} aria-hidden="true" />;
    default:
      return <Compass className={cls} aria-hidden="true" />;
  }
}

export function DesktopQuickSwitcher({
  open,
  onOpenChange,
  platform,
  projects,
  currentProject,
  currentView,
  viewLink,
  onNavigate,
  onSelectWorkspace,
  sidebarCollapsed,
  onToggleSidebar,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onReload,
  companionAvailable = false,
  companionVisible = false,
  onToggleCompanion,
}: DesktopQuickSwitcherProps) {
  const { t: rootT } = useLocale();
  const t = useTranslations("desktopChrome");
  const dialogId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback(() => {
    onOpenChange(false);
    requestAnimationFrame(() => {
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    });
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open, close]);

  const allItems = useMemo<QuickSwitcherItem[]>(() => {
    const items: QuickSwitcherItem[] = [];

    for (const project of projects) {
      const name = workspaceName(project);
      items.push({
        id: `workspace:${project.id}`,
        group: "workspaces",
        title: name,
        subtitle: project.workspace || project.id,
        keywords: `workspace project live ${project.id} ${name} ${project.workspace ?? ""}`,
        badge: project.id === currentProject ? t("badgeCurrent") : undefined,
        icon: "workspace",
        onSelect: () => onSelectWorkspace(project.id),
      });
    }

    const viewIds: ConsoleView[] =
      currentView === "dev"
        ? [...QUICK_SWITCHER_VIEW_IDS, "dev"]
        : [...QUICK_SWITCHER_VIEW_IDS];

    for (const id of viewIds) {
      items.push({
        id: `view:${id}`,
        group: "views",
        title: rootT(`nav.${id}`),
        subtitle: rootT(`views.${id}.title`),
        keywords: `view page ${id} ${rootT(`nav.${id}`)} ${rootT(`views.${id}.title`)}`,
        badge: id === currentView ? t("badgeActive") : undefined,
        icon: "view",
        onSelect: () => onNavigate(viewLink(id)),
      });
    }

    items.push({
      id: "action:toggle-sidebar",
      group: "actions",
      title: sidebarCollapsed
        ? t("actionToggleSidebarExpand")
        : t("actionToggleSidebarCollapse"),
      keywords: "sidebar panel toggle collapse expand drawer",
      shortcut: formatDesktopShortcut(platform, "B"),
      icon: "sidebar",
      onSelect: onToggleSidebar,
    });

    if (canGoBack) {
      items.push({
        id: "action:back",
        group: "actions",
        title: t("actionBack"),
        keywords: "back previous history",
        shortcut: formatDesktopShortcut(platform, "["),
        icon: "back",
        onSelect: onGoBack,
      });
    }

    if (canGoForward) {
      items.push({
        id: "action:forward",
        group: "actions",
        title: t("actionForward"),
        keywords: "forward next history",
        shortcut: formatDesktopShortcut(platform, "]"),
        icon: "forward",
        onSelect: onGoForward,
      });
    }

    if (companionAvailable && onToggleCompanion) {
      items.push({
        id: "action:companion",
        group: "actions",
        title: companionVisible ? t("actionHidePet") : t("actionShowPet"),
        subtitle: companionVisible
          ? t("companionVisibleState")
          : t("companionHiddenState"),
        keywords: "pet companion desktop toggle show hide",
        icon: "pet",
        onSelect: onToggleCompanion,
      });
    }

    items.push({
      id: "action:reload",
      group: "actions",
      title: t("actionReload"),
      keywords: "reload refresh window",
      shortcut: formatDesktopShortcut(platform, "R"),
      icon: "reload",
      onSelect: onReload,
    });

    return items;
  }, [
    projects,
    currentProject,
    currentView,
    rootT,
    t,
    viewLink,
    onNavigate,
    onSelectWorkspace,
    sidebarCollapsed,
    platform,
    onToggleSidebar,
    canGoBack,
    canGoForward,
    onGoBack,
    onGoForward,
    companionAvailable,
    companionVisible,
    onToggleCompanion,
    onReload,
  ]);

  const filteredItems = useMemo(
    () => filterQuickSwitcherItems(allItems, query),
    [allItems, query],
  );

  const clampedIndex =
    filteredItems.length === 0
      ? -1
      : Math.min(activeIndex, filteredItems.length - 1);

  useEffect(() => {
    if (!open || clampedIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-qs-index="${clampedIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [open, clampedIndex]);

  if (!open) return null;

  const groups: Array<{
    key: QuickSwitcherItem["group"];
    label: string;
    entries: Array<{ item: QuickSwitcherItem; flatIndex: number }>;
  }> = [];

  const groupLabels: Record<QuickSwitcherItem["group"], string> = {
    workspaces: t("groupWorkspaces"),
    views: t("groupViews"),
    actions: t("groupActions"),
  };

  filteredItems.forEach((item, flatIndex) => {
    let bucket = groups.find((g) => g.key === item.group);
    if (!bucket) {
      bucket = { key: item.group, label: groupLabels[item.group], entries: [] };
      groups.push(bucket);
    }
    bucket.entries.push({ item, flatIndex });
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.key === "Tab" && dialogRef.current) {
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (
          event.shiftKey &&
          (active === first || !dialogRef.current.contains(active))
        ) {
          event.preventDefault();
          last.focus();
          return;
        }
        if (
          !event.shiftKey &&
          (active === last || !dialogRef.current.contains(active))
        ) {
          event.preventDefault();
          first.focus();
          return;
        }
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!filteredItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filteredItems.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
      );
      return;
    }
    if (event.key === "Home" && event.target === inputRef.current) {
      return;
    }
    if (event.key === "End" && event.target === inputRef.current) {
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      const target = filteredItems[clampedIndex];
      if (target) {
        close();
        target.onSelect();
      }
    }
  };

  return (
    <div
      className="desktop-qs-backdrop"
      data-quick-switcher=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("switcherTitle")}
        className="desktop-qs-dialog"
        onKeyDown={handleKeyDown}
      >
        <div className="desktop-qs-input-row">
          <Search
            className="desktop-qs-search-icon size-4"
            strokeWidth={1.85}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${dialogId}-listbox`}
            aria-activedescendant={
              clampedIndex >= 0
                ? `${dialogId}-opt-${clampedIndex}`
                : undefined
            }
            className="desktop-qs-input"
            placeholder={t("switcherPlaceholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          {query && (
            <button
              type="button"
              className="desktop-chrome-icon-btn"
              aria-label={t("switcherClear")}
              title={t("switcherClear")}
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div
          ref={listRef}
          id={`${dialogId}-listbox`}
          role="listbox"
          className="desktop-qs-list"
        >
          {groups.length === 0 ? (
            <div className="desktop-qs-empty">{t("switcherEmpty")}</div>
          ) : (
            groups.map((group) => (
              <div
                key={group.key}
                className="desktop-qs-group"
                data-qs-group={group.key}
              >
                <div className="desktop-qs-group-label">{group.label}</div>
                {group.entries.map(({ item, flatIndex }) => {
                  const isActive = flatIndex === clampedIndex;
                  return (
                    <button
                      key={item.id}
                      id={`${dialogId}-opt-${flatIndex}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-qs-index={flatIndex}
                      data-qs-item={item.id}
                      data-active={String(isActive)}
                      className="desktop-qs-item"
                      onMouseMove={() => {
                        if (activeIndex !== flatIndex) {
                          setActiveIndex(flatIndex);
                        }
                      }}
                      onClick={() => {
                        onOpenChange(false);
                        item.onSelect();
                      }}
                    >
                      <span className="desktop-qs-item-left">
                        <ItemIcon kind={item.icon} />
                        <span className="desktop-qs-item-title">
                          {item.title}
                        </span>
                        {item.subtitle && item.subtitle !== item.title ? (
                          <span className="desktop-qs-item-subtitle">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                      <span className="desktop-qs-item-right">
                        {item.badge && (
                          <span className="desktop-qs-badge">{item.badge}</span>
                        )}
                        {item.shortcut && (
                          <kbd className="desktop-qs-kbd">{item.shortcut}</kbd>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <footer className="desktop-qs-footer">
          <div className="desktop-qs-hints">
            <span>
              <kbd className="desktop-qs-kbd">↑↓</kbd>
              {t("shortcutNavigate")}
            </span>
            <span>
              <kbd className="desktop-qs-kbd">↵</kbd>
              {t("shortcutSelect")}
            </span>
            <span>
              <kbd className="desktop-qs-kbd">esc</kbd>
              {t("shortcutClose")}
            </span>
          </div>
          <span>{formatDesktopShortcut(platform, "K")}</span>
        </footer>
      </div>
    </div>
  );
}
