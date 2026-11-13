# Flat Settings & Baseware UX Overhaul

Refactor Global Settings (`?view=settings`), Workspace Settings (`?view=perception`), and Baseware (`?view=baseware`) from heavy stacked `<Card>` layouts into a cohesive Codex/Linear/macOS-style flat-row architecture.

## Scope

1. **Wave 1 (Foundation)**:
   - Add shared flat layout CSS (`app/components/ui/settings-layout.css`) and primitives (`app/components/ui/settings-primitives.tsx`): `SettingsWorkspaceLayout`, `SettingsSection`, `SettingsRow`, `SettingsSaveBar`, `InlineCopyButton`, `SingleLineTruncate`, and `AdvancedDiagnosticsDisclosure`.
   - Add concise bilingual i18n keys to `app/messages/zh.json` and `app/messages/en.json` while keeping existing keys intact for zero-breakage migration.
2. **Wave 2 (Views)**:
   - Migrate Global Settings (`settings-view.tsx`, `pet-settings.tsx`, `connection-settings.tsx`), Workspace Settings (`workspace-studio-view.tsx`, `perception-settings.tsx`), and Baseware (`baseware-view.tsx`) onto the shared flat primitives.
3. **Cleanup**:
   - Remove plan file and `PLANS.md` link upon completion.
