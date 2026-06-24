import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as p from '@clack/prompts';
import { SingleAgent } from '../../agent/single-agent.js';
import { ConversationManager } from '../../agent/conversation.js';
import { GitManager } from '../../git/git-manager.js';
import type { AgentContext, ProjectConfig } from '../../types.js';
import type { ChatContentBlock } from '../../shared/types.js';
import { loadImageAsBlock } from '../image-attach.js';
import type { FreeLLMConfig } from '../../config.js';
import { saveConfig } from '../../config.js';
import { WorkspaceGuard } from '../../workspace-guard.js';
import { listRuns, showRun, undoRun } from '../../runtime/task-session.js';
import { checkPermission } from '../../agent/permissions.js';
import { redactedEnv, redactSecrets } from '../../runtime/redaction.js';
import { appendMemory, doctor, forgetMemory, readMemory } from '../../project-memory.js';
import { buildIndex, explainIndexedTarget, findInIndex } from '../../indexer.js';
import { reviewWorkspace } from '../../review.js';
import { runProjectTests } from '../../test-runner.js';
import { loadPlan, renderPlan, savePlan, classifyComplexityHeuristic } from '../../planner.js';
import { mcpManager, mcpBridgeManager } from '../../agent/tool-executor.js';
import { ProvidersManager, PROVIDER_REGISTRY } from '../../agent/providers-manager.js';

import { C, colors } from '../colors.js';
import { COMMANDS_WITH_DESC, printHelp, buildPromptString, formatInputPaths } from '../render.js';
import {
  addItem,
  loadTodoList,
  removeItem,
  renderTodoList,
  saveTodoList,
  setItemStatus,
  summariseTodoList,
} from '../../context/todo.js';
import { renderStatusBar, type CLIState } from '../render-primitives.js';

import { type CommandHandler } from './types.js';

function persistModelSelection(
  config: FreeLLMConfig,
  model: string,
  provider?: string,
): void {
  config.lastSession = {
    provider: provider ?? config.lastSession?.provider ?? config.directProvider?.name ?? 'auto',
    model,
    updatedAt: new Date().toISOString(),
  };
  config.defaultModel = model;
  saveConfig(config);
}

