import * as p from '@clack/prompts';
import type { FreeLLMConfig, ProviderMode } from './config.js';
import { getDefaultConfig, saveConfig, DEFAULT_API_URL } from './config.js';

/**
 * Runs the interactive first-run setup wizard for FixO CLI.
 *
 * Asks the user to pick an authentication mode first:
 *   1. Direct (recommended) — paste a provider key (OpenAI, Anthropic,
 *      Groq, …) and the CLI talks straight to that provider. Zero
 *      traffic transits a third-party proxy.
 *   2. FreeLLMAPI proxy — opt-in convenience for users who want
 *      load-balanced failover across free-tier providers without
 *      managing individual keys.
 *
 * The direct path is the default for new installs (Phase 1 of the
 * remediation plan). The proxy path remains fully supported.
 */
export async function runSetupWizard(): Promise<FreeLLMConfig> {
  p.intro('🚀 Welcome to FixO CLI Setup');

  const mode = (await p.select({
    message: 'How would you like to authenticate?',
    initialValue: 'direct',
    options: [
      {
        value: 'direct',
        label: 'Direct provider (recommended) — bring your own key',
        hint: 'OpenAI, Anthropic, Groq, Google, etc. Zero proxy traffic.',
      },
      {
        value: 'proxy',
        label: 'FreeLLMAPI proxy (opt-in convenience)',
        hint: 'Load-balanced failover across free-tier providers via the FreeLLMAPI SaaS.',
      },
    ],
  })) as ProviderMode | symbol;

  if (p.isCancel(mode)) {
    p.outro('Setup cancelled.');
    process.exit(1);
  }

  if (mode === 'direct') {
    return await runDirectSetup();
  }
  return await runProxySetup();
}

/* ──────────────────────── Direct provider setup ──────────────────────── */

async function runDirectSetup(): Promise<FreeLLMConfig> {
  // Dynamic import keeps the proxy-only boot path free of provider
  // registry load cost when the user picks proxy.
  const { ProvidersManager, PROVIDER_REGISTRY } = await import('./agent/providers-manager.js');

  const providerName = await p.select({
    message: 'Pick a provider:',
    initialValue: 'openai',
    options: PROVIDER_REGISTRY.map((def) => ({
      value: def.name,
      label: def.displayName,
      hint: def.docsUrl,
    })),
  });

  if (p.isCancel(providerName)) {
    p.outro('Setup cancelled.');
    process.exit(1);
  }

  const def = PROVIDER_REGISTRY.find((d) => d.name === providerName);
  if (!def) {
    p.outro('Setup cancelled — unknown provider selected.');
    process.exit(1);
  }

  const apiKey = await p.password({
    message: `Paste your ${def.displayName} API key:`,
    validate: (val) => {
      if (!val || !val.trim()) return 'API key is required';
      return;
    },
  });

  if (p.isCancel(apiKey)) {
    p.outro('Setup cancelled.');
    process.exit(1);
  }

  // Persist the key and hydrate the in-memory vault so the very first
  // request after setup can find it without a restart.
  ProvidersManager.add(providerName as string, apiKey as string);

  const modelOptions = def.models.slice(0, 12).map((m) => ({ value: m, label: m }));
  const defaultModel = await p.select({
    message: `Default model for ${def.displayName}:`,
    initialValue: def.models[0],
    options: modelOptions,
  });

  if (p.isCancel(defaultModel)) {
    p.outro('Setup cancelled.');
    process.exit(1);
  }

  const config = getDefaultConfig();
  config.provider_mode = 'direct';
  config.directProvider = {
    name: providerName as string,
    defaultModel: defaultModel as string,
  };
  config.defaultModel = defaultModel as string;
  config._firstRunComplete = true;
  // `freellmapi_api_key` and `apiUrl` deliberately left unset — the
  // direct path must not touch the proxy.

  saveConfig(config);
  p.outro(
    `✓ Configured ${def.displayName} (${defaultModel}). Config at ~/.fixocli/config.json, key at ~/.fixocli/providers.json.`,
  );

  return config;
}

