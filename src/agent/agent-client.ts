/**
 * HTTP client for the FreeLLMAPI proxy server.
 * Supports both regular and streaming (SSE) chat completions.
 * Includes retry with exponential backoff for transient errors.
 */
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  TokenUsage,
} from '../shared/types.js';
import { colors } from '../ui/colors.js';
import { ProvidersManager } from './providers-manager.js';
import { providerCooldown } from './provider-cooldown.js';
import {
  reconstructPartialResponse,
  isMidStreamResumable,
  StreamResumeExhaustedError,
} from './stream-glue.js';
import { DEFAULT_API_URL } from '../config.js';
import { recordTelemetry, telemetry } from './telemetry.js';
import { getProviderKeyVault } from '../runtime/credential-vault.js';

/* ──────────────────────── Constants ──────────────────────── */

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503]);
const BASE_URL = process.env.FIXO_API_URL || DEFAULT_API_URL;

/** Wrapper around `providerCooldown.recordFailure` that also emits a
 *  telemetry event. Keeps the 6 callsites terse. */
function trackProviderError(
  providerId: string,
  status: number,
  message: string,
): number {
  const cooldownMs = providerCooldown.recordFailure(providerId, status, message);
  if (cooldownMs > 0) {
    recordTelemetry(
      telemetry.cooldown({
        providerId,
        status,
        cooldownMs,
        reason: message.slice(0, 200),
      }),
    );
  } else if (status >= 400) {
    recordTelemetry(
      telemetry.providerError({ providerId, status, message: message.slice(0, 200) }),
    );
  }
  return cooldownMs;
}

/* ──────────────────────── Interfaces ──────────────────────── */

export interface ChatOptions {
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  temperature?: number;
  max_tokens?: number;
  agent_task_type?: 'chat' | 'review' | 'mutation' | 'test-fix' | 'refactor' | 'investigation';
  required_capabilities?: string[];
}

export interface ChatResult {
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> | null;
  usage: TokenUsage;
  model: string;
  finish_reason: string | null;
}

export interface StreamChunk {
  type: 'content' | 'thinking' | 'tool_call_start' | 'tool_call_delta' | 'done';
  content?: string;
  thinking?: string;
  tool_call?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  };
  usage?: TokenUsage;
  model?: string;
  finish_reason?: string | null;
}

/* ──────────────────────── ThinkTagParser ──────────────────────── */

export enum ContentType {
  TEXT = 'text',
  THINKING = 'thinking',
}

export interface ContentChunk {
  type: ContentType;
  content: string;
}

export class ThinkTagParser {
  private OPEN_TAG = '<think>';
  private CLOSE_TAG = '</think>';
  private _buffer: string = '';
  private _in_think_tag: boolean = false;

  get in_think_mode(): boolean {
    return this._in_think_tag;
  }

  *feed(content: string): Generator<ContentChunk> {
    this._buffer += content;

    while (this._buffer) {
      const prev_len = this._buffer.length;
      let chunk: ContentChunk | null = null;
      if (!this._in_think_tag) {
        chunk = this._parse_outside_think();
      } else {
        chunk = this._parse_inside_think();
      }

      if (chunk) {
        yield chunk;
      } else if (this._buffer.length === prev_len) {
        break;
      }
    }
  }

  private _parse_outside_think(): ContentChunk | null {
    const think_start = this._buffer.indexOf(this.OPEN_TAG);
    const orphan_close = this._buffer.indexOf(this.CLOSE_TAG);

    if (orphan_close !== -1 && (think_start === -1 || orphan_close < think_start)) {
      const pre_orphan = this._buffer.slice(0, orphan_close);
      this._buffer = this._buffer.slice(orphan_close + this.CLOSE_TAG.length);
      if (pre_orphan) {
        return { type: ContentType.TEXT, content: pre_orphan };
      }
      return null;
    }

    if (think_start === -1) {
      const last_bracket = this._buffer.lastIndexOf('<');
      if (last_bracket !== -1) {
        const potential_tag = this._buffer.slice(last_bracket);
        const tag_len = potential_tag.length;
        if (
          (tag_len < this.OPEN_TAG.length && this.OPEN_TAG.startsWith(potential_tag)) ||
          (tag_len < this.CLOSE_TAG.length && this.CLOSE_TAG.startsWith(potential_tag))
        ) {
          const emit = this._buffer.slice(0, last_bracket);
          this._buffer = this._buffer.slice(last_bracket);
          if (emit) {
            return { type: ContentType.TEXT, content: emit };
          }
          return null;
        }
      }

      const emit = this._buffer;
      this._buffer = '';
      if (emit) {
        return { type: ContentType.TEXT, content: emit };
      }
      return null;
    }

    const pre_think = this._buffer.slice(0, think_start);
    this._buffer = this._buffer.slice(think_start + this.OPEN_TAG.length);
    this._in_think_tag = true;
    if (pre_think) {
      return { type: ContentType.TEXT, content: pre_think };
    }
    return null;
  }

