import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LocaleProvider } from "../lib/locale";
import type { Project } from "../lib/types";
import type { WorkspaceStudioSnapshot } from "../lib/workspaces";
import type { PetFollow } from "../features/pet/pet-follow";

const nodeRequire = createRequire(import.meta.url);
const cjsModule = nodeRequire("node:module") as {
  _extensions: Record<string, (mod: unknown, filename: string) => void>;
};
cjsModule._extensions[".css"] ??= () => {};

const {
  BUILTIN_LOCAL_PROFILE_ID,
  DEFAULT_LOCAL_CACHE_BYTES,
  DEFAULT_LOCAL_MAX_BYTES,
  GIB_BYTES,
  SECRET_MASK,
  aggregateStorageFootprint,
  buildStorageTestParamsFromDraft,
  bytesToGibInput,
  createEmptyStorageProfileDraft,
  draftToStorageProfileInput,
  draftToWorkspaceStorageOverride,
  formatStorageBytes,
  gibInputToBytes,
  hoursInputToNumber,
  normalizeWorkspaceStorageOverride,
  redactedProfileToInput,
  sameWorkspaceStorageOverride,
  slugifyStorageProfileId,
  storageProfileToDraft,
  validateStorageProfileDraft,
  workspaceStorageToDraft,
} = nodeRequire("../lib/storage") as typeof import("../lib/storage");

const { SettingsView } = nodeRequire("../features/workspaces/settings-view") as typeof import("../features/workspaces/settings-view");
const {
  StorageProfileForm,
  StorageSettings,
} = nodeRequire("../features/workspaces/storage-settings") as typeof import("../features/workspaces/storage-settings");
const { ModelAndBudgetPanel } = nodeRequire("../features/workspaces/workspace-studio-view") as typeof import("../features/workspaces/workspace-studio-view");

const PROJECTS: Project[] = [
  {
    id: "ws-alpha",
    name: "Alpha Desktop",
    workspace: "/tmp/ws-alpha",
    runs: [],
  },
];

const MOCK_FOLLOW: PetFollow = {
  state: null,
  pending: false,
  reading: false,
  readError: "",
  writeError: "",
  requested: undefined,
  lastReadAt: null,
  lastSaved: undefined,
  canWrite: false,
  follow: async () => {},
  refresh: () => {},
};

function makeSampleOverview(): import("../lib/storage").StorageOverviewSnapshot {
  return {
    config: {
      version: 1,
      defaultProfileId: BUILTIN_LOCAL_PROFILE_ID,
      videoQuality: "balanced",
      protectReferenced: true,
      profiles: [
        {
          id: BUILTIN_LOCAL_PROFILE_ID,
          name: "Local Default",
          kind: "local",
          maxBytes: DEFAULT_LOCAL_MAX_BYTES,
          maxAgeHours: null,
          localCacheBytes: null,
        },
        {
          id: "nas-ssd",
          name: "External NAS SSD",
          kind: "directory",
          maxBytes: 200 * GIB_BYTES,
          maxAgeHours: 168,
          localCacheBytes: DEFAULT_LOCAL_CACHE_BYTES,
          directory: { path: "/Volumes/NAS/ludens-media" },
        },
        {
          id: "cloudflare-r2",
          name: "Cloudflare R2 Archive",
          kind: "s3",
          maxBytes: null,
          maxAgeHours: null,
          localCacheBytes: 8 * GIB_BYTES,
          s3: {
            endpoint: "https://acct.r2.cloudflarestorage.com",
            region: "auto",
            bucket: "ludens-timeline",
            prefix: "prod",
            accessKeyId: "R2AKIAEXAMPLE",
            hasSecretAccessKey: true,
            forcePathStyle: false,
          },
        },
      ],
    },
    usage: [
      {
        workspaceId: "ws-alpha",
        workspaceName: "Alpha Desktop",
        workspacePath: "/tmp/ws-alpha",
        available: true,
        effectiveKind: "s3",
        effectiveProfileId: "cloudflare-r2",
        effectiveProfileName: "Cloudflare R2 Archive",
        maxBytes: 50 * GIB_BYTES,
        localVideoBytes: 512 * 1024 * 1024,
        localVideoSegments: 6,
        localCacheBytes: 256 * 1024 * 1024,
        localObjectsBytes: 4 * 1024 * 1024,
        segmentsIndexBytes: 2 * 1024 * 1024,
        logsBytes: 16 * 1024 * 1024,
        totalLocalBytes: 790 * 1024 * 1024,
        archivedSegments: 24,
        archivedBytes: 3 * GIB_BYTES,
        evictedSegments: 5,
        pinnedSegments: 2,
      },
      {
        workspaceId: "ws-beta",
        workspaceName: "Beta Sim",
        workspacePath: "/tmp/ws-beta",
        available: true,
        effectiveKind: "local",
        effectiveProfileId: BUILTIN_LOCAL_PROFILE_ID,
        effectiveProfileName: "Local Default",
        maxBytes: DEFAULT_LOCAL_MAX_BYTES,
        localVideoBytes: 2 * GIB_BYTES,
        localVideoSegments: 12,
        localCacheBytes: 0,
        localObjectsBytes: 0,
        segmentsIndexBytes: 1024 * 1024,
        logsBytes: 8 * 1024 * 1024,
        totalLocalBytes: 2 * GIB_BYTES + 9 * 1024 * 1024,
        archivedSegments: 0,
        archivedBytes: 0,
        evictedSegments: 1,
        pinnedSegments: 0,
      },
    ],
  };
}