/* ──────────────────────── Proxy setup ──────────────────────── */

async function runProxySetup(): Promise<FreeLLMConfig> {
  console.log(`┌────────────────────────────────────────────────────────────────┐
│  FreeLLMAPI proxy mode.                                        │
│                                                                │
│  1. Open your dashboard at the FreeLLMAPI host.                │
│  2. Navigate to Profile / API Keys.                            │
│  3. Copy your master 'freellmapi-…' key.                       │
└────────────────────────────────────────────────────────────────┘\n`);

  const serverChoice = await p.select({
    message: 'Select your FreeLLMAPI server endpoint:',
    options: [
      { value: DEFAULT_API_URL, label: 'Cloud Hosted SaaS (Default)' },
      { value: 'http://localhost:3001/v1', label: 'Local Development Server (http://localhost:3001/v1)' },
      { value: 'custom', label: 'Custom Endpoint URL' },
    ],
  });

  if (p.isCancel(serverChoice)) {
    p.outro('Setup cancelled.');
    process.exit(1);
  }

  let apiUrl = serverChoice as string;
  if (serverChoice === 'custom') {
    const customUrl = await p.text({
      message: 'Enter your custom FreeLLMAPI Endpoint URL:',
      placeholder: 'https://api.custom-domain.com/v1',
      validate: (val) => {
        if (!val.trim()) return 'URL is required';
        return;
      },
    });

    if (p.isCancel(customUrl)) {
      p.outro('Setup cancelled.');
      process.exit(1);
    }
    apiUrl = customUrl.trim();
  }

  const apiKeyInput = await p.text({
    message: 'Enter your FreeLLMAPI API key:',
    placeholder: 'freellmapi-user-sk-...',
    validate: (val) => {
      if (!val.trim()) {
        return 'API key is required';
      }
      if (!val.trim().startsWith('freellmapi-')) {
        return 'API key must start with "freellmapi-"';
      }
      return;
    },
  });

  if (p.isCancel(apiKeyInput)) {
    p.outro('Setup cancelled. FixO CLI requires an API key to function.');
    process.exit(1);
  }

  const config = getDefaultConfig();
  config.provider_mode = 'proxy';
  config.freellmapi_api_key = apiKeyInput.trim();
  config.apiUrl = apiUrl;
  config._firstRunComplete = true;

  saveConfig(config);

  p.outro('✓ FreeLLMAPI configuration saved to ~/.fixocli/config.json');

  // Proxy users can still opt-in to direct provider keys as
  // failover / hybrid usage (preserves the original v1.0 behaviour).
  const configureProviders = await p.confirm({
    message: 'Also add direct provider keys? (You can do this later via /providers add)',
    initialValue: false,
  });

  if (configureProviders) {
    const { ProvidersManager, PROVIDER_REGISTRY } = await import('./agent/providers-manager.js');

    const selectedProviders = await p.multiselect({
      message: 'Select providers to configure:',
      options: PROVIDER_REGISTRY.map((def) => ({
        value: def.name,
        label: def.displayName,
        hint: def.docsUrl,
      })),
      required: false,
    });

    if (!p.isCancel(selectedProviders) && selectedProviders.length > 0) {
      let configuredCount = 0;
      for (const name of selectedProviders) {
        const def = PROVIDER_REGISTRY.find((d) => d.name === name);
        if (!def) continue;
        const apiKey = await p.password({
          message: `Enter API key for ${def.displayName}:`,
          validate: (val) => {
            if (!val.trim()) return 'API key is required';
            return;
          },
        });

        if (!p.isCancel(apiKey) && apiKey) {
          ProvidersManager.add(name as string, apiKey as string);
          configuredCount++;
          console.log(`  ✓ ${def.displayName} key saved`);
        }
      }

      if (configuredCount > 0) {
        p.outro(`✓ ${configuredCount} provider key(s) saved to ~/.fixocli/providers.json`);
      }
    }
  }

  return config;
}