  private _parse_inside_think(): ContentChunk | null {
    const think_end = this._buffer.indexOf(this.CLOSE_TAG);

    if (think_end === -1) {
      const last_bracket = this._buffer.lastIndexOf('<');
      if (last_bracket !== -1 && this._buffer.length - last_bracket < this.CLOSE_TAG.length) {
        const potential_tag = this._buffer.slice(last_bracket);
        if (this.CLOSE_TAG.startsWith(potential_tag)) {
          const emit = this._buffer.slice(0, last_bracket);
          this._buffer = this._buffer.slice(last_bracket);
          if (emit) {
            return { type: ContentType.THINKING, content: emit };
          }
          return null;
        }
      }

      const emit = this._buffer;
      this._buffer = '';
      if (emit) {
        return { type: ContentType.THINKING, content: emit };
      }
      return null;
    }

    const thinking_content = this._buffer.slice(0, think_end);
    this._buffer = this._buffer.slice(think_end + this.CLOSE_TAG.length);
    this._in_think_tag = false;
    if (thinking_content) {
      return { type: ContentType.THINKING, content: thinking_content };
    }
    return null;
  }

  flush(): ContentChunk | null {
    if (this._buffer) {
      const chunk_type = this._in_think_tag ? ContentType.THINKING : ContentType.TEXT;
      const content = this._buffer;
      this._buffer = '';
      return { type: chunk_type, content };
    }
    return null;
  }
}

/* ──────────────────────── HttpError ──────────────────────── */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

/* ──────────────────────── AgentClient ──────────────────────── */

export class AgentClient {
  private baseUrl: string;
  private apiKey: string;
  private verbose: boolean;

  constructor(apiKey: string, apiUrl?: string, verbose = false) {
    this.baseUrl = process.env.FIXO_API_URL || apiUrl || BASE_URL;
    this.apiKey = apiKey;
    this.verbose = verbose;
  }

  private resolveDirectConfig(model: string): {
    baseUrl: string;
    displayName: string;
    providerName: string;
    openAICompat: boolean;
  } | null {
    const modelLower = model.toLowerCase();
    let providerName: string | null = null;

    if (modelLower.startsWith('gpt-') || modelLower.startsWith('o3-') || modelLower.startsWith('o4-') || modelLower.startsWith('o1-')) {
      providerName = 'openai';
    } else if (modelLower.startsWith('claude-')) {
      providerName = 'anthropic';
    } else if (modelLower.startsWith('gemini-')) {
      providerName = 'google';
    } else {
      const definitions = ProvidersManager.getAllDefinitions();
      for (const def of definitions) {
        if (def.models.some(m => modelLower.includes(m.toLowerCase()))) {
          providerName = def.name;
          break;
        }
      }
      if (!providerName) {
        for (const def of definitions) {
          if (modelLower.startsWith(def.name + '/') || modelLower.startsWith(def.name + ':')) {
            providerName = def.name;
            break;
          }
        }
      }
    }

    if (providerName) {
      const direct = ProvidersManager.getDirectConfig(providerName);
      if (direct) {
        const def = ProvidersManager.getDefinition(providerName);
        return {
          baseUrl: direct.baseUrl,
          displayName: direct.displayName,
          providerName,
          openAICompat: def ? def.openAICompat : true,
        };
      }
    }
    return null;
  }

  /**
   * Maps a model id to the provider that will actually serve the
   * request — used as the key for `providerCooldown` tracking. The
   * `freellmapi` sentinel covers the proxy path; everything else
   * routes through a direct provider.
   */
  private getProviderId(model: string): string {
    const direct = this.resolveDirectConfig(model);
    if (direct) return direct.providerName;
    return 'freellmapi';
  }

  /* ─── Non-streaming chat ─── */