function makeStudioSnapshot(
  storage?: import("../lib/storage").WorkspaceStorageOverride,
): WorkspaceStudioSnapshot {
  return {
    id: "ws-alpha",
    name: "Alpha Desktop",
    workspace: "/tmp/ws-alpha",
    config: {
      driver: "cua",
      model: "openai-codex/gpt-6.2-sol",
      seconds: 1800,
      requests: 1000,
      dashboard: true,
      pet: false,
      diagnostics: "normal",
      ...(storage ? { storage } : {}),
    },
    defaults: {
      model: "openai-codex/gpt-6.2-sol",
      seconds: 1800,
      requests: 1000,
      dashboard: true,
      pet: false,
    },
    services: {
      hostSocket: "/tmp/ws-alpha/.ludens/host.sock",
      hostSocketExists: false,
      jobs: [],
    },
    shiori: {
      model: "openai-codex/gpt-6.2-sol",
      currentSessionFile: null,
      sessions: [],
      memory: {
        exists: false,
        path: "/tmp/ws-alpha/MEMORY.md",
        content: "",
        updatedAt: null,
      },
    },
  };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;");

test("formatStorageBytes, GiB conversions, and aggregateStorageFootprint format accurately", async () => {
  const protocolStorage = await import("@ludens/protocol/storage");
  assert.equal(BUILTIN_LOCAL_PROFILE_ID, protocolStorage.BUILTIN_LOCAL_PROFILE_ID);
  assert.equal(DEFAULT_LOCAL_MAX_BYTES, protocolStorage.DEFAULT_LOCAL_MAX_BYTES);
  assert.equal(DEFAULT_LOCAL_CACHE_BYTES, protocolStorage.DEFAULT_LOCAL_CACHE_BYTES);
  assert.equal(SECRET_MASK, protocolStorage.SECRET_MASK);

  assert.equal(formatStorageBytes(null, { unlimitedLabel: "Unlimited" }), "Unlimited");
  assert.equal(formatStorageBytes(undefined), "∞");
  assert.equal(formatStorageBytes(0), "0 B");
  assert.equal(formatStorageBytes(512), "512 B");
  assert.equal(formatStorageBytes(1536), "1.5 KB");
  assert.equal(formatStorageBytes(128.5 * 1024 * 1024), "128.5 MB");
  assert.equal(formatStorageBytes(20 * GIB_BYTES), "20 GB");
  assert.equal(formatStorageBytes(4.25 * GIB_BYTES), "4.25 GB");
  assert.equal(formatStorageBytes(1.5 * 1024 * GIB_BYTES), "1.5 TB");

  assert.equal(bytesToGibInput(DEFAULT_LOCAL_MAX_BYTES), "20");
  assert.equal(bytesToGibInput(4.5 * GIB_BYTES), "4.5");
  assert.equal(bytesToGibInput(null), "");
  assert.equal(gibInputToBytes(""), null);
  assert.equal(gibInputToBytes("20"), 20 * GIB_BYTES);
  assert.ok(Number.isNaN(gibInputToBytes("-5")));
  assert.ok(Number.isNaN(gibInputToBytes("abc")));
  assert.equal(hoursInputToNumber("72"), 72);
  assert.equal(hoursInputToNumber(""), null);
  assert.ok(Number.isNaN(hoursInputToNumber("0")));

  assert.equal(slugifyStorageProfileId("Cloudflare R2 Archive!"), "cloudflare-r2-archive");
  assert.equal(slugifyStorageProfileId("MinIO v2.0"), "minio-v2-0");
  assert.equal(slugifyStorageProfileId("nas.local"), "nas-local");
  assert.equal(slugifyStorageProfileId("local-default"), "local-default-custom");

  // Profile ID validation matches @ludens/protocol/storage (/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
  const dottedIdValidation = validateStorageProfileDraft(
    {
      ...createEmptyStorageProfileDraft("local"),
      id: "minio-v2.0",
      name: "MinIO v2.0",
    },
    { editingProfile: null, existingIds: [] },
  );
  assert.equal(dottedIdValidation.valid, false);
  assert.equal(dottedIdValidation.errors.id, "invalidId");

  const longId = `archive-${"a".repeat(80)}`;
  const longIdValidation = validateStorageProfileDraft(
    {
      ...createEmptyStorageProfileDraft("local"),
      id: longId,
      name: "Long Profile ID",
    },
    { editingProfile: null, existingIds: [] },
  );
  assert.equal(longIdValidation.valid, true);

  const totals = aggregateStorageFootprint(makeSampleOverview().usage);
  assert.equal(totals.workspaceCount, 2);
  assert.equal(totals.localVideoSegments, 18);
  assert.equal(totals.archivedSegments, 24);
  assert.equal(totals.evictedSegments, 6);
  assert.equal(totals.pinnedSegments, 2);
  assert.equal(totals.totalLocalBytes, 790 * 1024 * 1024 + 2 * GIB_BYTES + 9 * 1024 * 1024);
});

test("S3 & directory profile validation preserves saved secrets when secretAccessKey is left blank", () => {
  const overview = makeSampleOverview();
  const r2Profile = overview.config.profiles[2]!;
  assert.equal(r2Profile.kind, "s3");

  // Untouched redacted profile omits secretAccessKey so server keeps saved secret
  const untouchedInput = redactedProfileToInput(r2Profile);
  assert.equal(untouchedInput.s3?.accessKeyId, "R2AKIAEXAMPLE");
  assert.equal("secretAccessKey" in (untouchedInput.s3 ?? {}), false);

  // Editing existing S3 profile with saved secret allows blank secretAccessKey
  const editDraft = storageProfileToDraft(r2Profile);
  assert.equal(editDraft.s3SecretAccessKey, "");
  const editValidation = validateStorageProfileDraft(editDraft, {
    editingProfile: r2Profile,
    existingIds: ["local-default", "nas-ssd", "cloudflare-r2"],
  });
  assert.equal(editValidation.valid, true);

  const editPayload = draftToStorageProfileInput(editDraft);
  assert.equal("secretAccessKey" in (editPayload.s3 ?? {}), false);

  const testParams = buildStorageTestParamsFromDraft(editDraft, r2Profile);
  assert.equal(testParams?.kind, "s3");
  assert.equal(testParams?.profileId, "cloudflare-r2");
  assert.equal("secretAccessKey" in (testParams?.s3 ?? {}), false);

  // New S3 profile requires secretAccessKey
  const newS3Draft = {
    ...createEmptyStorageProfileDraft("s3"),
    id: "minio-dev",
    name: "MinIO Dev",
    s3Endpoint: "http://127.0.0.1:9000",
    s3Region: "us-east-1",
    s3Bucket: "timeline",
    s3AccessKeyId: "minioadmin",
    s3SecretAccessKey: "",
  };
  const missingSecretValidation = validateStorageProfileDraft(newS3Draft, {
    editingProfile: null,
    existingIds: ["local-default"],
  });
  assert.equal(missingSecretValidation.valid, false);
  assert.equal(missingSecretValidation.errors.s3SecretAccessKey, "required");

  // Directory profile validates absolute path
  const badDirDraft = {
    ...createEmptyStorageProfileDraft("directory"),
    id: "rel-dir",
    name: "Relative Dir",
    directoryPath: "relative/path",
  };
  const badDirValidation = validateStorageProfileDraft(badDirDraft, {
    editingProfile: null,
    existingIds: [],
  });
  assert.equal(badDirValidation.valid, false);
  assert.equal(badDirValidation.errors.directoryPath, "invalidAbsolutePath");
});

test("workspace storage override draft roundtrips inherit, ephemeral, local, and profile modes", () => {
  const inherited = workspaceStorageToDraft(undefined, "local-default");
  assert.equal(inherited.mode, "inherit");
  assert.equal(draftToWorkspaceStorageOverride(inherited).override, null);
  assert.equal(sameWorkspaceStorageOverride(undefined, { mode: "inherit" }), true);

  const inheritWithQuality = draftToWorkspaceStorageOverride({
    ...inherited,
    videoQuality: "high",
  });
  assert.deepEqual(inheritWithQuality.override, {
    mode: "inherit",
    videoQuality: "high",
  });

  const profileDraft = workspaceStorageToDraft(
    {
      mode: "profile",
      profileId: "cloudflare-r2",
      maxBytes: 50 * GIB_BYTES,
      videoQuality: "compact",
    },
    "local-default",
  );
  assert.equal(profileDraft.mode, "profile");
  assert.equal(profileDraft.profileId, "cloudflare-r2");
  assert.equal(profileDraft.maxGib, "50");
  assert.equal(profileDraft.videoQuality, "compact");

  const converted = draftToWorkspaceStorageOverride(profileDraft);
  assert.equal(converted.errorCode, null);
  assert.deepEqual(converted.override, {
    mode: "profile",
    profileId: "cloudflare-r2",
    maxBytes: 50 * GIB_BYTES,
    videoQuality: "compact",
  });

  // Ephemeral strips byte quotas cleanly
  assert.deepEqual(
    normalizeWorkspaceStorageOverride({
      mode: "ephemeral",
      maxBytes: 10 * GIB_BYTES,
    }),
    { mode: "ephemeral" },
  );
});

test("SettingsView exposes Recording & Storage right after Workspace Defaults and SSR-renders StorageSettings cleanly", () => {
  const settingsHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(SettingsView, {
        follow: MOCK_FOLLOW,
        projects: PROJECTS,
        initialCategory: "storage",
      }),
    ),
  );
  const navMatches = [
    ...settingsHtml.matchAll(
      /data-slot="settings-nav-item"[\s\S]*?<span class="settings-nav-item-label">([^<]+)<\/span>/g,
    ),
  ].map(match => match[1]);
  assert.deepEqual(navMatches, [
    escapeHtml(en.settings.categories.general),
    escapeHtml(en.settings.categories.defaults),
    escapeHtml(en.settings.categories.storage),
    escapeHtml(en.settings.categories.transport),
    escapeHtml(en.settings.categories.pet),
  ]);
  assert.match(settingsHtml, /data-storage-settings/);
  assert.doesNotMatch(settingsHtml, /data-slot="card"/);

  // Render StorageSettings with rich overview snapshot
  const overview = makeSampleOverview();
  const storageHtml = renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(StorageSettings, { initialData: overview })),
  );
  assert.match(storageHtml, /data-storage-action="prune-all"/);
  assert.match(storageHtml, /data-storage-action="sync-all"/);
  assert.match(storageHtml, /data-storage-workspace="ws-alpha"/);
  assert.match(storageHtml, /data-storage-workspace="ws-beta"/);
  assert.equal((storageHtml.match(/data-storage-ws-action="prune"/g) ?? []).length, 2);
  assert.equal((storageHtml.match(/data-storage-ws-action="sync"/g) ?? []).length, 2);
  assert.equal((storageHtml.match(/data-storage-ws-action="clear_cache"/g) ?? []).length, 2);

  // Built-in local-default has edit button, no delete button; custom profiles have delete button
  assert.match(storageHtml, /data-storage-edit-profile="local-default"/);
  assert.doesNotMatch(storageHtml, /data-storage-delete-profile="local-default"/);
  assert.match(storageHtml, /data-storage-delete-profile="nas-ssd"/);
  assert.match(storageHtml, /data-storage-delete-profile="cloudflare-r2"/);
  assert.ok(storageHtml.includes(escapeHtml(en.storageSettings.secretSavedBadge)));
});

