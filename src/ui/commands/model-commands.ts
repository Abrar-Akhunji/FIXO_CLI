import * as p from "@clack/prompts";
import type { FreeLLMConfig } from "../../config.js";
import { saveConfig } from "../../config.js";
import {
  ProvidersManager,
  PROVIDER_REGISTRY,
  fetchProxyCatalog,
} from "../../agent/providers-manager.js";

import { C, colors } from "../colors.js";

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
  saveConfig(config);
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

async function ownerOfConnectedModel(modelId: string): Promise<string | null> {
  for (const def of PROVIDER_REGISTRY) {
    if (!ProvidersManager.has(def.name)) continue;
    const fetched = await ProvidersManager.fetchRemoteModels(def.name);
    if (fetched.models.includes(modelId)) return def.name;
  }
  return null;
}

async function acceptDirectModel(
  ctx: Parameters<CommandHandler>[0],
  modelId: string,
): Promise<boolean> {
  const connected = PROVIDER_REGISTRY.some((def) =>
    ProvidersManager.has(def.name),
  );
  if (!connected) {
    console.log(
      `\n${colors.yellow}No connected providers. Connect an AI provider with an API key: /providers add <name>${colors.reset}`,
    );
    return false;
  }
  const owner = await ownerOfConnectedModel(modelId);
  if (!owner) {
    console.log(
      `\n${colors.yellow}'${modelId}' is not in a connected provider catalog. Run /providers add, then choose a model that provider returns.${colors.reset}`,
    );
    return false;
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
): Promise<void> {
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
        ...ids.map((id) => ({ value: id, label: id, hint: "" })),
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
    return;
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

export const modelCommand: CommandHandler = async (ctx) => {
  if (ctx.config.provider_mode !== "direct") {
    await proxyModelCommand(ctx);
    return;
  }
  if (ctx.args[0] === "list") {
    // Connected providers only. Unkeyed providers show the add-key line.
    console.log(
      `\n${colors.bold}${colors.cyan}Available Models by Provider${colors.reset}`,
    );
    console.log(`${colors.dim}${"─".repeat(60)}${colors.reset}`);
    for (const def of PROVIDER_REGISTRY) {
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
      const fetched = await ProvidersManager.fetchRemoteModels(def.name);
      console.log(
        `\n  ${C.SNOW}${colors.bold}${def.displayName}${colors.reset} ${colors.green}[key ✓]${colors.reset}`,
      );
      if (fetched.models.length === 0) {
        console.log(
          `    ${colors.yellow}${def.displayName} did not return models.${colors.reset}`,
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
    const connectedDefs = PROVIDER_REGISTRY.filter((def) =>
      ProvidersManager.has(def.name),
    );
    if (connectedDefs.length === 0) {
      console.log(
        `\n${colors.yellow}No direct AI providers connected. Run /providers add <name> to attach an API key.${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Available providers: ${PROVIDER_REGISTRY.map((p) => p.name).join(", ")}${colors.reset}\n`,
      );
      return;
    }

    // Redesigned interactive model picker grouped by connected provider
    const pickedProvider = await askPrompt(ctx, () => p.select({
      message: `Current model: ${colors.cyan}${ctx.state.currentModel}${colors.reset} — Select AI Provider:`,
      options: [
        {
          value: "all",
          label: "Show all models (flat list)",
          hint: `${connectedDefs.length} provider${connectedDefs.length > 1 ? "s" : ""}`,
        },
        ...connectedDefs.map((def) => ({
          value: def.name,
          label: def.displayName,
          hint: " [key ✓]",
        })),
        {
          value: "__add__",
          label: "➕ Connect another provider (/providers add)…",
          hint: "",
        },
        { value: "__manual__", label: "Enter model ID manually…", hint: "" },
      ],
      initialValue:
        connectedDefs.find((def) =>
          def.models.includes(ctx.state.currentModel),
        )?.name || "all",
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

    if (pickedProvider === "__manual__") {
      const manual = await askPrompt(ctx, () =>
        p.text({
          message: "Enter model ID:",
          placeholder: "a model id returned by a connected provider",
          validate: (v) => (!v.trim() ? "Model ID is required" : undefined),
        }),
      );
      if (!p.isCancel(manual) && manual) {
        await acceptDirectModel(ctx, manual.trim());
      }
      return;
    }

    if (pickedProvider === "all") {
      const allOptions: Array<{ value: string; label: string; hint: string }> =
        [];
      for (const def of PROVIDER_REGISTRY) {
        if (!ProvidersManager.has(def.name)) continue;
        const fetched = await ProvidersManager.fetchRemoteModels(def.name);
        for (const model of fetched.models) {
          allOptions.push({
            value: model,
            label: model,
            hint: def.displayName,
          });
        }
      }
      if (allOptions.length === 0) {
        console.log(
          `\n${colors.yellow}No connected provider returned models. Add a key with /providers add <name>.${colors.reset}`,
        );
        return;
      }
      const known = new Set(allOptions.map((option) => option.value));
      const picked = await askPrompt(ctx, () =>
        p.select({
          message: "Select a model from the flat list:",
          options: [
            ...(known.has(ctx.state.currentModel)
              ? [
                  {
                    value: ctx.state.currentModel,
                    label: `Keep current: ${ctx.state.currentModel}`,
                    hint: "no change",
                  },
                ]
              : []),
            ...allOptions,
          ],
          initialValue: known.has(ctx.state.currentModel)
            ? ctx.state.currentModel
            : allOptions[0]?.value,
        }),
      );
      if (p.isCancel(picked)) {
        console.log(
          `\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`,
        );
        return;
      }
      await acceptDirectModel(ctx, picked as string);
      return;
    }

    const def = PROVIDER_REGISTRY.find((p) => p.name === pickedProvider)!;
    const hasKey = ProvidersManager.has(def.name);
    if (!hasKey) {
      console.log(
        `\n${colors.yellow}No API key for ${def.displayName}. Run /providers add ${def.name}.${colors.reset}`,
      );
      return;
    }

    const fetched = await ProvidersManager.fetchRemoteModels(def.name);
    if (fetched.models.length === 0) {
      console.log(
        `\n${colors.yellow}${def.displayName} did not return models.${colors.reset}`,
      );
      return;
    }
    const modelList = fetched.models;
    const keyStatus = `${colors.green}[key ✓]${colors.reset}`;
    const sourceSuffix =
      fetched.source === "cache"
        ? ` ${colors.dim}[cached]${colors.reset}`
        : "";

    const picked = await askPrompt(ctx, () => p.select({
      message: `Select a model from ${colors.bold}${def.displayName}${colors.reset} ${keyStatus}${sourceSuffix}:`,
      options: modelList.map((m) => {
        return {
          value: m,
          label: m,
          hint: m === ctx.state.currentModel ? "currently selected" : "",
        };
      }),
      initialValue: modelList.includes(ctx.state.currentModel)
        ? ctx.state.currentModel
        : undefined,
    }));

    if (p.isCancel(picked)) {
      console.log(
        `\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`,
      );
      return;
    }

    ctx.state.currentModel = picked as string;
    // Store explicit model-provider association so
    // resolveDirectConfig can route this model directly
    // to this provider (critical for live-fetched models
    // that don't appear in the static registry).
    ProvidersManager.setModelProviderHint(ctx.state.currentModel, def.name);
    persistModelSelection(ctx.config, ctx.state.currentModel, def.name);
    ctx.conversation.setContextLimit(ctx.state.currentModel);
    console.log(
      `\n${colors.green}✓ Model set to: ${colors.bold}${ctx.state.currentModel}${colors.reset}`,
    );
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
    const pickedProvider = await askPrompt(ctx, () =>
      p.select({
        message: "Select an AI provider:",
        options: PROVIDER_REGISTRY.map((def) => ({
          value: def.name,
          label: def.displayName,
          hint: ProvidersManager.has(def.name) ? "[key ✓]" : "[no key]",
        })),
      }),
    );
    if (p.isCancel(pickedProvider)) {
      console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
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
      persistModelSelection(ctx.config, ctx.state.currentModel, def.name);
      console.log(
        `\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`,
      );
      await ctx.refreshModelsForProvider(def.name);
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
        `${colors.dim}  Available: ${PROVIDER_REGISTRY.map((p) => p.name).join(", ")}${colors.reset}`,
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

  if (sub === "add") {
    const name = ctx.args[1]?.toLowerCase();
    if (!name) {
      console.log(
        `\n${colors.yellow}Usage: /providers add <provider-name>${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Available: ${PROVIDER_REGISTRY.map((p) => p.name).join(", ")}${colors.reset}`,
      );
      return;
    }
    const def = ProvidersManager.getDefinition(name);
    if (!def) {
      console.log(`\n${colors.red}✗ Unknown provider: ${name}${colors.reset}`);
      console.log(
        `${colors.dim}  Available: ${PROVIDER_REGISTRY.map((p) => p.name).join(", ")}${colors.reset}`,
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
      p.text({
        message: `Enter your ${def.displayName} API key:`,
        placeholder: "sk-... or gsk_...",
        validate: (v) => (!v.trim() ? "API key is required" : undefined),
      }),
    );
    if (p.isCancel(apiKeyInput)) {
      console.log(`\n${colors.dim}Provider add cancelled.${colors.reset}`);
      return;
    }
    ProvidersManager.add(name, apiKeyInput as string);
    persistModelSelection(ctx.config, ctx.state.currentModel, def.name);
    console.log(
      `\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`,
    );
    console.log(
      `${colors.dim}  FixO will now route ${def.displayName} requests directly (bypassing the SaaS proxy).${colors.reset}`,
    );
    await ctx.refreshModelsForProvider(name);
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
      const testHeaders: Record<string, string> = {
        Authorization: `Bearer ${directConf.apiKey}`,
      };
      if (name === "zen" || name === "openrouter") {
        testHeaders["HTTP-Referer"] = "https://opencode.ai/";
        testHeaders["X-Title"] = "opencode";
      } else if (name === "nvidia") {
        testHeaders["HTTP-Referer"] = "https://opencode.ai/";
        testHeaders["X-Title"] = "opencode";
        testHeaders["X-BILLING-INVOKE-ORIGIN"] = "OpenCode";
      } else if (name === "cerebras") {
        testHeaders["X-Cerebras-3rd-Party-Integration"] = "opencode";
      }

      const resp = await fetch(`${directConf.baseUrl}/models`, {
        headers: testHeaders,
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        console.log(
          `${colors.green}✓ Connection to ${directConf.displayName} successful! (HTTP ${resp.status})${colors.reset}`,
        );
        // Warm the cache so /model picker shows live IDs.
        await ctx.refreshModelsForProvider(name);
      } else {
        const text = await resp.text().catch(() => "");
        console.log(
          `${colors.red}✗ ${directConf.displayName} returned HTTP ${resp.status}${text ? ": " + text.slice(0, 100) : ""}${colors.reset}`,
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
    `\n${colors.yellow}Usage: /providers [list | add <name> | remove <name> | test <name>]${colors.reset}`,
  );
  console.log(
    `${colors.dim}  Available providers: ${PROVIDER_REGISTRY.map((p) => p.name).join(", ")}${colors.reset}`,
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
