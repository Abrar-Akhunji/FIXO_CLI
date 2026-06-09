import * as p from '@clack/prompts';
import type { FreeLLMConfig } from './config.js';
import { getDefaultConfig, saveConfig, DEFAULT_API_URL } from './config.js';

/**
 * Runs the interactive first-run setup wizard for FixO CLI.
 * Links the CLI terminal to the FreeLLMAPI SaaS cloud by prompting
 * for the master API key, destination URL, and saving it to the configuration.
 * Also offers to configure individual provider API keys for direct access.
 */
export async function runSetupWizard(): Promise<FreeLLMConfig> {
  p.intro('🚀 Welcome to FixO CLI Setup');

  console.log(`┌────────────────────────────────────────────────────────────────┐
│  🚀 Welcome to FixO CLI!                                       │
│  Let's link your CLI terminal to your FreeLLMAPI SaaS cloud.   │
│                                                                │
│  1. Open your web browser and navigate to your dashboard.       │
│  2. Sign in to your account.                                   │
│  3. Navigate to the Profile / API Keys section.                │
│  4. Copy your master 'FreeLLMAPI' API key.                     │
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
  config.freellmapi_api_key = apiKeyInput.trim();
  config.apiUrl = apiUrl;
  config._firstRunComplete = true;

  saveConfig(config);

  p.outro('✓ FreeLLMAPI configuration saved to ~/.fixocli/config.json');

  // ──── Optional: Configure individual provider API keys ────
  const configureProviders = await p.confirm({
    message: 'Would you like to add API keys for individual AI providers? (You can also do this later via /providers add)',
    initialValue: false,
  });

  if (configureProviders) {
    // Dynamic import to avoid any module-load-time side effects
    const { ProvidersManager, PROVIDER_REGISTRY } = await import('./agent/providers-manager.js');

    const selectedProviders = await p.multiselect({
      message: 'Select providers to configure (you can add more later via /providers add):',
      options: PROVIDER_REGISTRY.map(def => ({
        value: def.name,
        label: def.displayName,
        hint: def.docsUrl,
      })),
      required: false,
    });

    if (!p.isCancel(selectedProviders) && selectedProviders.length > 0) {
      let configuredCount = 0;
      for (const name of selectedProviders) {
        const def = PROVIDER_REGISTRY.find(d => d.name === name)!;
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
