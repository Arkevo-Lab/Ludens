"use client";

import { FolderIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextPicker, type ContextPickerVariant } from "@/features/workspaces/context-picker";
import { useTranslations } from "@/lib/locale";
import type { Project } from "@/lib/types";

export function workspaceName(project?: Project, fallback = "") {
  if (!project) return fallback;
  if (project.name) return project.name;
  if (project.workspace) {
    const parts = project.workspace.split("/").filter(Boolean);
    return (parts.at(-1) === "workspace" ? parts.at(-2) : parts.at(-1)) ?? project.id;
  }
  return project.id;
}

/** A context selector only; the parent owns URL updates and run selection. */
export function WorkspacePicker({
  projects,
  value,
  onChange,
  loading = false,
  error = "",
  variant = "default",
  muted = false,
  onCreateWorkspace,
  onManageWorkspaces,
}: {
  projects: Project[];
  value: string;
  onChange(project: string): void;
  loading?: boolean;
  error?: string;
  variant?: ContextPickerVariant;
  muted?: boolean;
  onCreateWorkspace?(): void;
  onManageWorkspaces?(): void;
}) {
  const t = useTranslations("workspacePicker");
  const dt = useTranslations("dashboard");
  const selected = projects.find(project => project.id === value);
  const empty = !projects.length;
  const emptyMessage = loading ? t("loading") : error ? t("unavailable") : t("empty");
  const emptyHint = loading ? t("loading") : error ? t("errorHint") : t("emptyHint");
  const statusTone: "active" | "muted" | "danger" =
    error || selected?.available === false
      ? "danger"
      : muted || empty || loading || !selected
        ? "muted"
        : "active";
  const defaultTitle = selected?.workspace ?? (empty ? emptyMessage : t("choose"));
  const defaultHint = empty ? emptyHint : selected?.workspace || selected?.id || t("description");
  return <ContextPicker kind="workspace" variant={variant} muted={muted} statusTone={statusTone} value={value} onChange={onChange}
    label={<><FolderIcon className="size-4" aria-hidden="true" />{dt("picker.workspace")}</>}
    options={projects.map(project => ({ value: project.id, label: workspaceName(project),
      identity: project.workspace || project.id, identityKind: project.workspace ? "path" : "id",
      badge: project.available === false ? t("directoryUnavailable") : undefined }))}
    trigger={{ text: (empty ? emptyMessage : workspaceName(selected, t("choose"))) + (selected?.available === false ? dt("picker.unavailable") : ""),
      title: muted ? t("globalScopeHint") : defaultTitle,
      hint: muted ? `${t("globalScopeHint")}${selected?.workspace ? ` · ${selected.workspace}` : ""}` : defaultHint }}
    copy={{ title: t("choose"), description: t("description"), close: t("close"), current: t("current"),
      empty: emptyMessage, emptyHint: loading ? undefined : emptyHint }}
    footer={
      onCreateWorkspace || onManageWorkspaces
        ? close => (
            <>
              {onCreateWorkspace ? (
                <Button
                  type="button"
                  size="sm"
                  data-workspace-picker-create=""
                  onClick={() => {
                    close();
                    onCreateWorkspace();
                  }}
                >
                  <PlusIcon className="size-3.5" aria-hidden="true" />
                  {t("newWorkspace")}
                </Button>
              ) : <span />}
              {onManageWorkspaces ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-workspace-picker-manage=""
                  onClick={() => {
                    close();
                    onManageWorkspaces();
                  }}
                >
                  {t("manageWorkspaces")}
                </Button>
              ) : null}
            </>
          )
        : undefined
    } />;
}
