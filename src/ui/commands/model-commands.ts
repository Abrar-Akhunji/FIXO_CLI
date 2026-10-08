import * as p from "../prompts.js";
import type { FreeLLMConfig } from "../../config.js";
import { saveConfig } from "../../config.js";
import {
  ProvidersManager,
  fetchProxyCatalog,
  validateCustomProviderInput,
  type CustomProviderInput,
  type ProviderProtocol,
} from "../../agent/providers-manager.js";

import { C, colors } from "../colors.js";
import { getActiveSessionScreen } from "../session-screen.js";

import { type CommandHandler } from "./types.js";

function persistModelSelection(
  config: FreeLLMConfig,
  model: string,
  provider?: string,
): void {
  config.lastSession = {
    provider:
      provider ??
      config.lastSession?.provider ??
      config.directProvider?.name ??
      "auto",
    model,
    updatedAt: new Date().toISOString(),
  };
  config.defaultModel = model;
  if (provider && provider !== "auto") {
    config.provider_mode = "direct";
    config.directProvider = { name: provider, defaultModel: model };
  } else if (provider === "auto") {
    config.provider_mode = "proxy";
    delete config.directProvider;
  }
  saveConfig(config);
}

function clearRemovedProviderSelection(
  ctx: Parameters<CommandHandler>[0],
  providerName: string,
): void {
  if (ctx.config.lastSession?.provider !== providerName) return;
  ctx.state.currentModel = "auto";
  ctx.config.defaultModel = "auto";
  delete ctx.config.lastSession;
  delete ctx.config.directProvider;
  ctx.config.provider_mode = ctx.config.freellmapi_api_key ? "proxy" : "direct";
  saveConfig(ctx.config);
  console.log(`${colors.yellow}The selected model belonged to ${providerName}; choose another with /model.${colors.reset}`);
}

const PROXY_CATALOG_UNREACHABLE =
  "Proxy catalog unreachable. Run /providers to configure a direct key or check network.";

async function askPrompt<T>(
  ctx: Parameters<CommandHandler>[0],
  run: () => Promise<T>,
): Promise<T> {
  if (ctx.promptSuspension) return ctx.promptSuspension(run);
  return run();
}

async function ownersOfConnectedModel(modelId: string): Promise<string[]> {
  const connected = ProvidersManager.getAllDefinitions().filter((def) => ProvidersManager.has(def.name));
  const catalogs = await Promise.all(connected.map((def) => ProvidersManager.fetchRemoteModels(def.name)));
  return connected
    .filter((_, index) => catalogs[index]!.models.includes(modelId))
    .map((def) => def.name);
}

async function acceptDirectModel(
  ctx: Parameters<CommandHandler>[0],
  modelId: string,
): Promise<boolean> {
  const connected = ProvidersManager.getAllDefinitions().some((def) =>
    ProvidersManager.has(def.name),
  );
  if (!connected) {
    console.log(
      `\n${colors.yellow}No connected providers. Connect an AI provider with an API key: /providers add <name>${colors.reset}`,
    );
    return false;
  }
  const owners = await ownersOfConnectedModel(modelId);
  if (owners.length === 0) {
    console.log(
      `\n${colors.yellow}'${modelId}' is not in a connected provider catalog. Run /providers add, then choose a model that provider returns.${colors.reset}`,
    );
    return false;
  }
  let owner = owners[0];
  if (owners.length > 1) {
    const picked = await askPrompt(ctx, () => p.select({
      message: `${modelId} exists at multiple providers — choose one:`,
      options: owners.map((name) => ({
        value: name,
        label: ProvidersManager.getDefinition(name)?.displayName ?? name,
      })),
    }));
    if (p.isCancel(picked)) return false;
    owner = picked as string;
  }
  ctx.state.currentModel = modelId;
  ProvidersManager.setModelProviderHint(modelId, owner);
  persistModelSelection(ctx.config, modelId, owner);
  ctx.conversation.setContextLimit(modelId);
  console.log(
    `\n${colors.green}✓ Model set to: ${colors.bold}${modelId}${colors.reset}`,
  );
  return true;
}

