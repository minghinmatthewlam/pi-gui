import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  type PackageSource,
  SettingsManager,
  parseFrontmatter,
  stripFrontmatter,
  type PathMetadata,
  type ResolvedResource,
} from "@mariozechner/pi-coding-agent";
import type {
  RuntimeLoginCallbacks,
  RuntimeModelRecord,
  RuntimeProviderRecord,
  RuntimeResourceDriver,
  RuntimeSettingsSnapshot,
  RuntimeSkillRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { createRuntimeDependencies } from "./runtime-deps.js";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

interface RuntimeContext {
  readonly workspace: WorkspaceRef;
  readonly settingsManager: SettingsManager;
  readonly packageManager: DefaultPackageManager;
  readonly resourceLoader: DefaultResourceLoader;
}

export interface RuntimeSupervisorOptions {
  readonly agentDir?: string;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry?: ModelRegistry;
}

type ResourceScope = "user" | "project";

export class RuntimeSupervisor implements RuntimeResourceDriver {
  private readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly contexts = new Map<string, RuntimeContext>();

  constructor(options: RuntimeSupervisorOptions = {}) {
    const deps = createRuntimeDependencies(options);
    this.agentDir = deps.agentDir;
    this.authStorage = deps.authStorage;
    this.modelRegistry = deps.modelRegistry;
  }

  async getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    return this.buildSnapshot(context);
  }

  async refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.reload();
    this.authStorage.reload();
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.authStorage.login(providerId, callbacks);
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    this.authStorage.logout(providerId);
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
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

  async setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnableSkillCommands(enabled);
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnabledModels(patterns.length > 0 ? [...patterns] : undefined);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await context.packageManager.resolve();
    const resource = resolvedPaths.skills.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown skill: ${filePath}`);
    }

    this.toggleSkillResource(context, resource, enabled);
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  private async ensureContext(workspace: WorkspaceRef): Promise<RuntimeContext> {
    const existing = this.contexts.get(workspace.workspaceId);
    if (existing) {
      return existing;
    }

    const settingsManager = SettingsManager.create(workspace.path, this.agentDir);
    const packageManager = new DefaultPackageManager({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
    });
    await resourceLoader.reload();

    const context: RuntimeContext = {
      workspace,
      settingsManager,
      packageManager,
      resourceLoader,
    };
    this.contexts.set(workspace.workspaceId, context);
    return context;
  }

  private async buildSnapshot(context: RuntimeContext): Promise<RuntimeSnapshot> {
    const resolvedPaths = await context.packageManager.resolve();
    const [skills, providers, models] = await Promise.all([
      this.buildSkillRecords(context, resolvedPaths.skills),
      this.buildProviderRecords(),
      this.buildModelRecords(),
    ]);

    const defaultProvider = context.settingsManager.getDefaultProvider();
    const defaultModelId = context.settingsManager.getDefaultModel();
    const defaultThinkingLevel = context.settingsManager.getDefaultThinkingLevel();
    const settings: RuntimeSettingsSnapshot = {
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      enableSkillCommands: context.settingsManager.getEnableSkillCommands(),
      enabledModelPatterns: (context.settingsManager.getEnabledModels() ?? []).map((pattern) => ({ pattern })),
    };

    return {
      workspace: context.workspace,
      providers,
      models,
      skills,
      settings,
    };
  }

  private async buildProviderRecords(): Promise<readonly RuntimeProviderRecord[]> {
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
    const providerIds = new Set<string>([
      ...this.modelRegistry.getAll().map((model) => model.provider),
      ...oauthProviders.keys(),
      ...this.authStorage.list(),
    ]);

    return [...providerIds]
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => {
        const auth = this.authStorage.get(providerId);
        const oauthProvider = oauthProviders.get(providerId);
        return {
          id: providerId,
          name: oauthProvider?.name ?? providerId,
          hasAuth: this.authStorage.hasAuth(providerId),
          authType: auth?.type ?? "none",
          oauthSupported: Boolean(oauthProvider),
        };
      });
  }

  private async buildModelRecords(): Promise<readonly RuntimeModelRecord[]> {
    this.modelRegistry.refresh();
    const availableKeys = new Set(
      (await this.modelRegistry.getAvailable()).map((model) => `${model.provider}:${model.id}`),
    );
    const providers = new Map((await this.buildProviderRecords()).map((provider) => [provider.id, provider]));

    return this.modelRegistry
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
          source: loaded?.source ?? resource.metadata.source,
          enabled: resource.enabled,
          disableModelInvocation,
          slashCommand: `/skill:${name}`,
        } satisfies RuntimeSkillRecord;
      }),
    );

    return records.sort((left: RuntimeSkillRecord, right: RuntimeSkillRecord) => left.name.localeCompare(right.name));
  }

  private toggleSkillResource(context: RuntimeContext, resource: ResolvedResource, enabled: boolean): void {
    const { settingsManager } = context;
    const scope = resource.metadata.scope as ResourceScope;
    const origin = resource.metadata.origin;
    const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
    const pattern = this.relativeSkillPattern(resource.path, resource.metadata, scope, origin);

    if (origin === "top-level") {
      const updated = replaceResourcePattern([...(settings.skills ?? [])], pattern, enabled);
      if (scope === "project") {
        settingsManager.setProjectSkillPaths(updated);
      } else {
        settingsManager.setSkillPaths(updated);
      }
      return;
    }

    const packages = [...(settings.packages ?? [])];
    const source = resource.metadata.source;
    const packageIndex = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
    if (packageIndex < 0) {
      throw new Error(`Skill package source not found for ${resource.path}`);
    }

    const currentPackage = packages[packageIndex];
    const nextPackage = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
    const updatedPatterns = replaceResourcePattern([...(nextPackage.skills ?? [])], pattern, enabled);
    if (updatedPatterns.length > 0) {
      nextPackage.skills = updatedPatterns;
    } else {
      delete nextPackage.skills;
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

  private relativeSkillPattern(
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

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