  async chat(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const providerId = this.getProviderId(model);
    providerCooldown.assertAvailable(providerId);

    const direct = this.resolveDirectConfig(model);
    const isAnthropicDirect = direct && direct.providerName === 'anthropic';

    let requestUrl = `${this.baseUrl}/chat/completions`;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    let body = '';

    if (direct) {
      // Pillar 4: source the API key from the credential vault so
      // the raw value never lands in a return value, an error
      // payload, or a log line. The key is reachable only inside
      // the withApiKey callback.
      const vault = getProviderKeyVault();
      if (isAnthropicDirect) {
        requestUrl = `${direct.baseUrl}/messages`;
        headers = await vault.withApiKey(direct.providerName, (key) => ({
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }));
        body = JSON.stringify(translateOpenAIToAnthropic(messages, model, options));
      } else {
        requestUrl = `${direct.baseUrl}/chat/completions`;
        headers = await vault.withApiKey(direct.providerName, (key) => {
          const h: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          };
          if (direct.providerName === 'zen' || direct.providerName === 'openrouter') {
            h['HTTP-Referer'] = 'https://opencode.ai/';
            h['X-Title'] = 'opencode';
          } else if (direct.providerName === 'nvidia') {
            h['HTTP-Referer'] = 'https://opencode.ai/';
            h['X-Title'] = 'opencode';
            h['X-BILLING-INVOKE-ORIGIN'] = 'OpenCode';
          } else if (direct.providerName === 'cerebras') {
            h['X-Cerebras-3rd-Party-Integration'] = 'opencode';
          }
          return h;
        });
        const bodyObj: Record<string, any> = {
          model,
          messages,
          stream: false,
          ...options,
        };
        body = JSON.stringify(bodyObj);
      }
    } else {
      const hasTools = options.tools && Array.isArray(options.tools) && options.tools.length > 0;
      const bodyObj: Record<string, any> = {
        model,
        messages,
        stream: false,
        ...options,
      };
      if (hasTools) {
        bodyObj.x_requires_tools = true;
        headers['X-Requires-Tools'] = 'true';
      }
      if (options.agent_task_type) {
        bodyObj.x_agent_task_type = options.agent_task_type;
        bodyObj.x_required_capabilities = options.required_capabilities ?? [];
        headers['X-Agent-Task-Type'] = options.agent_task_type;
      }
      body = JSON.stringify(bodyObj);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(60000), // 60s timeout
        });

        // Non-retryable errors
        if (response.status === 413) {
          throw new Error(
            `Context too large (413). Reduce pinned files or use a model with a larger context window.`,
          );
        }
        if (response.status === 404) {
          throw new Error(
            `Model not found (404). Try a different model with /model <name>.`,
          );
        }

        // Retryable errors
        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          trackProviderError(providerId, response.status, `HTTP ${response.status}`);
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          if (attempt < MAX_RETRIES) {
            console.log(
              `${colors.yellow}⚠  [API] Error ${response.status}. Retrying in ${(delayMs / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})${colors.reset}`,
            );
            await sleep(delayMs);
            continue;
          }
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`API error (${response.status}): ${errorText}`);
        }

        const rawData = await response.json();
        const data = isAnthropicDirect ? translateAnthropicToOpenAI(rawData) : rawData as ChatCompletionResponse;
        const choice = data.choices[0];

        providerCooldown.recordSuccess(providerId);
        return {
          content: choice?.message?.content ?? null,
          tool_calls: choice?.message?.tool_calls ?? null,
          usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: data.model,
          finish_reason: choice?.finish_reason ?? null,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry context too large errors
        if (lastError.message.includes('413')) {
          throw lastError;
        }

        // 404 from the local FreeLLMAPI proxy = model not in catalog (user typo).
        // This is a user error, not retryable.
        if (lastError.message.includes('API error (404)')) {
          throw lastError;
        }

        // 502 from the local proxy = all configured providers exhausted/failed.
        // Give actionable error instead of generic "retry".
        if (lastError.message.includes('API error (502)') || lastError.message.includes('502')) {
          const isAllExhausted = lastError.message.toLowerCase().includes('all models') ||
            lastError.message.toLowerCase().includes('provider error');
          if (isAllExhausted || attempt >= MAX_RETRIES - 1) {
            const helpMsg = lastError.message.toLowerCase().includes('provider error')
              ? `Provider error: all configured models failed or are rate-limited.\n  → Open http://localhost:5173 → API Keys → add more provider keys.\n  → Or wait a few minutes for rate limits to reset.`
              : lastError.message;
            throw new Error(helpMsg);
          }
        }

        // Retry network/timeout errors
        const isNetworkError =
          lastError.name === 'TimeoutError' ||
          lastError.message.includes('Timeout') ||
          lastError.message.includes('ECONNREFUSED') ||
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('fetch failed') ||
          lastError.message.includes('ETIMEDOUT');

        if (lastError.message.includes('ECONNREFUSED') || lastError.message.includes('fetch failed')) {
          if (attempt >= MAX_RETRIES - 1) {
            throw new Error(
              `Cannot connect to FreeLLMAPI server at ${this.baseUrl}.\n` +
              `  → Make sure the server is running: npm run dev\n` +
              `  → Then restart the CLI: npm run cli`
            );
          }
        }

        if (isNetworkError && attempt < MAX_RETRIES) {
          trackProviderError(providerId, 0, lastError.message.slice(0, 200));
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(
            `${colors.yellow}⚠  [Network] ${lastError.message.slice(0, 60)}. Retrying in ${(delayMs / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})${colors.reset}`,
          );
          await sleep(delayMs);
          continue;
        }

        if (attempt >= MAX_RETRIES) break;
        if (!isNetworkError) throw lastError;
      }
    }

    throw lastError ?? new Error('All retry attempts exhausted.');
  }

  /* ─── Streaming chat (SSE) ─── */

  private async *executeSingleChatStreamAttempt(
    requestUrl: string,
    headers: Record<string, string>,
    body: string,
    model: string,
    isAnthropicDirect: boolean,
  ): AsyncGenerator<StreamChunk> {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(60000), // 60s timeout
    });

    if (response.status === 413) {
      throw new Error(
        `Context too large (413). Reduce pinned files or use a model with a larger context window.`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `Model not found (404). Try a different model with /model <name>.`,
      );
    }

    if (RETRYABLE_STATUS_CODES.has(response.status)) {
      throw new HttpError(response.status, `API error ${response.status}`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported.');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let accumulatedModel = model;
    const parser = new ThinkTagParser();
    let currentToolCallIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ':') continue; // Skip comments and empty lines

        if (isAnthropicDirect) {
          if (trimmed.startsWith('event: ')) {
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            // skip malformed JSON chunks
            continue;
          }

          if (chunk && (chunk.type === 'error' || chunk.error)) {
            const errMsg = chunk.error && chunk.error.message 
              ? chunk.error.message 
              : (chunk.message || JSON.stringify(chunk));
            throw new Error(`Anthropic stream error: ${errMsg}`);
          }
          if (chunk.type === 'message_start') {
            if (chunk.message && chunk.message.model) {
              accumulatedModel = chunk.message.model;
            }
          } else if (chunk.type === 'content_block_start') {
            const block = chunk.content_block;
            currentToolCallIndex = chunk.index ?? 0;
            if (block && block.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                tool_call: {
                  index: currentToolCallIndex,
                  id: block.id,
                  function: {
                    name: block.name,
                    arguments: '',
                  }
                }
              };
            }
          } else if (chunk.type === 'content_block_delta') {
            const delta = chunk.delta;
            if (delta) {
              if (delta.type === 'text_delta' && delta.text) {
                for (const parsedChunk of parser.feed(delta.text)) {
                  if (parsedChunk.type === ContentType.THINKING) {
                    yield { type: 'thinking', thinking: parsedChunk.content };
                  } else {
                    yield { type: 'content', content: parsedChunk.content };
                  }
                }
              } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                yield {
                  type: 'tool_call_delta',
                  tool_call: {
                    index: currentToolCallIndex,
                    function: {
                      arguments: delta.partial_json,
                    }
                  }
                };
              }
            }
          } else if (chunk.type === 'message_delta') {
            if (chunk.usage) {
              accumulatedUsage = {
                prompt_tokens: chunk.usage.input_tokens || 0,
                completion_tokens: chunk.usage.output_tokens || 0,
                total_tokens: (chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0),
              };
            }
          } else if (chunk.type === 'message_stop') {
            const flushed = parser.flush();
            if (flushed) {
              if (flushed.type === ContentType.THINKING) {
                yield { type: 'thinking', thinking: flushed.content };
              } else {
                yield { type: 'content', content: flushed.content };
              }
            }
            yield {
              type: 'done',
              usage: accumulatedUsage,
              model: accumulatedModel,
            };
          }
        } else {
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);

          if (data === '[DONE]') {
            const flushed = parser.flush();
            if (flushed) {
              if (flushed.type === ContentType.THINKING) {
                yield { type: 'thinking', thinking: flushed.content };
              } else {
                yield { type: 'content', content: flushed.content };
              }
            }
            yield {
              type: 'done',
              usage: accumulatedUsage,
              model: accumulatedModel,
            };
            return;
          }

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            // Skip malformed JSON chunks
            if (this.verbose) {
              console.log(`${colors.gray}[stream] Skipped malformed chunk: ${data.slice(0, 80)}${colors.reset}`);
            }
            continue;
          }

          if (chunk && chunk.error) {
            const errMsg = typeof chunk.error === 'object' && chunk.error.message 
              ? chunk.error.message 
              : JSON.stringify(chunk.error);
            throw new Error(`Stream error: ${errMsg}`);
          }
          if (chunk.model) accumulatedModel = chunk.model;
          if ((chunk as any).usage) {
            accumulatedUsage = (chunk as any).usage;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          // reasoning_content delta
          if ((choice.delta as any).reasoning_content) {
            yield {
              type: 'thinking',
              thinking: (choice.delta as any).reasoning_content,
                };
          }

          // Content delta
          if (choice.delta?.content) {
            for (const parsedChunk of parser.feed(choice.delta.content)) {
              if (parsedChunk.type === ContentType.THINKING) {
                yield {
                  type: 'thinking',
                  thinking: parsedChunk.content,
                };
              } else {
                yield {
                  type: 'content',
                  content: parsedChunk.content,
                };
              }
            }
          }

          // Tool call deltas
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = (tc as any).index ?? 0;
              if (tc.id) {
                yield {
                  type: 'tool_call_start',
                  tool_call: {
                    index: idx,
                    id: tc.id,
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  },
                };
              } else {
                yield {
                  type: 'tool_call_delta',
                  tool_call: {
                    index: idx,
                    function: {
                      arguments: tc.function?.arguments ?? '',
                    },
                  },
                };
              }
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            const flushed = parser.flush();
            if (flushed) {
              if (flushed.type === ContentType.THINKING) {
                yield { type: 'thinking', thinking: flushed.content };
              } else {
                yield { type: 'content', content: flushed.content };
              }
            }
            yield {
              type: 'done',
              finish_reason: choice.finish_reason,
              usage: accumulatedUsage,
              model: accumulatedModel,
            };
          }
        }
      }
    }

    // Stream ended without [DONE]
    const flushed = parser.flush();
    if (flushed) {
      if (flushed.type === ContentType.THINKING) {
        yield { type: 'thinking', thinking: flushed.content };
      } else {
        yield { type: 'content', content: flushed.content };
      }
    }
    yield {
      type: 'done',
      usage: accumulatedUsage,
      model: accumulatedModel,
    };
  }

  async *chatStream(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const providerId = this.getProviderId(model);
    providerCooldown.assertAvailable(providerId);

    const direct = this.resolveDirectConfig(model);
    const isAnthropicDirect = !!(direct && direct.providerName === 'anthropic');

    let requestUrl = `${this.baseUrl}/chat/completions`;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    let body = '';

    if (direct) {
      // Pillar 4: source the API key from the credential vault.
      const vault = getProviderKeyVault();
      if (isAnthropicDirect) {
        requestUrl = `${direct.baseUrl}/messages`;
        headers = await vault.withApiKey(direct.providerName, (key) => ({
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }));
        const payload = translateOpenAIToAnthropic(messages, model, options);
        payload.stream = true;
        body = JSON.stringify(payload);
      } else {
        requestUrl = `${direct.baseUrl}/chat/completions`;
        headers = await vault.withApiKey(direct.providerName, (key) => {
          const h: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          };
          if (direct.providerName === 'zen' || direct.providerName === 'openrouter') {
            h['HTTP-Referer'] = 'https://opencode.ai/';
            h['X-Title'] = 'opencode';
          } else if (direct.providerName === 'nvidia') {
            h['HTTP-Referer'] = 'https://opencode.ai/';
            h['X-Title'] = 'opencode';
            h['X-BILLING-INVOKE-ORIGIN'] = 'OpenCode';
          } else if (direct.providerName === 'cerebras') {
            h['X-Cerebras-3rd-Party-Integration'] = 'opencode';
          }
          return h;
        });
        const bodyObj: Record<string, any> = {
          model,
          messages,
          stream: true,
          ...options,
        };
        body = JSON.stringify(bodyObj);
      }
    } else {
      const hasTools = options.tools && Array.isArray(options.tools) && options.tools.length > 0;
      const bodyObj: Record<string, any> = {
        model,
        messages,
        stream: true,
        ...options,
      };
      if (hasTools) {
        bodyObj.x_requires_tools = true;
        headers['X-Requires-Tools'] = 'true';
      }
      if (options.agent_task_type) {
        bodyObj.x_agent_task_type = options.agent_task_type;
        bodyObj.x_required_capabilities = options.required_capabilities ?? [];
        headers['X-Agent-Task-Type'] = options.agent_task_type;
      }
      body = JSON.stringify(bodyObj);
    }

    let lastError: Error | null = null;
    let hasYielded = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = this.executeSingleChatStreamAttempt(
          requestUrl,
          headers,
          body,
          model,
          isAnthropicDirect,
        );

        for await (const chunk of stream) {
          hasYielded = true;
          yield chunk;
        }
        providerCooldown.recordSuccess(providerId);
        return; // Success — don't retry
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (hasYielded) {
          // If we have already yielded some chunks, do not retry because we cannot
          // rewind/resume the stream. Retrying would yield duplicate tokens on stdout.
          throw lastError;
        }

        // Don't retry context too large
        if (lastError.message.includes('413')) {
          throw lastError;
        }

        // 404 from proxy = model not in catalog (user typo), not retryable
        if (lastError.message.includes('API error (404)')) {
          throw lastError;
        }

        // 502 from proxy = all providers exhausted
        if (lastError.message.includes('API error (502)') || lastError.message.includes('502')) {
          const isAllExhausted = lastError.message.toLowerCase().includes('all models') ||
            lastError.message.toLowerCase().includes('provider error');
          if (isAllExhausted || attempt >= MAX_RETRIES - 1) {
            const helpMsg = lastError.message.toLowerCase().includes('provider error')
              ? `Provider error: all configured models failed or are rate-limited.\n  → Open http://localhost:5173 → API Keys → add more provider keys.\n  → Or wait a few minutes for rate limits to reset.`
              : lastError.message;
            throw new Error(helpMsg);
          }
        }

        const isNetworkError =
          lastError.name === 'TimeoutError' ||
          lastError.message.includes('Timeout') ||
          lastError.message.includes('ECONNREFUSED') ||
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('fetch failed') ||
          lastError.message.includes('ETIMEDOUT');

        if (lastError.message.includes('ECONNREFUSED') || lastError.message.includes('fetch failed')) {
          if (attempt >= MAX_RETRIES - 1) {
            throw new Error(
              `Cannot connect to FreeLLMAPI server at ${this.baseUrl}.\n` +
              `  → Make sure the server is running: npm run dev\n` +
              `  → Then restart the CLI: npm run cli`
            );
          }
        }

        if (lastError instanceof HttpError && RETRYABLE_STATUS_CODES.has(lastError.status)) {
          trackProviderError(providerId, lastError.status, `HTTP ${lastError.status}`);
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          if (attempt < MAX_RETRIES) {
            console.log(
              `${colors.yellow}⚠  [API] Error ${lastError.status}. Retrying in ${(delayMs / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})${colors.reset}`,
            );
            await sleep(delayMs);
            continue;
          }
        }

        if (isNetworkError && attempt < MAX_RETRIES) {
          trackProviderError(providerId, 0, lastError.message.slice(0, 200));
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(
            `${colors.yellow}⚠  [Network] ${lastError.message.slice(0, 60)}. Retrying in ${(delayMs / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})${colors.reset}`,
          );
          await sleep(delayMs);
          continue;
        }

        if (attempt >= MAX_RETRIES) break;
        if (!isNetworkError) throw lastError;
      }
    }

    throw lastError ?? new Error('All streaming retry attempts exhausted.');
  }

  /**
   * Streaming chat with autonomous mid-stream resume.
   *
   * If the underlying `chatStream` throws *after* at least one chunk
   * has been yielded, the resume engine inspects the partial response,
   * appends a "continue from here" payload to the working message list,
   * and starts a fresh streaming attempt. The consumer sees a single
   * continuous `AsyncGenerator<StreamChunk>` — the resume is invisible.
   *
   * The engine respects:
   *   - `maxResumeAttempts` (default 3) — additional attempts beyond
   *     this throw `StreamResumeExhaustedError`.
   *   - `isMidStreamResumable` — user aborts and 4xx are never resumed.
   *   - Cuts inside a tool call — the partial text up to the tool call
   *     boundary is preserved, but the call itself cannot be resumed.
   *
   * The method is *additive* and does not change the existing
   * `chatStream` contract. Callers opt in by switching to this entry
   * point (see `SingleAgent.streamResponse`).
   */
  async *chatStreamWithResume(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions = {},
    maxResumeAttempts: number = 3,
  ): AsyncGenerator<StreamChunk, void, void> {
    const workingMessages: ChatMessage[] = messages.map((m) => ({ ...m }));
    let resumeAttempt = 0;

    // Per-attempt state. Reset at the top of every loop iteration.
    let attemptChunks: StreamChunk[] = [];
    let attemptYielded = false;

    while (true) {
      attemptChunks = [];
      attemptYielded = false;
      try {
        for await (const chunk of this.chatStream(workingMessages, model, options)) {
          attemptChunks.push(chunk);
          attemptYielded = true;
          yield chunk;
        }
        return; // Natural completion.
      } catch (err: unknown) {
        // Pre-stream error — the inner chatStream never even started
        // (413, 404, 502 all-models-exhausted, etc.). Do not attempt a
        // resume; bubble up unchanged so the agent loop can react.
        if (!attemptYielded) {
          throw err;
        }

        // If the inner stream was already yielding a tool call, the
        // tool call is atomic and cannot be resumed.
        const last = attemptChunks[attemptChunks.length - 1];
        const cutDuringToolCall =
          !!last && (last.type === 'tool_call_start' || last.type === 'tool_call_delta');

        // Errors that are explicitly not candidates for a resume.
        if (!isMidStreamResumable(err) || cutDuringToolCall) {
          recordTelemetry(
            telemetry.streamResume({
              resumeAttempt,
              partialTokens: Math.ceil(reconstructPartialResponse(attemptChunks).length / 4),
              ok: false,
              reason: cutDuringToolCall ? 'tool-call-cut' : 'non-resumable',
            }),
          );
          throw new StreamResumeExhaustedError(
            cutDuringToolCall
              ? `Stream cut during a tool call after ${attemptChunks.length} chunks; cannot resume.`
              : err instanceof Error
                ? `Stream cut and error is non-resumable: ${err.message}`
                : 'Stream cut and error is non-resumable.',
            {
              resumeAttempt,
              chunks: attemptChunks,
              partial: reconstructPartialResponse(attemptChunks),
              cutDuringToolCall,
            },
          );
        }

        if (resumeAttempt >= maxResumeAttempts) {
          recordTelemetry(
            telemetry.streamResume({
              resumeAttempt,
              partialTokens: Math.ceil(reconstructPartialResponse(attemptChunks).length / 4),
              ok: false,
              reason: 'exhausted',
            }),
          );
          throw new StreamResumeExhaustedError(
            `Stream resume attempts exhausted (${resumeAttempt}/${maxResumeAttempts}).`,
            {
              resumeAttempt,
              chunks: attemptChunks,
              partial: reconstructPartialResponse(attemptChunks),
            },
          );
        }

        const partial = reconstructPartialResponse(attemptChunks);
        if (partial === '') {
          recordTelemetry(
            telemetry.streamResume({ resumeAttempt, partialTokens: 0, ok: false, reason: 'empty-partial' }),
          );
          throw new StreamResumeExhaustedError(
            'No partial content available to resume from.',
            { resumeAttempt, chunks: attemptChunks, partial: '' },
          );
        }

        // Build the resume payload: assistant partial + user "continue".
        workingMessages.push({ role: 'assistant', content: partial });
        workingMessages.push({
          role: 'user',
          content:
            `[STREAM RESUMED] Your previous response was interrupted at ` +
            `${attemptChunks.length} chunks. Continue exactly from where you left off. ` +
            'Do NOT repeat the partial content. Do NOT add preamble. ' +
            'Begin mid-sentence if needed.',
        });
        resumeAttempt += 1;
        // Telemetry: this attempt succeeded; the next one is in flight.
        recordTelemetry(
          telemetry.streamResume({
            resumeAttempt,
            partialTokens: Math.ceil(partial.length / 4),
            ok: true,
          }),
        );
        // Loop continues with the augmented message list.
      }
    }
  }

  async getEmbedding(text: string, model = 'text-embedding-3-small'): Promise<number[]> {
    const providerId = this.getProviderId(model);
    providerCooldown.assertAvailable(providerId);

    const direct = this.resolveDirectConfig(model);
    let requestUrl = `${this.baseUrl}/embeddings`;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    if (direct) {
      // Pillar 4: source the API key from the credential vault.
      const vault = getProviderKeyVault();
      requestUrl = `${direct.baseUrl}/embeddings`;
      headers = await vault.withApiKey(direct.providerName, (key) => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      }));
    }

    const body = JSON.stringify({
      model,
      input: text,
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers,
          body,
        });

        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          trackProviderError(providerId, response.status, `HTTP ${response.status}`);
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          if (attempt < MAX_RETRIES) {
            if (this.verbose) {
              console.log(
                `${colors.yellow}⚠  [API] Embedding error ${response.status}. Retrying in ${(delayMs / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})${colors.reset}`
              );
            }
            await sleep(delayMs);
            continue;
          }
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as { data: Array<{ embedding: number[] }> };
        if (data.data && data.data[0] && data.data[0].embedding) {
          providerCooldown.recordSuccess(providerId);
          return data.data[0].embedding;
        }
        throw new Error('Malformed embedding response structure');
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw error;
        const isNetworkError = error instanceof Error && (
          error.name === 'TimeoutError' ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('fetch failed') ||
          error.message.includes('ETIMEDOUT')
        );
        if (isNetworkError) {
          trackProviderError(providerId, 0, error.message.slice(0, 200));
        }
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }
    throw new Error('All embedding retry attempts exhausted.');
  }

  /* ─── Health probe ─── */

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(4000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/* ──────────────────────── Helpers ──────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ──────────────────────── Translation Helpers ──────────────────────── */

function translateOpenAIToAnthropic(
  messages: ChatMessage[],
  model: string,
  options: ChatOptions
): Record<string, any> {
  let system = '';
  const anthropicMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = system ? `${system}\n${msg.content}` : (msg.content || '');
    } else if (msg.role === 'user') {
      anthropicMessages.push({
        role: 'user',
        content: msg.content || '',
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks: any[] = [];
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let inputObj = {};
          try {
            inputObj = JSON.parse(tc.function.arguments);
          } catch {
            inputObj = { raw: tc.function.arguments };
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: inputObj,
          });
        }
        anthropicMessages.push({
          role: 'assistant',
          content: contentBlocks,
        });
      } else {
        anthropicMessages.push({
          role: 'assistant',
          content: msg.content || '',
        });
      }
    } else if (msg.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content || '',
          },
        ],
      });
    }
  }

  const body: Record<string, any> = {
    model,
    messages: anthropicMessages,
    max_tokens: options.max_tokens ?? 4096,
  };

  if (system) {
    body.system = system;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    if (options.tool_choice) {
      if (options.tool_choice === 'auto' || options.tool_choice === 'none') {
        body.tool_choice = { type: options.tool_choice };
      } else if (typeof options.tool_choice === 'object' && options.tool_choice.function) {
        body.tool_choice = {
          type: 'any',
          name: options.tool_choice.function.name,
        };
      }
    }
  }

  return body;
}

function translateAnthropicToOpenAI(anthropicRes: any): ChatCompletionResponse {
  const contentBlocks = Array.isArray(anthropicRes.content) ? anthropicRes.content : [];
  let text = '';
  const toolCalls: any[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const finishReasonMap: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop',
  };

  const choice: any = {
    index: 0,
    message: {
      role: 'assistant',
      content: text || null,
    },
    finish_reason: finishReasonMap[anthropicRes.stop_reason] || 'stop',
  };

  if (toolCalls.length > 0) {
    choice.message.tool_calls = toolCalls;
  }

  const usage = anthropicRes.usage ? {
    prompt_tokens: anthropicRes.usage.input_tokens || 0,
    completion_tokens: anthropicRes.usage.output_tokens || 0,
    total_tokens: (anthropicRes.usage.input_tokens || 0) + (anthropicRes.usage.output_tokens || 0),
  } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    id: anthropicRes.id || `anthropic-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicRes.model || '',
    choices: [choice],
    usage,
  };
}