export const modelCommand: CommandHandler = async (ctx) => {
    if (ctx.args[0] === 'list') {
      // Print full model table grouped by provider
      // Uses live-fetched cached models when available, otherwise falls
      // back to the static registry list (tagged [unverified]).
      console.log(`\n${colors.bold}${colors.cyan}Available Models by Provider${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(60)}${colors.reset}`);
      for (const def of PROVIDER_REGISTRY) {
        const hasKey = ProvidersManager.has(def.name);
        const keyStatus = hasKey ? `${colors.green}[key ✓]${colors.reset}` : `${colors.dim}[no key]${colors.reset}`;
        const cached = ProvidersManager.getCachedModels(def.name);
        const modelList = cached?.models?.length ? cached.models : def.models;
        const sourceTag = cached?.source === 'live'
          ? ''
          : ` ${colors.dim}[unverified]${colors.reset}`;
        console.log(`\n  ${C.SNOW}${colors.bold}${def.displayName}${colors.reset} ${keyStatus}${sourceTag}`);
        for (const model of modelList) {
          console.log(`    ${colors.cyan}•${colors.reset} ${model}`);
        }
      }
      console.log(`\n${colors.dim}  Use /providers add <name> to connect a provider with your API key.${colors.reset}`);
      console.log(`${colors.dim}  Or set model directly: /model <model-id>${colors.reset}\n`);
      return;
    }
    if (ctx.args.length === 0) {
      // Redesigned interactive model picker grouped by provider
      ctx.rl.pause();
      const pickedProvider = await p.select({
        message: `Current model: ${colors.cyan}${ctx.state.currentModel}${colors.reset} — Select AI Provider:`,
        options: [
          { value: 'all', label: 'Show all models (flat list)', hint: 'classic view' },
          ...PROVIDER_REGISTRY.map(def => ({
            value: def.name,
            label: def.displayName,
            hint: ProvidersManager.has(def.name) ? ' [key ✓]' : ' [no key]'
          })),
          { value: '__manual__', label: 'Enter model ID manually…', hint: '' },
        ],
        initialValue: PROVIDER_REGISTRY.find(def => def.models.includes(ctx.state.currentModel))?.name || 'all',
      });
      ctx.rl.resume();

      if (p.isCancel(pickedProvider)) {
        console.log(`\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`);
        return;
      }

      if (pickedProvider === '__manual__') {
        ctx.rl.pause();
        const manual = await p.text({
          message: 'Enter model ID:',
          placeholder: 'e.g. gpt-4o, claude-opus-4-5, gemini-2.5-pro',
          validate: v => !v.trim() ? 'Model ID is required' : undefined,
        });
        ctx.rl.resume();
        if (!p.isCancel(manual) && manual) {
          ctx.state.currentModel = manual.trim();
          persistModelSelection(ctx.config, ctx.state.currentModel);
          ctx.conversation.setContextLimit(ctx.state.currentModel);
          console.log(`\n${colors.green}✓ Model set to: ${colors.bold}${ctx.state.currentModel}${colors.reset}`);
        }
        return;
      }

      if (pickedProvider === 'all') {
        ctx.rl.pause();
        const allOptions = PROVIDER_REGISTRY.flatMap(def =>
          def.models.map(m => ({
            value: m,
            label: `${m}`,
            hint: def.displayName + (ProvidersManager.has(def.name) ? ' [key ✓]' : ''),
          }))
        );
        const picked = await p.select({
          message: 'Select a model from the flat list:',
          options: [
            { value: ctx.state.currentModel, label: `Keep current: ${ctx.state.currentModel}`, hint: 'no change' },
            ...allOptions,
          ],
          initialValue: ctx.state.currentModel,
        });
        ctx.rl.resume();
        if (p.isCancel(picked)) {
          console.log(`\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`);
          return;
        }
        ctx.state.currentModel = picked as string;
        // Store hint — find which provider this model belongs to
        const owningDef = PROVIDER_REGISTRY.find(d =>
          d.models.includes(ctx.state.currentModel)
          || ProvidersManager.getCachedModels(d.name)?.models?.includes(ctx.state.currentModel)
        );
        if (owningDef) ProvidersManager.setModelProviderHint(ctx.state.currentModel, owningDef.name);
        persistModelSelection(ctx.config, ctx.state.currentModel, owningDef?.name);
        ctx.conversation.setContextLimit(ctx.state.currentModel);
        console.log(`\n${colors.green}✓ Model set to: ${colors.bold}${ctx.state.currentModel}${colors.reset}`);
        return;
      }

      const def = PROVIDER_REGISTRY.find(p => p.name === pickedProvider)!;
      const hasKey = ProvidersManager.has(def.name);
      const keyStatus = hasKey ? `${colors.green}[key ✓]${colors.reset}` : `${colors.red}[no key]${colors.reset}`;

      // Prefer the cached live model list; fall back to the
      // registry list (tagged `[unverified]`) when no fresh
      // cache exists. Drops the synthetic "(free)" suffix
      // since we no longer know that without provider
      // metadata.
      const cached = ProvidersManager.getCachedModels(def.name);
      const modelList: string[] = cached?.models?.length ? cached.models : def.models;
      const sourceSuffix = cached?.source === 'live'
        ? ''
        : ` ${colors.dim}[unverified]${colors.reset}`;

      ctx.rl.pause();
      const picked = await p.select({
        message: `Select a model from ${colors.bold}${def.displayName}${colors.reset} ${keyStatus}${sourceSuffix}:`,
        options: modelList.map(m => {
          return {
            value: m,
            label: m,
            hint: m === ctx.state.currentModel ? 'currently selected' : ''
          };
        }),
        initialValue: modelList.includes(ctx.state.currentModel) ? ctx.state.currentModel : undefined,
      });
      ctx.rl.resume();

      if (p.isCancel(picked)) {
        console.log(`\n${colors.dim}Model unchanged: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`);
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
      console.log(`\n${colors.green}✓ Model set to: ${colors.bold}${ctx.state.currentModel}${colors.reset}`);
      return;
    }
    ctx.state.currentModel = ctx.args.join(' ');
    persistModelSelection(ctx.config, ctx.state.currentModel);
    ctx.conversation.setContextLimit(ctx.state.currentModel);
    console.log(`\n${colors.green}✓ Model set to: ${colors.bold}${ctx.state.currentModel}${colors.reset}`);
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
      ctx.rl.pause();
      const pickedProvider = await p.select({
        message: 'Select an AI provider:',
        options: PROVIDER_REGISTRY.map(def => ({
          value: def.name,
          label: def.displayName,
          hint: ProvidersManager.has(def.name) ? '[key ✓]' : '[no key]',
        })),
      });
      ctx.rl.resume();
      if (p.isCancel(pickedProvider)) {
        console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
        return;
      }

      const def = ProvidersManager.getDefinition(pickedProvider as string);
      if (!def) {
        console.log(`\n${colors.red}✗ Unknown provider: ${pickedProvider}${colors.reset}`);
        return;
      }
      const hasKey = ProvidersManager.has(def.name);

      ctx.rl.pause();
      const action = await p.select({
        message: `${def.displayName} — choose an action:`,
        options: [
          { value: 'add',    label: hasKey ? 'Update API key'      : 'Add API key' },
          { value: 'test',   label: 'Test connection',                hint: hasKey ? '' : 'requires a key' },
          { value: 'remove', label: 'Remove API key',                 hint: hasKey ? '' : 'no key configured' },
          { value: 'cancel', label: 'Cancel' },
        ],
      });
      ctx.rl.resume();
      if (p.isCancel(action) || action === 'cancel') {
        console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
        return;
      }

      if (action === 'add') {
        console.log(`${colors.dim}  Get your API key at: ${def.docsUrl}${colors.reset}`);
        ctx.rl.pause();
        const key = await p.password({
          message: `Enter your ${def.displayName} API key:`,
          validate: v => !v?.trim() ? 'API key is required' : undefined,
        });
        ctx.rl.resume();
        if (p.isCancel(key)) {
          console.log(`\n${colors.dim}/providers cancelled.${colors.reset}`);
          return;
        }
        ProvidersManager.add(def.name, key as string);
        persistModelSelection(ctx.config, ctx.state.currentModel, def.name);
        console.log(`\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`);
        await ctx.refreshModelsForProvider(def.name);
        return;
      }

      if (action === 'remove') {
        if (!hasKey) {
          console.log(`\n${colors.yellow}No key configured for ${def.displayName}.${colors.reset}`);
          return;
        }
        ctx.rl.pause();
        const confirmed = await p.confirm({
          message: `Remove API key for ${def.displayName}?`,
          initialValue: false,
        });
        ctx.rl.resume();
        if (!p.isCancel(confirmed) && confirmed) {
          const removed = ProvidersManager.remove(def.name);
          console.log(removed
            ? `\n${colors.green}✓ Removed API key for ${def.displayName}.${colors.reset}`
            : `\n${colors.yellow}No key found for provider: ${def.name}${colors.reset}`);
        }
        return;
      }

      if (action === 'test') {
        if (!hasKey) {
          console.log(`\n${colors.yellow}No key configured for ${def.displayName}. Add one first.${colors.reset}`);
          return;
        }
        console.log(`\n${colors.dim}Testing connection to ${def.displayName} via live /models fetch…${colors.reset}`);
        await ctx.refreshModelsForProvider(def.name);
        return;
      }

      return;
    }

    if (sub === 'list') {
      const list = ProvidersManager.list();
      if (list.length === 0) {
        console.log(`\n${colors.yellow}No providers configured.${colors.reset}`);
        console.log(`${colors.dim}  Use /providers add <name> to connect a provider (e.g. /providers add groq)${colors.reset}`);
        console.log(`${colors.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${colors.reset}`);
      } else {
        console.log(`\n${colors.bold}${colors.cyan}Connected Providers${colors.reset}`);
        console.log(`${colors.dim}${'─'.repeat(60)}${colors.reset}`);
        for (const entry of list) {
          const addedDate = new Date(entry.addedAt).toLocaleDateString();
          console.log(`  ${colors.cyan}${entry.name.padEnd(14)}${colors.reset}${colors.bold}${entry.displayName.padEnd(22)}${colors.reset}${colors.dim}${entry.maskedKey}  (added ${addedDate})${colors.reset}`);
        }
        console.log(`\n${colors.dim}  Use /providers remove <name> to remove a key.${colors.reset}`);
        console.log(`${colors.dim}  Use /providers test <name> to verify a connection.${colors.reset}`);
      }
      return;
    }

    if (sub === 'add') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        console.log(`\n${colors.yellow}Usage: /providers add <provider-name>${colors.reset}`);
        console.log(`${colors.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${colors.reset}`);
        return;
      }
      const def = ProvidersManager.getDefinition(name);
      if (!def) {
        console.log(`\n${colors.red}✗ Unknown provider: ${name}${colors.reset}`);
        console.log(`${colors.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${colors.reset}`);
        return;
      }
      console.log(`\n${colors.cyan}${colors.bold}Connecting to ${def.displayName}${colors.reset}`);
      console.log(`${colors.dim}  Get your API key at: ${def.docsUrl}${colors.reset}`);
      ctx.rl.pause();
      const apiKeyInput = await p.text({
        message: `Enter your ${def.displayName} API key:`,
        placeholder: 'sk-... or gsk_...',
        validate: v => !v.trim() ? 'API key is required' : undefined,
      });
      ctx.rl.resume();
      if (p.isCancel(apiKeyInput)) {
        console.log(`\n${colors.dim}Provider add cancelled.${colors.reset}`);
        return;
      }
      ProvidersManager.add(name, apiKeyInput as string);
      persistModelSelection(ctx.config, ctx.state.currentModel, def.name);
      console.log(`\n${colors.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${colors.reset}`);
      console.log(`${colors.dim}  FixO will now route ${def.displayName} requests directly (bypassing the SaaS proxy).${colors.reset}`);
      await ctx.refreshModelsForProvider(name);
      return;
    }

    if (sub === 'remove') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        console.log(`\n${colors.yellow}Usage: /providers remove <name>${colors.reset}`);
        return;
      }
      ctx.rl.pause();
      const confirmed = await p.confirm({ message: `Remove API key for ${name}?`, initialValue: false });
      ctx.rl.resume();
      if (!p.isCancel(confirmed) && confirmed) {
        const removed = ProvidersManager.remove(name);
        console.log(removed
          ? `\n${colors.green}✓ Removed API key for ${name}.${colors.reset}`
          : `\n${colors.yellow}No key found for provider: ${name}${colors.reset}`);
      }
      return;
    }

    if (sub === 'test') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        console.log(`\n${colors.yellow}Usage: /providers test <name>${colors.reset}`);
        return;
      }
      const directConf = ProvidersManager.getDirectConfig(name);
      if (!directConf) {
        console.log(`\n${colors.yellow}No key configured for ${name}. Use /providers add ${name} first.${colors.reset}`);
        return;
      }
      console.log(`\n${colors.dim}Testing connection to ${directConf.displayName} (${directConf.baseUrl})...${colors.reset}`);
      try {
        const testHeaders: Record<string, string> = {
          'Authorization': `Bearer ${directConf.apiKey}`,
        };
        if (name === 'zen' || name === 'openrouter') {
          testHeaders['HTTP-Referer'] = 'https://opencode.ai/';
          testHeaders['X-Title'] = 'opencode';
        } else if (name === 'nvidia') {
          testHeaders['HTTP-Referer'] = 'https://opencode.ai/';
          testHeaders['X-Title'] = 'opencode';
          testHeaders['X-BILLING-INVOKE-ORIGIN'] = 'OpenCode';
        } else if (name === 'cerebras') {
          testHeaders['X-Cerebras-3rd-Party-Integration'] = 'opencode';
        }

        const resp = await fetch(`${directConf.baseUrl}/models`, {
          headers: testHeaders,
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          console.log(`${colors.green}✓ Connection to ${directConf.displayName} successful! (HTTP ${resp.status})${colors.reset}`);
          // Warm the cache so /model picker shows live IDs.
          await ctx.refreshModelsForProvider(name);
        } else {
          const text = await resp.text().catch(() => '');
          console.log(`${colors.red}✗ ${directConf.displayName} returned HTTP ${resp.status}${text ? ': ' + text.slice(0, 100) : ''}${colors.reset}`);
        }
      } catch (err: any) {
        console.log(`${colors.red}✗ Connection failed: ${err.message}${colors.reset}`);
      }
      return;
    }

    console.log(`\n${colors.yellow}Usage: /providers [list | add <name> | remove <name> | test <name>]${colors.reset}`);
    console.log(`${colors.dim}  Available providers: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${colors.reset}`);
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
      console.log(`  ${colors.bold}fast${colors.reset}    → ${routing.fast ?? colors.dim + '(unset)' + colors.reset}`);
      console.log(`  ${colors.bold}default${colors.reset} → ${routing.default ?? colors.dim + '(unset)' + colors.reset}`);
      console.log(`  ${colors.bold}heavy${colors.reset}   → ${routing.heavy ?? colors.dim + '(unset)' + colors.reset}`);
      console.log(`${colors.dim}\n  Usage:\n    /model-routing fast <model>\n    /model-routing heavy <model>\n    /model-routing default <model>\n    /model-routing clear [tier]${colors.reset}`);
    } else if (sub === 'clear') {
      const tier = ctx.args[1]?.toLowerCase();
      if (!tier) {
        ctx.config.preferences.modelRouting = {};
        saveConfig(ctx.config);
        console.log(`\n${colors.green}✓ All model-routing tiers cleared${colors.reset}`);
      } else if (tier === 'fast' || tier === 'default' || tier === 'heavy') {
        const next = { ...routing };
        delete next[tier];
        ctx.config.preferences.modelRouting = next;
        saveConfig(ctx.config);
        console.log(`\n${colors.green}✓ Cleared ${tier} tier${colors.reset}`);
      } else {
        console.log(`\n${colors.yellow}Unknown tier: ${tier}. Expected fast, default, or heavy.${colors.reset}`);
      }
    } else if (sub === 'fast' || sub === 'default' || sub === 'heavy') {
      const modelName = ctx.args[1];
      if (!modelName) {
        console.log(`\n${colors.yellow}Usage: /model-routing ${sub} <model-name>${colors.reset}`);
      } else {
        ctx.config.preferences.modelRouting = { ...routing, [sub]: modelName };
        saveConfig(ctx.config);
        console.log(`\n${colors.green}✓ Set ${sub} tier → ${modelName}${colors.reset}`);
        console.log(`${colors.dim}  Restart the session or run a new task — agents will pick up the new tier on construction.${colors.reset}`);
      }
    } else {
      console.log(`\n${colors.yellow}Unknown sub-command: ${sub}. Try /model-routing without arguments to see usage.${colors.reset}`);
    }
    return;
};