function acceptProxyModel(
  ctx: Parameters<CommandHandler>[0],
  modelId: string,
  ids: string[],
  failed: boolean,
): boolean {
  if (modelId !== "auto" && (failed || !ids.includes(modelId))) {
    console.log(
      `\n${colors.yellow}${
        failed
          ? PROXY_CATALOG_UNREACHABLE
          : `'${modelId}' is not in the proxy catalog. Choose auto or a listed id.`
      }${colors.reset}`,
    );
    return false;
  }
  ctx.state.currentModel = modelId;
  persistModelSelection(ctx.config, modelId, "auto");
  ctx.conversation.setContextLimit(modelId);
  console.log(
    `\n${colors.green}✓ Model set to: ${colors.bold}${modelId}${colors.reset}`,
  );
  return true;
}

async function proxyModelCommand(
  ctx: Parameters<CommandHandler>[0],
): Promise<"back" | void> {
  if (ctx.args.length > 0 && ctx.args[0] !== "list") {
    let ids: string[] = [];
    let failed = true;
    const apiUrl = ctx.config.apiUrl?.trim();
    const apiKey = ctx.config.freellmapi_api_key?.trim();
    if (apiUrl && apiKey) {
      try {
        ids = await fetchProxyCatalog(apiUrl, apiKey);
        failed = false;
      } catch {
        failed = true;
      }
    }
    acceptProxyModel(ctx, ctx.args.join(" ").trim(), ids, failed);
    return;
  }

  let ids: string[] = [];
  let failed = false;
  const apiUrl = ctx.config.apiUrl?.trim();
  const apiKey = ctx.config.freellmapi_api_key?.trim();
  if (!apiUrl || !apiKey) {
    failed = true;
  } else {
    try {
      ids = await fetchProxyCatalog(apiUrl, apiKey);
    } catch {
      failed = true;
    }
  }

  if (ctx.args[0] === "list") {
    console.log(
      `\n${colors.bold}${colors.cyan}Proxy catalog${colors.reset}`,
    );
    if (failed) {
      console.log(`${colors.yellow}${PROXY_CATALOG_UNREACHABLE}${colors.reset}`);
    }
    console.log(`    ${colors.cyan}•${colors.reset} auto`);
    for (const id of ids) {
      console.log(`    ${colors.cyan}•${colors.reset} ${id}`);
    }
    return;
  }

  if (failed) {
    console.log(`\n${colors.yellow}${PROXY_CATALOG_UNREACHABLE}${colors.reset}`);
  }

  const picked = await askPrompt(ctx, () =>
    p.select({
      message: `Current model: ${colors.cyan}${ctx.state.currentModel}${colors.reset} — proxy catalog:`,
      options: [
        { value: "auto", label: "auto", hint: "proxy routes the request" },
        ...[...new Set(ids)].filter((id) => id !== "auto").map((id) => ({ value: id, label: id, hint: "" })),
        ...(failed
          ? []
          : [
              {
                value: "__manual__",
                label: "Enter a catalog model id…",
                hint: "must be in the proxy catalog",
              },
            ]),
      ],
      initialValue:
        ctx.state.currentModel === "auto" || ids.includes(ctx.state.currentModel)
          ? ctx.state.currentModel
          : "auto",
    }),
  );

  if (p.isCancel(picked)) {
    console.log(
      `\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`,
    );
    return "back";
  }

  if (picked === "__manual__") {
    const manual = await askPrompt(ctx, () =>
      p.text({
        message: "Enter model ID:",
        placeholder: "auto, or an id from the proxy catalog",
        validate: (v) => (!v.trim() ? "Model ID is required" : undefined),
      }),
    );
    if (!p.isCancel(manual) && manual) {
      acceptProxyModel(ctx, manual.trim(), ids, failed);
    }
    return;
  }

  acceptProxyModel(ctx, picked as string, ids, failed);
}