test("StorageProfileForm SSR-renders S3 saved-secret placeholder, test connection button, and latency feedback", () => {
  const overview = makeSampleOverview();
  const r2Profile = overview.config.profiles[2]!;

  const s3FormHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(StorageProfileForm, {
        editingProfile: r2Profile,
        existingIds: ["local-default", "nas-ssd", "cloudflare-r2"],
        initialTestResult: { ok: true, latencyMs: 42, detail: "Read/write probe verified" },
        onCancel() {},
        async onSave() {},
        async onTest() {
          return { ok: true, latencyMs: 42 };
        },
      }),
    ),
  );
  assert.ok(s3FormHtml.includes(escapeHtml(en.storageSettings.fieldS3SecretPlaceholderSaved)));
  assert.match(s3FormHtml, /data-storage-test-backend="s3"/);
  assert.match(s3FormHtml, /OK · 42ms/);

  const dirProfile = overview.config.profiles[1]!;
  const dirFormHtml = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(StorageProfileForm, {
        editingProfile: dirProfile,
        existingIds: ["local-default", "nas-ssd"],
        onCancel() {},
        async onSave() {},
        async onTest() {
          return { ok: true, latencyMs: 3 };
        },
      }),
    ),
  );
  assert.match(dirFormHtml, /data-storage-test-backend="directory"/);
  assert.match(dirFormHtml, /\/Volumes\/NAS\/ludens-media/);
});

