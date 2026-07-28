import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  type PackageSource,
  SettingsManager,
  parseFrontmatter,
  stripFrontmatter,
  type ExtensionFactory,
  type PathMetadata,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeLoginCallbacks,
  RuntimeExtensionDiagnostic,
  RuntimeExtensionRecord,
  RuntimeModelRecord,
  RuntimeProviderRecord,
  RuntimeResourceDriver,
  RuntimeSettingsSnapshot,
  RuntimeSkillRecord,
  RuntimeSourceInfo,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { createRuntimeDependencies } from "./runtime-deps.js";
import { createSettingsManagerWithoutNpmPackages, isGlobalNpmLookupError } from "./npm-package-fallback.js";
import { skillSlashCommand } from "./runtime-command-utils.js";
import type { AuthStatus, AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  BUILT_IN_PROVIDER_IDS,
  CustomProviderStore,
  type CustomProviderEntry,
  type CustomProviderInput,
} from "./custom-provider-store.js";

export {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
} from "./custom-provider-store.js";
export type { CustomProviderEntry, CustomProviderInput, CustomProviderModelInput } from "./custom-provider-store.js";

interface ModelSettingsSnapshot {
  readonly defaultProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultThinkingLevel?: RuntimeSettingsSnapshot["defaultThinkingLevel"];
  readonly enabledModelPatterns: readonly string[];
}

/** A queued `pi.registerProvider()` call, as the extension runtime records it. */
type ExtensionProviderRegistration =
  ReturnType<DefaultResourceLoader["getExtensions"]>["runtime"]["pendingProviderRegistrations"][number];

interface RuntimeContext {
  readonly workspace: WorkspaceRef;
  readonly settingsManager: SettingsManager;
  readonly packageManager: DefaultPackageManager;
  readonly resourceLoader: DefaultResourceLoader;
  /** `registerProvider()` calls this workspace's extensions made, in call order. */
  extensionProviders: readonly ExtensionProviderRegistration[];
  /** Registry the snapshot is built from, owned by this workspace. */
  modelRegistry: ModelRegistry;
}

export interface RuntimeInlineExtensionMetadata {
  readonly displayName: string;
  readonly description?: string;
}

interface ProjectWritableSettingsManager {
  markProjectModified(field: string, nestedKey?: string): void;
  saveProjectSettings(settings: Record<string, unknown>): void;
}

export interface RuntimeSupervisorOptions {
  readonly agentDir?: string;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry?: ModelRegistry;
  readonly extensionFactories?: readonly ExtensionFactory[];
  readonly inlineExtensionMetadata?: readonly RuntimeInlineExtensionMetadata[];
  readonly customProviderStore?: CustomProviderStore;
}

type ResourceScope = "user" | "project";
type ToggleableResourceKind = "extension" | "skill";

interface PackageMetadata {
  readonly displayName?: string;
  readonly description?: string;
}

export class RuntimeSupervisor implements RuntimeResourceDriver {
  private readonly agentDir: string;
  private readonly modelsJsonPath: string;
  private readonly authStorage: AuthStorage;
  /**
   * The driver's process-wide registry, kept in sync with auth and models.json.
   *
   * Not what snapshots or sessions read: those own workspace- and cwd-scoped
   * registries. It still backs the driver's own model lookups (thread titles).
   */
  private readonly sharedModelRegistry: ModelRegistry;
  private readonly extensionFactories: readonly ExtensionFactory[];
  private readonly inlineExtensionMetadata: readonly RuntimeInlineExtensionMetadata[];
  private readonly customProviderStore: CustomProviderStore;
  private readonly contexts = new Map<string, RuntimeContext>();

  constructor(options: RuntimeSupervisorOptions = {}) {
    const deps = createRuntimeDependencies(options);
    this.agentDir = deps.agentDir;
    this.modelsJsonPath = deps.modelsJsonPath;
    this.authStorage = deps.authStorage;
    this.sharedModelRegistry = deps.modelRegistry;
    this.extensionFactories = options.extensionFactories ?? [];
    this.inlineExtensionMetadata = options.inlineExtensionMetadata ?? [];
    this.customProviderStore = deps.customProviderStore;
  }