async function pickModelFromProvider(
  ctx: Parameters<CommandHandler>[0],
  providerName: string,
  prefetchedModels?: readonly string[],
): Promise<boolean> {
  const def = ProvidersManager.getDefinition(providerName);
  if (!def || !ProvidersManager.has(providerName)) {
    console.log(`\n${colors.yellow}Connect ${providerName} with /providers add ${providerName} first.${colors.reset}`);
    return false;
  }
  const screen = getActiveSessionScreen();
  if (!prefetchedModels) {
    screen?.setActivity(`Loading ${def.displayName} models…`);
  }
  const fetched = prefetchedModels
    ? {
        models: [...prefetchedModels],
        source: "live" as const,
        fetchedAt: new Date().toISOString(),
      }
    : await ProvidersManager.fetchRemoteModels(providerName);
  if (!prefetchedModels) screen?.setActivity("Ready");
  if (fetched.models.length === 0) {
    console.log(`\n${colors.yellow}Could not load ${def.displayName} models. Check the key or network, then run /providers test ${providerName} and retry /model.${colors.reset}`);
    return false;
  }
  const picked = await askPrompt(ctx, () => p.select({
    message: `${def.displayName} / ${fetched.models.length} models${fetched.source === "cache" ? " (cached)" : ""}`,
    options: fetched.models.map((model) => ({
      value: model,
      label: model,
      hint: model === ctx.state.currentModel && ctx.config.lastSession?.provider === providerName
        ? "currently selected" : "",
    })),
    initialValue: fetched.models.includes(ctx.state.currentModel)
      ? ctx.state.currentModel : undefined,
  }));
  if (p.isCancel(picked)) return false;
  ctx.state.currentModel = picked as string;
  ProvidersManager.setModelProviderHint(ctx.state.currentModel, providerName);
  persistModelSelection(ctx.config, ctx.state.currentModel, providerName);
  ctx.conversation.setContextLimit(ctx.state.currentModel);
  console.log(`\n${colors.green}✓ ${def.displayName} / ${ctx.state.currentModel}${colors.reset}`);
  return true;
}

async function addCustomProviderFlow(
  ctx: Parameters<CommandHandler>[0],
): Promise<void> {
  const providerId = await askPrompt(ctx, () => p.text({
    message: "Provider ID — lowercase name used in commands",
    placeholder: "my-provider",
    validate: (value) => {
      const id = value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-_]*$/.test(id)) {
        return "Use lowercase letters, numbers, dash, or underscore; start with a letter or number.";
      }
      if (id.length > 48) return "Use 48 characters or fewer.";
      if (ProvidersManager.getDefinition(id)) return `Provider ID '${id}' is already in use.`;
      return undefined;
    },
  }));
  if (p.isCancel(providerId)) return;

  const displayName = await askPrompt(ctx, () => p.text({
    message: "Display name — shown in provider and model menus",
    placeholder: "My AI Gateway",
    validate: (value) => !value.trim() ? "Display name is required." : value.trim().length > 64 ? "Use 64 characters or fewer." : undefined,
  }));
  if (p.isCancel(displayName)) return;

  const protocol = await askPrompt(ctx, () => p.select<ProviderProtocol>({
    message: "Which API protocol does this endpoint implement?",
    options: [
      {
        value: "openai",
        label: "OpenAI-compatible",
        hint: "Bearer key · FIXO adds /models and /chat/completions",
      },
      {
        value: "anthropic",
        label: "Anthropic-compatible",
        hint: "x-api-key · FIXO adds /models and /messages",
      },
    ],
  }));
  if (p.isCancel(protocol)) return;

  const endpointExample = protocol === "anthropic"
    ? "https://api.anthropic.com/v1"
    : "https://api.example.com/v1";
  const base: Omit<CustomProviderInput, "baseUrl"> = {
    name: String(providerId).trim().toLowerCase(),
    displayName: String(displayName).trim(),
    protocol,
  };
  const endpoint = await askPrompt(ctx, () => p.text({
    message: "API base URL — include documented /v1; omit model and message paths",
    placeholder: endpointExample,
    validate: (value) => validateCustomProviderInput({ ...base, baseUrl: value }) ?? undefined,
  }));
  if (p.isCancel(endpoint)) return;

  const apiKey = await askPrompt(ctx, () => p.password({
    message: `${String(displayName).trim()} API key — masked and excluded from chat history`,
    placeholder: protocol === "anthropic" ? "sk-ant-api03-…" : "sk-…",
    validate: (value) => !value.trim() ? "API key is required." : undefined,
  }));
  if (p.isCancel(apiKey)) return;

  const input: CustomProviderInput = { ...base, baseUrl: String(endpoint) };
  const screen = getActiveSessionScreen();
  screen?.setActivity(`Checking ${input.displayName} and loading models…`);
  try {
    const models = await ProvidersManager.verifyCustomProviderAndFetchModels(input, String(apiKey));
    const definition = ProvidersManager.addCustomProvider(input, String(apiKey));
    console.log(
      `\n${colors.green}✓ Connected ${definition.displayName}.${colors.reset} ${colors.dim}${models.length} models loaded from ${definition.baseUrl}/models.${colors.reset}`,
    );
    await pickModelFromProvider(ctx, definition.name, models);
  } catch (error) {
    console.log(
      `\n${colors.red}✗ Custom provider was not saved: ${(error as Error).message}${colors.reset}`,
    );
  } finally {
    screen?.setActivity("Ready");
  }
}

