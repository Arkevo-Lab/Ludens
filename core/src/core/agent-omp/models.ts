import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverAuthStorage, ModelRegistry, Settings, type AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { mergeConnectionConfig, readGlobalConfig, validateConnectionConfig, type ModelConnectionConfig } from "@ludens/protocol/ludens";
import type { AvailableModelItem, AvailableModelsCatalog } from "../query/available-models";

export type { AvailableModelItem, AvailableModelsCatalog };

export function ompSettingsOverrides(options: {
  compactionThreshold?: number;
  connection?: ModelConnectionConfig;
}): Record<string, unknown> {
  const connection = options.connection;
  return {
    // Host invariant: fallback models may lack image input, and device control
    // plus run attribution require the selected model to stay sticky.
    "retry.modelFallback": false,
    // Headless host: title generation is a stray model call outside control cycles.
    "title.refreshOnReplan": false,
    // Experiment with the existing OMP compactor; keep its native history,
    // background preparation and image retention policy intact.
    ...(options.compactionThreshold === undefined ? {} : { "compaction.thresholdTokens": options.compactionThreshold }),
    ...(connection?.openaiWebsockets === undefined ? {} : { "providers.openaiWebsockets": connection.openaiWebsockets }),
    ...(connection?.cacheRetention === undefined ? {} : { "providers.cacheRetention": connection.cacheRetention }),
    ...(connection?.appendOnlyContext === undefined ? {} : { "provider.appendOnlyContext": connection.appendOnlyContext }),
    ...(connection?.imageUrls?.enabled === undefined ? {} : { "images.urls.enabled": connection.imageUrls.enabled }),
    ...(connection?.imageUrls?.backends === undefined ? {} : { "images.urls.backends": [...connection.imageUrls.backends] }),
  };
}

/** Resolve a `<provider>/<id>` selector to an image-capable OMP model carrying `imageCountBudget: Infinity`. */
export function resolveOmpImageModel(modelRegistry: ModelRegistry, selector: string): Model {
  const trimmed = selector.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`An image-capable model is required: ${selector}`);
  }
  const provider = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  const found = modelRegistry.find(provider, id);
  if (!found || !found.input.includes("image")) {
    throw new Error(`An image-capable model is required: ${selector}`);
  }
  // Harness image policy: win over every catalog budget without patching.
  return { ...found, imageCountBudget: Infinity };
}

export async function listAvailableOmpModels(options?: {
  workspace?: string;
  home?: string;
  currentModel?: string | null;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
}): Promise<AvailableModelsCatalog> {
  const globalConfig = await readGlobalConfig(options?.home).catch(() => undefined);
  const workspaceConfig = options?.workspace
    ? await readFile(join(options.workspace, "ludens.json"), "utf8")
      .then(text => JSON.parse(text) as Record<string, unknown>)
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  let workspaceConnection: ModelConnectionConfig | undefined;
  if (workspaceConfig?.connection !== undefined) {
    try {
      workspaceConnection = validateConnectionConfig(workspaceConfig.connection, "ludens.json connection");
    } catch {
      workspaceConnection = undefined;
    }
  }
  const connection = mergeConnectionConfig(globalConfig?.defaults.connection, workspaceConnection);
  const settings = Settings.isolated(ompSettingsOverrides({ connection }));

  let ownedAuth: AuthStorage | undefined;
  try {
    let registry = options?.modelRegistry;
    if (!registry) {
      const authStorage = options?.authStorage ?? (ownedAuth = await discoverAuthStorage(undefined, {
        settings,
        cwd: options?.workspace ?? process.cwd(),
      }));
      registry = new ModelRegistry(authStorage, undefined, { settings });
      await registry.hydrateCredentialScopedModelCaches().catch(() => {});
    }

    const availableKeys = new Set(registry.getAvailable().map(model => `${model.provider}/${model.id}`));
    const seen = new Set<string>();
    const models: AvailableModelItem[] = [];
    const providerStats = new Map<string, { count: number; authenticated: boolean }>();

    for (const model of registry.getAll()) {
      if (!Array.isArray(model.input) || !model.input.includes("image")) continue;
      const fullId = `${model.provider}/${model.id}`;
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      const authenticated = availableKeys.has(fullId) || registry.hasConfiguredAuth(model);
      models.push({
        fullId,
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? 0,
        authenticated,
      });
      const stat = providerStats.get(model.provider) ?? { count: 0, authenticated: false };
      stat.count += 1;
      if (authenticated) stat.authenticated = true;
      providerStats.set(model.provider, stat);
    }

    models.sort((a, b) => {
      if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
      const byProvider = a.provider.localeCompare(b.provider);
      if (byProvider !== 0) return byProvider;
      return a.id.localeCompare(b.id);
    });

    const providers = [...providerStats.entries()]
      .map(([id, stat]) => ({ id, count: stat.count, authenticated: stat.authenticated }))
      .sort((a, b) => {
        if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
        return a.id.localeCompare(b.id);
      });

    const resolvedCurrentModel = options && "currentModel" in options
      ? options.currentModel
      : typeof workspaceConfig?.model === "string" && workspaceConfig.model.trim()
        ? workspaceConfig.model.trim()
        : globalConfig?.defaults.model ?? "openai-codex/gpt-6.1-sol";

    return {
      models,
      providers,
      currentModel: resolvedCurrentModel,
    };
  } finally {
    ownedAuth?.close();
  }
}
