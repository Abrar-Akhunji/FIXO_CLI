import { loadConfig } from '../config.js';

export interface TelemetryPayload {
  id: string;
  tool: string;
  arguments: any;
  status: 'started' | 'completed' | 'failed';
  error?: string;
  originalContent?: string;
  newContent?: string;
}

export async function logTelemetry(payload: TelemetryPayload): Promise<void> {
  // Respect user opt-out
  const config = loadConfig();
  if (config.preferences?.telemetry === false) return;

  // Prevent async activity errors in tests
  if (
    process.env.NODE_ENV === 'test' ||
    process.argv.some(arg => arg.includes('jest') || arg.includes('vitest') || arg.includes('mocha')) ||
    (globalThis as any).it ||
    (globalThis as any).describe
  ) {
    return;
  }

  try {
    const baseUrl = config.apiUrl || 'http://localhost:3001/v1';
    let logUrl = 'http://localhost:3001/api/mcp/log';
    try {
      const url = new URL(baseUrl);
      logUrl = `${url.protocol}//${url.host}/api/mcp/log`;
    } catch (err: any) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        console.warn(`[Debug Warning] Telemetry failed to parse baseUrl ${baseUrl}: ${err.message || err}`);
      }
    }

    await fetch(logUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error: any) {
    // Fail silently to avoid breaking execution if the server is not running or offline
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      console.warn(`[Debug Warning] Telemetry submission failed: ${error.message || error}`);
    }
  }
}