export const modelCommand: CommandHandler = async (ctx) => {
  if (ctx.args[0] === "list") {
    // Connected providers only. Unkeyed providers show the add-key line.
    const definitions = ProvidersManager.getAllDefinitions();
    const connected = definitions.filter((def) => ProvidersManager.has(def.name));
    const catalogs = new Map(await Promise.all(connected.map(async (def) => [
      def.name,
      await ProvidersManager.fetchRemoteModels(def.name),
    ] as const)));
    console.log(
      `\n${colors.bold}${colors.cyan}Available Models by Provider${colors.reset}`,
    );
    console.log(`${colors.dim}${"─".repeat(60)}${colors.reset}`);
    for (const def of definitions) {
      const hasKey = ProvidersManager.has(def.name);
      if (!hasKey) {
        console.log(
          `\n  ${C.SNOW}${colors.bold}${def.displayName}${colors.reset} ${colors.dim}[no key]${colors.reset}`,
        );
        console.log(
          `    ${colors.dim}Add a key with /providers add ${def.name}${colors.reset}`,
        );
        continue;
      }
      const fetched = catalogs.get(def.name)!;
      console.log(
        `\n  ${C.SNOW}${colors.bold}${def.displayName}${colors.reset} ${colors.green}[key ✓]${colors.reset}`,
      );
      if (fetched.models.length === 0) {
        console.log(
          `    ${colors.yellow}Models unavailable — check the key or network; retry /providers test ${def.name}.${colors.reset}`,
        );
        continue;
      }
      for (const model of fetched.models) {
        console.log(`    ${colors.cyan}•${colors.reset} ${model}`);
      }
    }
    console.log(
      `\n${colors.dim}  Use /providers add <name> to connect a provider with your API key.${colors.reset}`,
    );
    console.log(
      `${colors.dim}  Or set model directly: /model <model-id>${colors.reset}\n`,
    );
    return;
  }
  if (ctx.args.length === 0) {
    // Provider scope is explicit, independent of the previous transport mode.
    // A connected key must not disappear just because the last turn used proxy.
    while (true) {
    const connectedDefs = ProvidersManager.getAllDefinitions().filter((def) =>
      ProvidersManager.has(def.name),
    );

    // Redesigned interactive model picker grouped by connected provider
    const initialProvider =
      connectedDefs.find((def) => def.name === ctx.config.lastSession?.provider)?.name ??
      connectedDefs.find((def) =>
        ProvidersManager.getCachedModels(def.name)?.models?.includes(
          ctx.state.currentModel,
        ),
      )?.name ?? connectedDefs[0]?.name;
    const pickedProvider = await askPrompt(ctx, () => p.select({
      message: "Choose a provider, then a model",
      options: [
        ...connectedDefs.map((def) => ({
          value: def.name,
          label: def.displayName,
          hint: `${ctx.config.provider_mode === "direct" && ctx.config.lastSession?.provider === def.name ? "current • " : ""}connected${ProvidersManager.getCachedModels(def.name)?.models.length ? ` • ${ProvidersManager.getCachedModels(def.name)!.models.length} models` : ""}`,
        })),
        { value: "__proxy__", label: "FreeLLMAPI proxy", hint: "aggregated catalog • auto routing" },
        { value: "__add__", label: "Connect a provider…", hint: "add an API key" },
      ],
      initialValue: initialProvider,
    }));

    if (p.isCancel(pickedProvider)) {
      console.log(
        `\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`,
      );
      return;
    }

    if (pickedProvider === "__add__") {
      await providersCommand({ ...ctx, args: [] });
      return;
    }
    if (pickedProvider === "__proxy__") {
      if (await proxyModelCommand(ctx) === "back") continue;
      return;
    }
    if (await pickModelFromProvider(ctx, pickedProvider as string)) return;
    }
  }
  // /model zen is a shortcut to that provider's own catalog.
  if (ctx.args.length === 1 && ProvidersManager.getDefinition(ctx.args[0])) {
    await pickModelFromProvider(ctx, ctx.args[0]);
    return;
  }
  if (ctx.config.provider_mode !== "direct") {
    await proxyModelCommand(ctx);
    return;
  }
  await acceptDirectModel(ctx, ctx.args.join(" ").trim());
  return;
};