  async getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    return this.buildSnapshot(context);
  }

  async refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.reload();
    this.authStorage.reload();
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    await this.autoEnableModelsForAuthenticatedProviders(context);
    return this.buildSnapshot(context);
  }

  async login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.authStorage.login(providerId, toPiOAuthLoginCallbacks(callbacks));
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    await this.autoEnableModelsForAuthenticatedProviders(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    this.authStorage.logout(providerId);
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    return this.buildSnapshot(context);
  }

  async setProviderApiKey(workspace: WorkspaceRef, providerId: string, apiKey: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new Error("API key is required.");
    }
    if (!providerSupportsDesktopApiKeySetup(providerId)) {
      throw new Error(`API key setup is not supported for ${providerId}.`);
    }
    this.authStorage.set(providerId, { type: "api_key", key: normalized });
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    await this.autoEnableModelsForAuthenticatedProviders(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async listCustomProviders(): Promise<readonly CustomProviderEntry[]> {
    return this.customProviderStore.list();
  }

  async setCustomProvider(workspace: WorkspaceRef, input: CustomProviderInput): Promise<RuntimeSnapshot> {
    const oauthProviderIds = new Set(this.authStorage.getOAuthProviders().map((provider) => provider.id));
    if (BUILT_IN_PROVIDER_IDS.has(input.providerId) || oauthProviderIds.has(input.providerId)) {
      throw new Error(
        `Provider ID "${input.providerId}" conflicts with a built-in provider. Pick a unique ID.`,
      );
    }
    const context = await this.ensureContext(workspace);
    await this.customProviderStore.set(input);
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    await this.autoEnableModelsForAuthenticatedProviders(context, [input.providerId]);
    return this.buildSnapshot(context);
  }

  async deleteCustomProvider(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.customProviderStore.delete(providerId);
    this.sharedModelRegistry.refresh();
    await this.reloadResources(context);
    return this.buildSnapshot(context);
  }

  async setDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setDefaultModelAndProvider(selection.provider, selection.modelId);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.defaultProvider = selection.provider;
    projectSettings.defaultModel = selection.modelId;
    settingsManager.markProjectModified("defaultProvider");
    settingsManager.markProjectModified("defaultModel");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async setDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    if (!thinkingLevel) {
      throw new Error("Thinking level is required.");
    }
    context.settingsManager.setDefaultThinkingLevel(thinkingLevel);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    if (!thinkingLevel) {
      throw new Error("Thinking level is required.");
    }
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.defaultThinkingLevel = thinkingLevel;
    settingsManager.markProjectModified("defaultThinkingLevel");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnableSkillCommands(enabled);
    await context.settingsManager.flush();
    await this.reloadResources(context);
    return this.buildSnapshot(context);
  }

  async setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnabledModels(patterns.length > 0 ? [...patterns] : undefined);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setProjectScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const settingsManager = context.settingsManager as unknown as ProjectWritableSettingsManager;
    const projectSettings = context.settingsManager.getProjectSettings() as Record<string, unknown>;
    projectSettings.enabledModels = patterns.length > 0 ? [...patterns] : undefined;
    settingsManager.markProjectModified("enabledModels");
    settingsManager.saveProjectSettings(projectSettings);
    await context.settingsManager.flush();
    context.settingsManager.reload();
    return this.buildSnapshot(context);
  }

  async getGlobalModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot> {
    const context = await this.ensureContext(workspace);
    return toModelSettingsSnapshot(context.settingsManager.getGlobalSettings() as Record<string, unknown>);
  }

  async getCurrentModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot> {
    const globalSettings = await readJsonRecord(join(this.agentDir, "settings.json"));
    const projectSettings = await readJsonRecord(join(workspace.path, ".pi", "settings.json"));
    const globalModelSettings = toModelSettingsSnapshot(globalSettings);
    const projectModelSettings = toModelSettingsSnapshot(projectSettings);
    const snapshot: {
      defaultProvider?: string;
      defaultModelId?: string;
      defaultThinkingLevel?: ModelSettingsSnapshot["defaultThinkingLevel"];
      enabledModelPatterns: readonly string[];
    } = {
      enabledModelPatterns: Array.isArray(projectSettings.enabledModels)
        ? projectModelSettings.enabledModelPatterns
        : globalModelSettings.enabledModelPatterns,
    };

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultProvider")) {
      if (projectModelSettings.defaultProvider) {
        snapshot.defaultProvider = projectModelSettings.defaultProvider;
      }
    } else if (globalModelSettings.defaultProvider) {
      snapshot.defaultProvider = globalModelSettings.defaultProvider;
    }

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultModel")) {
      if (projectModelSettings.defaultModelId) {
        snapshot.defaultModelId = projectModelSettings.defaultModelId;
      }
    } else if (globalModelSettings.defaultModelId) {
      snapshot.defaultModelId = globalModelSettings.defaultModelId;
    }

    if (Object.prototype.hasOwnProperty.call(projectSettings, "defaultThinkingLevel")) {
      if (projectModelSettings.defaultThinkingLevel) {
        snapshot.defaultThinkingLevel = projectModelSettings.defaultThinkingLevel;
      }
    } else if (globalModelSettings.defaultThinkingLevel) {
      snapshot.defaultThinkingLevel = globalModelSettings.defaultThinkingLevel;
    }

    return snapshot;
  }

  async setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.skills.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown skill: ${filePath}`);
    }

    this.toggleResource(context, resource, enabled, "skill");
    await context.settingsManager.flush();
    await this.reloadResources(context);
    return this.buildSnapshot(context);
  }

  async setExtensionEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.extensions.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown extension: ${filePath}`);
    }

    this.toggleResource(context, resource, enabled, "extension");
    await context.settingsManager.flush();
    await this.reloadResources(context);
    return this.buildSnapshot(context);
  }

  private async ensureContext(workspace: WorkspaceRef): Promise<RuntimeContext> {
    const existing = this.contexts.get(workspace.workspaceId);
    if (existing) {
      return existing;
    }

    let settingsManager = SettingsManager.create(workspace.path, this.agentDir);
    let packageManager = new DefaultPackageManager({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
    });
    let resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [...this.extensionFactories],
    });
    try {
      await resourceLoader.reload();
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime resource loading without npm package sources for ${workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      settingsManager = fallbackSettingsManager;
      packageManager = new DefaultPackageManager({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
      });
      resourceLoader = new DefaultResourceLoader({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
        extensionFactories: [...this.extensionFactories],
      });
      await resourceLoader.reload();
    }

    const { registry, accepted } = this.buildModelRegistry(this.drainExtensionProviders(resourceLoader));
    const context: RuntimeContext = {
      workspace,
      settingsManager,
      packageManager,
      resourceLoader,
      extensionProviders: accepted,
      modelRegistry: registry,
    };
    this.contexts.set(workspace.workspaceId, context);
    return context;
  }

  /**
   * Drop a workspace's cached context.
   *
   * Contexts hold that workspace's resource loader, settings manager, and model
   * registry, so a removed workspace has to give them up — otherwise its
   * extensions keep their providers alive for the rest of the process.
   */
  removeWorkspace(workspaceId: WorkspaceRef["workspaceId"]): void {
    this.contexts.delete(workspaceId);
  }

  private async reloadResources(context: RuntimeContext): Promise<void> {
    await context.resourceLoader.reload();
    const { registry, accepted } = this.buildModelRegistry(this.drainExtensionProviders(context.resourceLoader));
    context.extensionProviders = accepted;
    context.modelRegistry = registry;
  }

  /**
   * Drain the providers this workspace's extensions registered while loading.
   *
   * `pi` queues `pi.registerProvider()` calls made during extension load on the
   * resource loader's extension runtime and flushes them when session services are
   * created (`createAgentSessionServices`). The runtime snapshot never goes through
   * that path, so without this the model list only ever shows built-ins,
   * `models.json` providers, and custom providers — extension-provided models are
   * invisible in settings and pickers even though sessions can use them.
   *
   * Each reload replays every enabled extension, so the drained queue is the
   * workspace's complete current set: providers whose extension was disabled or
   * removed simply do not come back.
   *
   * The queue is kept in call order rather than collapsed per provider id.
   * `registerProvider()` is a merge, not an assignment — a full registration
   * followed by a `baseUrl`-only one keeps the models and re-points them — so
   * only replaying every call reproduces what `pi` itself would build.
   */
  private drainExtensionProviders(resourceLoader: DefaultResourceLoader): ExtensionProviderRegistration[] {
    const { runtime } = resourceLoader.getExtensions();
    const registrations = [...runtime.pendingProviderRegistrations];
    runtime.pendingProviderRegistrations = [];
    return registrations;
  }

  /**
   * Build a registry from disk plus the given workspace's extension providers.
   *
   * A fresh instance rather than `refresh()`: refreshing resets the process-wide
   * API and OAuth provider registrations and reapplies only the refreshed
   * registry's providers, which would strip registrations owned by session
   * registries. Constructing a registry has the same cost and no global effect.
   *
   * Returns the registrations that were accepted, so a config `pi` rejects is
   * dropped from the workspace's set instead of warning on every rebuild.
   */
  private buildModelRegistry(registrations: readonly ExtensionProviderRegistration[]): {
    readonly registry: ModelRegistry;
    readonly accepted: ExtensionProviderRegistration[];
  } {
    const registry = ModelRegistry.create(this.authStorage, this.modelsJsonPath);
    const accepted: ExtensionProviderRegistration[] = [];
    for (const registration of registrations) {
      const { name, config, extensionPath } = registration;
      try {
        // Copy: registering merges into the stored config object in place, which
        // would let a later registration rewrite our captured config.
        registry.registerProvider(name, { ...config });
        accepted.push(registration);
      } catch (error) {
        console.warn(
          `[pi-gui] Extension "${extensionPath}" failed to register provider "${name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { registry, accepted };
  }

  private async buildSnapshot(context: RuntimeContext): Promise<RuntimeSnapshot> {
    // Pick up auth and models.json edits made since the last load. The shared
    // registry is refreshed first so it, not a workspace registry, ends up owning
    // the process-wide API and OAuth registrations.
    this.sharedModelRegistry.refresh();
    const { registry, accepted } = this.buildModelRegistry(context.extensionProviders);
    context.extensionProviders = accepted;
    context.modelRegistry = registry;
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const [skills, extensions, providers, models] = await Promise.all([
      this.buildSkillRecords(context, resolvedPaths.skills),
      this.buildExtensionRecords(context, resolvedPaths.extensions),
      this.buildProviderRecords(context),
      this.buildModelRecords(context),
    ]);

    const defaultProvider = context.settingsManager.getDefaultProvider();
    const defaultModelId = context.settingsManager.getDefaultModel();
    const defaultThinkingLevel = context.settingsManager.getDefaultThinkingLevel();
    const settings: RuntimeSettingsSnapshot = {
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      enableSkillCommands: context.settingsManager.getEnableSkillCommands(),
      enabledModelPatterns: context.settingsManager.getEnabledModels() ?? [],
    };

    return {
      workspace: context.workspace,
      providers,
      models,
      skills,
      extensions,
      settings,
    };
  }

  private async resolveRuntimePaths(context: RuntimeContext): Promise<ResolvedPaths> {
    try {
      return await context.packageManager.resolve();
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(context.settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime package resolution without npm package sources for ${context.workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const fallbackPackageManager = new DefaultPackageManager({
        cwd: context.workspace.path,
        agentDir: this.agentDir,
        settingsManager: fallbackSettingsManager,
      });
      return fallbackPackageManager.resolve();
    }
  }

  private async buildProviderRecords(context: RuntimeContext): Promise<readonly RuntimeProviderRecord[]> {
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
    const providerIds = new Set<string>([
      ...context.modelRegistry.getAll().map((model) => model.provider),
      ...oauthProviders.keys(),
      ...this.authStorage.list(),
    ]);

    return [...providerIds]
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => {
        const auth = this.authStorage.get(providerId);
        const oauthProvider = oauthProviders.get(providerId);
        const apiKeySetupSupported = providerSupportsDesktopApiKeySetup(providerId);
        const providerAuthStatus = context.modelRegistry.getProviderAuthStatus(providerId);
        const hasAuth = providerAuthStatus.configured || this.authStorage.hasAuth(providerId);
        return {
          id: providerId,
          name: oauthProvider?.name ?? providerId,
          hasAuth,
          authType: auth?.type ?? "none",
          authSource: inferProviderAuthSource(auth, providerAuthStatus, apiKeySetupSupported),
          oauthSupported: Boolean(oauthProvider),
          apiKeySetupSupported,
        };
      });
  }

  private async buildModelRecords(context: RuntimeContext): Promise<readonly RuntimeModelRecord[]> {
    const availableKeys = new Set(
      (await context.modelRegistry.getAvailable()).map((model) => `${model.provider}:${model.id}`),
    );
    const providers = new Map((await this.buildProviderRecords(context)).map((provider) => [provider.id, provider]));

    return context.modelRegistry
      .getAll()
      .map<RuntimeModelRecord>((model) => {
        const provider = providers.get(model.provider);
        return {
          providerId: model.provider,
          providerName: provider?.name ?? model.provider,
          modelId: model.id,
          label: model.name,
          available: availableKeys.has(`${model.provider}:${model.id}`),
          authType: provider?.authType ?? "none",
          reasoning: Boolean(model.reasoning),
          supportsImages: model.input.includes("image"),
        };
      })
      .sort((left, right) =>
        left.providerId === right.providerId
          ? left.modelId.localeCompare(right.modelId)
          : left.providerId.localeCompare(right.providerId),
      );
  }

  private async autoEnableModelsForAuthenticatedProviders(
    context: RuntimeContext,
    providerIds?: readonly string[],
  ): Promise<void> {
    const currentPatterns = context.settingsManager.getEnabledModels() ?? [];
    if (currentPatterns.length === 0) {
      return;
    }

    const providers = await this.buildProviderRecords(context);
    const models = await this.buildModelRecords(context);
    const hasSelectableModels = models.some((model) =>
      model.available && currentPatterns.includes(`${model.providerId}/${model.modelId}`),
    );
    const candidateProviderIds =
      providerIds && providerIds.length > 0
        ? providerIds
        : hasSelectableModels
          ? []
          : providers
              .filter((provider) => provider.hasAuth)
              .map((provider) => provider.id);
    if (candidateProviderIds.length === 0) {
      return;
    }

    const candidateProviderSet = new Set(candidateProviderIds);
    const nextPatterns = mergeEnabledModelPatterns(
      currentPatterns,
      models
        .filter((model) => model.available && candidateProviderSet.has(model.providerId))
        .map((model) => `${model.providerId}/${model.modelId}`),
    );
    if (nextPatterns.length === currentPatterns.length) {
      return;
    }

    context.settingsManager.setEnabledModels([...nextPatterns]);
    await context.settingsManager.flush();
  }

  private async buildSkillRecords(
    context: RuntimeContext,
    resolvedSkills: readonly ResolvedResource[],
  ): Promise<readonly RuntimeSkillRecord[]> {
    const loadedSkills = new Map(
      context.resourceLoader
        .getSkills()
        .skills.map((skill) => [resolve(skill.filePath), skill] as const),
    );

    const records = await Promise.all(
      resolvedSkills.map(async (resource) => {
        const filePath = resolve(resource.path);
        const loaded = loadedSkills.get(filePath);
        const fallback = loaded ? undefined : await readSkillMetadata(filePath);
        const name = loaded?.name ?? fallback?.name ?? inferSkillName(filePath);
        const description = loaded?.description ?? fallback?.description ?? "No description provided.";
        const disableModelInvocation = loaded?.disableModelInvocation ?? fallback?.disableModelInvocation ?? false;

        return {
          name,
          description,
          filePath,
          baseDir: loaded?.baseDir ?? dirname(filePath),
          source: resource.metadata.source,
          enabled: resource.enabled,
          disableModelInvocation,
          slashCommand: skillSlashCommand(name),
        } satisfies RuntimeSkillRecord;
      }),
    );

    return records.sort((left: RuntimeSkillRecord, right: RuntimeSkillRecord) => left.name.localeCompare(right.name));
  }

  private async buildExtensionRecords(
    context: RuntimeContext,
    resolvedExtensions: readonly ResolvedResource[],
  ): Promise<readonly RuntimeExtensionRecord[]> {
    const loadedResult = context.resourceLoader.getExtensions();
    const packageMetadataCache = new Map<string, Promise<PackageMetadata>>();
    const loadedByPath = new Map(
      loadedResult.extensions.map((extension) => [resolve(extension.resolvedPath || extension.path), extension] as const),
    );
    const diagnosticsByPath = new Map<string, RuntimeExtensionDiagnostic[]>();

    for (const error of loadedResult.errors) {
      const diagnostics = diagnosticsByPath.get(resolve(error.path)) ?? [];
      diagnostics.push({
        type: "error",
        message: error.error,
        path: error.path,
      });
      diagnosticsByPath.set(resolve(error.path), diagnostics);
    }

    const records = await Promise.all(
      resolvedExtensions.map<Promise<RuntimeExtensionRecord>>(async (resource) => {
        const path = resolve(resource.path);
        const loaded = loadedByPath.get(path);
        const packageMetadata = await inferExtensionPackageMetadata(resource.metadata, packageMetadataCache);
        return {
          path,
          displayName: packageMetadata?.displayName ?? inferExtensionEntryName(path),
          ...(packageMetadata?.description ? { description: packageMetadata.description } : {}),
          enabled: resource.enabled,
          sourceInfo: toRuntimeSourceInfo(path, resource.metadata),
          commands: loaded ? [...loaded.commands.keys()].sort((left, right) => left.localeCompare(right)) : [],
          tools: loaded
            ? [...loaded.tools.values()]
                .map((tool) => tool.definition.name)
                .sort((left, right) => left.localeCompare(right))
            : [],
          flags: loaded ? [...loaded.flags.keys()].sort((left, right) => left.localeCompare(right)) : [],
          shortcuts: loaded ? [...loaded.shortcuts.keys()].sort((left, right) => left.localeCompare(right)) : [],
          diagnostics: diagnosticsByPath.get(path) ?? [],
        };
      }),
    );
    const resolvedRecordPaths = new Set(records.map((record) => resolve(record.path)));
    const inlineRecords = loadedResult.extensions
      .filter((extension) => extension.path.startsWith("<inline:") && !resolvedRecordPaths.has(resolve(extension.path)))
      .map((extension) => this.buildInlineExtensionRecord(extension));
    records.push(...inlineRecords);

    return records.sort((left, right) =>
      left.displayName === right.displayName
        ? left.path.localeCompare(right.path)
        : left.displayName.localeCompare(right.displayName),
    );
  }

  private buildInlineExtensionRecord(extension: ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number]): RuntimeExtensionRecord {
    const metadata = inlineExtensionMetadataForPath(extension.path, this.inlineExtensionMetadata);
    return {
      path: extension.path,
      displayName: metadata.displayName,
      ...(metadata.description ? { description: metadata.description } : {}),
      enabled: true,
      sourceInfo: {
        path: extension.path,
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
      commands: [...extension.commands.keys()].sort((left, right) => left.localeCompare(right)),
      tools: [...extension.tools.values()]
        .map((tool) => tool.definition.name)
        .sort((left, right) => left.localeCompare(right)),
      flags: [...extension.flags.keys()].sort((left, right) => left.localeCompare(right)),
      shortcuts: [...extension.shortcuts.keys()].sort((left, right) => left.localeCompare(right)),
      diagnostics: [],
    };
  }

  private toggleResource(
    context: RuntimeContext,
    resource: ResolvedResource,
    enabled: boolean,
    kind: ToggleableResourceKind,
  ): void {
    const { settingsManager } = context;
    const scope = resource.metadata.scope;
    if (scope !== "project" && scope !== "user") {
      throw new Error(`Cannot update ${kind} at scope ${scope}`);
    }
    const origin = resource.metadata.origin;
    const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
    const pattern = this.relativeResourcePattern(resource.path, resource.metadata, scope, origin);

    if (origin === "top-level") {
      const currentPaths = kind === "skill" ? [...(settings.skills ?? [])] : [...(settings.extensions ?? [])];
      const updated = replaceResourcePattern(currentPaths, pattern, enabled);
      this.setTopLevelResourcePaths(settingsManager, scope, kind, updated);
      return;
    }

    const packages = [...(settings.packages ?? [])];
    const source = resource.metadata.source;
    const packageIndex = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
    if (packageIndex < 0) {
      throw new Error(`${titleForResourceKind(kind)} package source not found for ${resource.path}`);
    }

    const currentPackage = packages[packageIndex];
    const nextPackage = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
    const currentPatterns = kind === "skill" ? [...(nextPackage.skills ?? [])] : [...(nextPackage.extensions ?? [])];
    const updatedPatterns = replaceResourcePattern(currentPatterns, pattern, enabled);
    if (updatedPatterns.length > 0) {
      if (kind === "skill") {
        nextPackage.skills = updatedPatterns;
      } else {
        nextPackage.extensions = updatedPatterns;
      }
    } else {
      if (kind === "skill") {
        delete nextPackage.skills;
      } else {
        delete nextPackage.extensions;
      }
    }

    const hasFilters = ["skills", "extensions", "prompts", "themes"].some((key) =>
      Object.prototype.hasOwnProperty.call(nextPackage, key),
    );
    packages[packageIndex] = (hasFilters ? nextPackage : nextPackage.source) as PackageSource;

    if (scope === "project") {
      settingsManager.setProjectPackages(packages);
    } else {
      settingsManager.setPackages(packages);
    }
  }

  private setTopLevelResourcePaths(
    settingsManager: SettingsManager,
    scope: ResourceScope,
    kind: ToggleableResourceKind,
    paths: string[],
  ): void {
    if (kind === "skill") {
      if (scope === "project") {
        settingsManager.setProjectSkillPaths(paths);
      } else {
        settingsManager.setSkillPaths(paths);
      }
      return;
    }

    if (scope === "project") {
      settingsManager.setProjectExtensionPaths(paths);
    } else {
      settingsManager.setExtensionPaths(paths);
    }
  }

  private relativeResourcePattern(
    filePath: string,
    metadata: PathMetadata,
    scope: ResourceScope,
    origin: PathMetadata["origin"],
  ): string {
    if (origin === "package") {
      const baseDir = metadata.baseDir ?? dirname(filePath);
      return relative(baseDir, filePath);
    }

    const baseDir = metadata.baseDir ?? (scope === "project" ? dirname(filePath) : this.agentDir);
    return relative(baseDir, filePath);
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function replaceResourcePattern(patterns: readonly string[], resourcePattern: string, enabled: boolean): string[] {
  const next = patterns.filter((pattern) => stripPrefix(pattern) !== resourcePattern);
  next.push(`${enabled ? "+" : "-"}${resourcePattern}`);
  return next;
}

function stripPrefix(pattern: string): string {
  return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

async function readSkillMetadata(
  filePath: string,
): Promise<{ name?: string; description?: string; disableModelInvocation?: boolean } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(raw) as
      | {
          name?: string;
          description?: string;
          "disable-model-invocation"?: boolean;
        }
      | undefined;
    const body = stripFrontmatter(raw);
    const metadata: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
    if (frontmatter?.name) {
      metadata.name = frontmatter.name;
    }
    const description = frontmatter?.description ?? firstNonEmptyLine(body);
    if (description) {
      metadata.description = description;
    }
    if (frontmatter?.["disable-model-invocation"] !== undefined) {
      metadata.disableModelInvocation = frontmatter["disable-model-invocation"];
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function inferSkillName(filePath: string): string {
  const parent = basename(dirname(filePath));
  if (basename(filePath).toLowerCase() === "skill.md" && parent) {
    return parent;
  }
  return basename(filePath).replace(/\.md$/i, "");
}

async function inferExtensionPackageMetadata(
  metadata: PathMetadata,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata | undefined> {
  if (metadata.origin === "package" && metadata.baseDir) {
    return inferPackageMetadata(metadata.baseDir, packageMetadataCache);
  }
  return undefined;
}

function inferExtensionEntryName(filePath: string): string {
  return basename(filePath).replace(/\.(c|m)?(t|j)sx?$/i, "");
}

async function inferPackageMetadata(
  packageRoot: string,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata> {
  const normalizedRoot = resolve(packageRoot);
  const cached = packageMetadataCache.get(normalizedRoot);
  if (cached) {
    return cached;
  }

  const pending = readPackageMetadata(normalizedRoot);
  packageMetadataCache.set(normalizedRoot, pending);
  return pending;
}

async function readPackageMetadata(packageRoot: string): Promise<PackageMetadata> {
  const folderName = basename(packageRoot).trim();
  const packageJson = await readJsonRecord(join(packageRoot, "package.json")) as {
    readonly displayName?: unknown;
    readonly description?: unknown;
  };
  const displayName =
    typeof packageJson.displayName === "string" && packageJson.displayName.trim()
      ? packageJson.displayName.trim()
      : folderName;
  const description =
    typeof packageJson.description === "string" && packageJson.description.trim()
      ? packageJson.description.trim()
      : undefined;

  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
  };
}

const DESKTOP_API_KEY_PROVIDER_IDS = new Set([
  "azure-openai-responses",
  "cerebras",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

function providerSupportsDesktopApiKeySetup(providerId: string): boolean {
  return DESKTOP_API_KEY_PROVIDER_IDS.has(providerId);
}

type PiOAuthLoginCallbacks = Parameters<AuthStorage["login"]>[1];

function toPiOAuthLoginCallbacks(callbacks: RuntimeLoginCallbacks): PiOAuthLoginCallbacks {
  return {
    onAuth: callbacks.onAuth,
    onDeviceCode: (info) =>
      callbacks.onAuth({
        url: info.verificationUri,
        instructions: [
          `Enter code: ${info.userCode}`,
          info.expiresInSeconds ? `Expires in ${info.expiresInSeconds} seconds.` : undefined,
        ].filter((line): line is string => Boolean(line)).join("\n"),
      }),
    onPrompt: callbacks.onPrompt,
    onSelect: async (prompt) => {
      const defaultOption = prompt.options[0];
      const choice = await callbacks.onPrompt({
        message: `${prompt.message}\n${prompt.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n")}`,
        allowEmpty: true,
        ...(defaultOption ? { placeholder: defaultOption.label } : {}),
      });
      const normalizedChoice = choice.trim();
      if (!normalizedChoice) {
        return defaultOption?.id;
      }
      const selectedIndex = Number.parseInt(normalizedChoice, 10);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= prompt.options.length) {
        return prompt.options[selectedIndex - 1]?.id;
      }
      return prompt.options.find((option) => option.id === normalizedChoice || option.label === normalizedChoice)?.id;
    },
    ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
    ...(callbacks.onManualCodeInput ? { onManualCodeInput: callbacks.onManualCodeInput } : {}),
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
  };
}

