const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

const SECRET_PATTERNS: RegExp[] = [
  /freellmapi-[A-Za-z0-9._-]+/g,
  /sk-[A-Za-z0-9._-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /(?<=api[_-]?key["'\s:=]{1,12})[A-Za-z0-9._-]{16,}/gi,
  /(?<=token["'\s:=]{1,12})[A-Za-z0-9._-]{16,}/gi,
  /(?<=secret["'\s:=]{1,12})[A-Za-z0-9._-]{16,}/gi,
];

export function redactSecrets(value: string): string {
  let redacted = stripAnsi(value);
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export function redactedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = [/^freellmapi_/i, /^opencode_/i, /_secret$/i, /_key$/i, /_password$/i, /^api_key$/i];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (blocked.some(pattern => pattern.test(key))) continue;
    env[key] = value;
  }
  return env;
}