test("WorkspaceStudio ModelAndBudgetPanel SSR-renders Timeline Storage Policy override controls", () => {
  const overview = makeSampleOverview();
  const studio = makeStudioSnapshot({
    mode: "profile",
    profileId: "cloudflare-r2",
    maxBytes: 50 * GIB_BYTES,
    videoQuality: "high",
  });

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(ModelAndBudgetPanel, {
        studio,
        isZh: false,
        workspaceRunning: false,
        storageConfig: overview.config,
        onSaved() {},
        onOpenSimulator() {},
        onOpenConnection() {},
        onOpenGlobalStorage() {},
      }),
    ),
  );

  assert.ok(html.includes(escapeHtml(en.workspaceStudio.storageSection.title)));
  assert.match(html, /data-workspace-storage-mode/);
  assert.match(html, /data-workspace-storage-profile/);
  assert.match(html, /data-workspace-storage-max-gib/);
  assert.match(html, /data-workspace-storage-quality/);
  assert.match(html, /Cloudflare R2 Archive \(s3\)/);
  assert.doesNotMatch(html, /data-slot="card"/);
});

test("zh.json and en.json maintain 1:1 key and placeholder parity for storage settings and studio overrides", () => {
  const flatten = (obj: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        flatten(v, prefix ? `${prefix}.${k}` : k, out);
      }
    } else if (typeof obj === "string") {
      out.set(prefix, obj);
    }
    return out;
  };

  const enFlat = flatten(en);
  const zhFlat = flatten(zh);
  assert.deepEqual([...enFlat.keys()].sort(), [...zhFlat.keys()].sort());

  const extractPlaceholders = (text: string) =>
    [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();

  for (const [key, enVal] of enFlat.entries()) {
    const zhVal = zhFlat.get(key);
    assert.ok(zhVal !== undefined, `Missing key in zh.json: ${key}`);
    assert.deepEqual(
      extractPlaceholders(enVal),
      extractPlaceholders(zhVal),
      `Placeholder mismatch on ${key}: en="${enVal}" vs zh="${zhVal}"`,
    );
  }
});