function inferProviderAuthSource(
  auth: { readonly type: "oauth" | "api_key" } | undefined,
  providerAuthStatus: AuthStatus,
  apiKeySetupSupported: boolean,
): "none" | "oauth" | "auth_file" | "env" | "external" {
  if (auth?.type === "oauth") {
    return "oauth";
  }
  if (auth?.type === "api_key") {
    return "auth_file";
  }
  switch (providerAuthStatus.source) {
    case "stored":
      return "auth_file";
    case "environment":
      return "env";
    case "fallback":
    case "models_json_command":
    case "models_json_key":
    case "runtime":
      return "external";
  }
  if (!providerAuthStatus.configured) {
    return "none";
  }
  return apiKeySetupSupported ? "env" : "external";
}

function toRuntimeSourceInfo(path: string, metadata: PathMetadata): RuntimeSourceInfo {
  return {
    path,
    source: metadata.source,
    scope: metadata.scope,
    origin: metadata.origin,
    ...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
  };
}

function inlineExtensionMetadataForPath(
  path: string,
  metadata: readonly RuntimeInlineExtensionMetadata[],
): RuntimeInlineExtensionMetadata {
  const match = /^<inline:(\d+)>$/.exec(path);
  const index = match?.[1] ? Number.parseInt(match[1], 10) - 1 : -1;
  return metadata[index] ?? { displayName: path };
}

function titleForResourceKind(kind: ToggleableResourceKind): string {
  return kind === "skill" ? "Skill" : "Extension";
}

function toModelSettingsSnapshot(settings: Record<string, unknown>): ModelSettingsSnapshot {
  return {
    enabledModelPatterns: Array.isArray(settings.enabledModels)
      ? settings.enabledModels.filter((value): value is string => typeof value === "string")
      : [],
    ...(typeof settings.defaultProvider === "string" ? { defaultProvider: settings.defaultProvider } : {}),
    ...(typeof settings.defaultModel === "string" ? { defaultModelId: settings.defaultModel } : {}),
    ...(typeof settings.defaultThinkingLevel === "string"
      ? { defaultThinkingLevel: settings.defaultThinkingLevel as ModelSettingsSnapshot["defaultThinkingLevel"] }
      : {}),
  } satisfies ModelSettingsSnapshot;
}

function mergeEnabledModelPatterns(
  existingPatterns: readonly string[],
  providerPatterns: readonly string[],
): readonly string[] {
  const merged = [...existingPatterns];
  const seen = new Set(existingPatterns);
  for (const pattern of providerPatterns) {
    if (seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    merged.push(pattern);
  }
  return merged;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