export const providersCommand: CommandHandler = async (ctx) => {
  const sub = ctx.args[0];

  // ── Interactive flow (bare `/providers`): mirrors the
  // /model picker shape. The user picks a provider, then
  // an action, then enters a masked API key via p.password
  // when the action is add/update. The legacy text routes
  // below remain unchanged for muscle-memory + scripting.
  if (!sub) {
    const definitions = ProvidersManager.getAllDefinitions();
    const pickedProvider = await askPrompt(ctx, () =>
      p.select({
        message: "Select an AI provider:",
        options: [
          ...definitions.map((def) => ({
            value: def.name,
            label: def.displayName,
            hint: `${def.custom ? "custom · " : ""}${ProvidersManager.has(def.name) ? "[key ✓]" : "[no key]"}`,
          })),
          {
            value: "__custom__",
            label: "Add custom provider…",
            hint: "OpenAI- or Anthropic-compatible endpoint",
          },
        ],
      }),
    );
    if (p.isCancel(pickedProvider)) {
      console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
      return;
    }

    if (pickedProvider === "__custom__") {
      await addCustomProviderFlow(ctx);
      return;
    }

    const def = ProvidersManager.getDefinition(pickedProvider as string);
    if (!def) {
      console.log(
        `\n${colors.red}✗ Unknown provider: ${pickedProvider}${colors.reset}`,
      );
      return;
    }
    const hasKey = ProvidersManager.has(def.name);

    const action = await askPrompt(ctx, () => p.select({
      message: `${def.displayName} — choose an action:`,
      options: [
        ...(hasKey ? [{ value: "model", label: "Choose a model", hint: "browse only this provider's models" }] : []),
        { value: "add", label: hasKey ? "Update API key" : "Add API key" },
        {
          value: "test",
          label: "Test connection",
          hint: hasKey ? "" : "requires a key",
        },
        {
          value: "remove",
          label: "Remove API key",
          hint: hasKey ? "" : "no key configured",
        },
        { value: "cancel", label: "Cancel" },
      ],
    }));
    if (p.isCancel(action) || action === "cancel") {
      console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
      return;
    }
    if (action === "model") {
      await pickModelFromProvider(ctx, def.name);
      return;
    }

    if (action === "add") {
      console.log(
        `${colors.dim}  Get your API key at: ${def.docsUrl}${colors.reset}`,
      );
      const key = await askPrompt(ctx, () =>
        p.password({
          message: `Enter your ${def.displayName} API key:`,
          validate: (v) => (!v?.trim() ? "API key is required" : undefined),
        }),
      );
      if (p.isCancel(key)) {
        console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
        return;
      }
      ProvidersManager.add(def.name, key as string);
      console.log(
        `\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`,
      );
      await pickModelFromProvider(ctx, def.name);
      return;
    }

    if (action === "remove") {
      if (!hasKey) {
        console.log(
          `\n${colors.yellow}No key configured for ${def.displayName}.${colors.reset}`,
        );
        return;
      }
      const confirmed = await askPrompt(ctx, () =>
        p.confirm({
          message: `Remove API key for ${def.displayName}?`,
          initialValue: false,
        }),
      );
      if (!p.isCancel(confirmed) && confirmed) {
        const removed = ProvidersManager.remove(def.name);
        if (removed) clearRemovedProviderSelection(ctx, def.name);
        console.log(
          removed
            ? `\n${colors.green}✓ Removed API key for ${def.displayName}.${colors.reset}`
            : `\n${colors.yellow}No key found for provider: ${def.name}${colors.reset}`,
        );
      }
      return;
    }

    if (action === "test") {
      if (!hasKey) {
        console.log(
          `\n${colors.yellow}No key configured for ${def.displayName}. Add one first.${colors.reset}`,
        );
        return;
      }
      console.log(
        `\n${colors.dim}Testing connection to ${def.displayName} via live /models fetch…${colors.reset}`,
      );
      await ctx.refreshModelsForProvider(def.name);
      return;
    }

    return;
  }

  if (sub === "list") {
    const list = ProvidersManager.list();
    if (list.length === 0) {
      console.log(`\n${colors.yellow}No providers configured.${colors.reset}`);
      console.log(
        `${colors.dim}  Use /providers add <name> to connect a provider (e.g. /providers add groq)${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Available: ${ProvidersManager.getAllDefinitions().map((p) => p.name).join(", ")}; or choose Add custom provider.${colors.reset}`,
      );
    } else {
      console.log(
        `\n${colors.bold}${colors.cyan}Connected Providers${colors.reset}`,
      );
      console.log(`${colors.dim}${"─".repeat(60)}${colors.reset}`);
      for (const entry of list) {
        const addedDate = new Date(entry.addedAt).toLocaleDateString();
        console.log(
          `  ${colors.cyan}${entry.name.padEnd(14)}${colors.reset}${colors.bold}${entry.displayName.padEnd(22)}${colors.reset}${colors.dim}${entry.maskedKey}  (added ${addedDate})${colors.reset}`,
        );
      }
      console.log(
        `\n${colors.dim}  Use /providers remove <name> to remove a key.${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Use /providers test <name> to verify a connection.${colors.reset}`,
      );
    }
    return;
  }

  if (sub === "custom" || sub === "add-custom") {
    await addCustomProviderFlow(ctx);
    return;
  }

  if (sub === "add") {
    const name = ctx.args[1]?.toLowerCase();
    if (!name) {
      console.log(
        `\n${colors.yellow}Usage: /providers add <provider-name>${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Available: ${ProvidersManager.getAllDefinitions().map((p) => p.name).join(", ")}; custom: /providers add-custom${colors.reset}`,
      );
      return;
    }
    const def = ProvidersManager.getDefinition(name);
    if (!def) {
      console.log(`\n${colors.red}✗ Unknown provider: ${name}${colors.reset}`);
      console.log(
        `${colors.dim}  Available: ${ProvidersManager.getAllDefinitions().map((p) => p.name).join(", ")}; custom: /providers add-custom${colors.reset}`,
      );
      return;
    }
    console.log(
      `\n${colors.cyan}${colors.bold}Connecting to ${def.displayName}${colors.reset}`,
    );
    console.log(
      `${colors.dim}  Get your API key at: ${def.docsUrl}${colors.reset}`,
    );
    const apiKeyInput = await askPrompt(ctx, () =>
      p.password({
        message: `Enter your ${def.displayName} API key:`,
        validate: (v) => (!v?.trim() ? "API key is required" : undefined),
      }),
    );
    if (p.isCancel(apiKeyInput)) {
      console.log(`\n${colors.dim}Provider add cancelled.${colors.reset}`);
      return;
    }
    ProvidersManager.add(name, apiKeyInput as string);
    console.log(
      `\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`,
    );
    console.log(
      `${colors.dim}  Choose a model to use ${def.displayName} directly.${colors.reset}`,
    );
    await pickModelFromProvider(ctx, name);
    return;
  }

  if (sub === "remove") {
    const name = ctx.args[1]?.toLowerCase();
    if (!name) {
      console.log(
        `\n${colors.yellow}Usage: /providers remove <name>${colors.reset}`,
      );
      return;
    }
    const confirmed = await askPrompt(ctx, () =>
      p.confirm({
        message: `Remove API key for ${name}?`,
        initialValue: false,
      }),
    );
    if (!p.isCancel(confirmed) && confirmed) {
      const removed = ProvidersManager.remove(name);
      if (removed) clearRemovedProviderSelection(ctx, name);
      console.log(
        removed
          ? `\n${colors.green}✓ Removed API key for ${name}.${colors.reset}`
          : `\n${colors.yellow}No key found for provider: ${name}${colors.reset}`,
      );
    }
    return;
  }

  if (sub === "test") {
    const name = ctx.args[1]?.toLowerCase();
    if (!name) {
      console.log(
        `\n${colors.yellow}Usage: /providers test <name>${colors.reset}`,
      );
      return;
    }
    const directConf = ProvidersManager.getDirectConfig(name);
    if (!directConf) {
      console.log(
        `\n${colors.yellow}No key configured for ${name}. Use /providers add ${name} first.${colors.reset}`,
      );
      return;
    }
    console.log(
      `\n${colors.dim}Testing connection to ${directConf.displayName} (${directConf.baseUrl})...${colors.reset}`,
    );
    try {
      const result = await ProvidersManager.fetchRemoteModels(name);
      if (result.source === "live" && result.models.length > 0) {
        console.log(
          `${colors.green}✓ Connection to ${directConf.displayName} successful — ${result.models.length} models loaded.${colors.reset}`,
        );
      } else if (result.source === "cache" && result.models.length > 0) {
        console.log(
          `${colors.yellow}⚠ Live connection to ${directConf.displayName} failed. ${result.models.length} cached models remain available; check the key, network, protocol, and base URL.${colors.reset}`,
        );
      } else {
        console.log(
          `${colors.red}✗ ${directConf.displayName} did not return a model catalog. Check its key, protocol, and base URL.${colors.reset}`,
        );
      }
    } catch (err: any) {
      console.log(
        `${colors.red}✗ Connection failed: ${err.message}${colors.reset}`,
      );
    }
    return;
  }

  console.log(
    `\n${colors.yellow}Usage: /providers [list | add <name> | add-custom | remove <name> | test <name>]${colors.reset}`,
  );
  console.log(
    `${colors.dim}  Available providers: ${ProvidersManager.getAllDefinitions().map((p) => p.name).join(", ")}${colors.reset}`,
  );
  return;
};

export const modelRoutingCommand: CommandHandler = async (ctx) => {
  // Phase 2.4 — list / set the per-capability model tiers.
  //
  //   /model-routing                        → print current
  //   /model-routing fast gpt-4o-mini       → set fast tier
  //   /model-routing heavy claude-opus-4-7  → set heavy tier
  //   /model-routing default <model>        → set default
  //   /model-routing clear fast             → unset fast
  //   /model-routing clear                  → unset all tiers
  const sub = ctx.args[0]?.toLowerCase();
  const routing = ctx.config.preferences.modelRouting ?? {};
  if (!sub) {
    console.log(`\n${colors.cyan}Model routing tiers:${colors.reset}`);
    console.log(
      `  ${colors.bold}fast${colors.reset}    → ${routing.fast ?? colors.dim + "(unset)" + colors.reset}`,
    );
    console.log(
      `  ${colors.bold}default${colors.reset} → ${routing.default ?? colors.dim + "(unset)" + colors.reset}`,
    );
    console.log(
      `  ${colors.bold}heavy${colors.reset}   → ${routing.heavy ?? colors.dim + "(unset)" + colors.reset}`,
    );
    console.log(
      `${colors.dim}\n  Usage:\n    /model-routing fast <model>\n    /model-routing heavy <model>\n    /model-routing default <model>\n    /model-routing clear [tier]${colors.reset}`,
    );
  } else if (sub === "clear") {
    const tier = ctx.args[1]?.toLowerCase();
    if (!tier) {
      ctx.config.preferences.modelRouting = {};
      saveConfig(ctx.config);
      console.log(
        `\n${colors.green}✓ All model-routing tiers cleared${colors.reset}`,
      );
    } else if (tier === "fast" || tier === "default" || tier === "heavy") {
      const next = { ...routing };
      delete next[tier];
      ctx.config.preferences.modelRouting = next;
      saveConfig(ctx.config);
      console.log(`\n${colors.green}✓ Cleared ${tier} tier${colors.reset}`);
    } else {
      console.log(
        `\n${colors.yellow}Unknown tier: ${tier}. Expected fast, default, or heavy.${colors.reset}`,
      );
    }
  } else if (sub === "fast" || sub === "default" || sub === "heavy") {
    const modelName = ctx.args[1];
    if (!modelName) {
      console.log(
        `\n${colors.yellow}Usage: /model-routing ${sub} <model-name>${colors.reset}`,
      );
    } else {
      ctx.config.preferences.modelRouting = { ...routing, [sub]: modelName };
      saveConfig(ctx.config);
      console.log(
        `\n${colors.green}✓ Set ${sub} tier → ${modelName}${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Restart the session or run a new task — agents will pick up the new tier on construction.${colors.reset}`,
      );
    }
  } else {
    console.log(
      `\n${colors.yellow}Unknown sub-command: ${sub}. Try /model-routing without arguments to see usage.${colors.reset}`,
    );
  }
  return;
};
