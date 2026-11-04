import { ApiError, type Content, GoogleGenAI } from '@google/genai';
import type { StructuredLlm } from '../../core/context/llm';

/**
 * Thin wrapper over the official Google Gen AI SDK: model discovery, token
 * counting, structured JSON output and streaming chat, with errors mapped to
 * actionable codes and transient failures retried with backoff.
 *
 * The API key is the user's own and stays in this extension. Never log it.
 */

export type GeminiErrorCode =
  | 'INVALID_KEY'
  | 'PERMISSION'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'CONTEXT_TOO_LARGE'
  | 'BAD_REQUEST'
  | 'BLOCKED'
  | 'NETWORK'
  | 'ABORTED'
  | 'INVALID_RESPONSE';

const MESSAGES: Record<GeminiErrorCode, string> = {
  INVALID_KEY: 'Gemini rejected the API key. Check it in Settings.',
  PERMISSION: 'This API key is not allowed to use that model or API.',
  RATE_LIMITED: 'Gemini is rate-limiting requests. Wait a moment and try again.',
  UNAVAILABLE: 'Gemini is temporarily unavailable. Try again shortly.',
  CONTEXT_TOO_LARGE:
    'The request is larger than the model accepts. Lower the budget or use Smart/Hybrid mode.',
  BAD_REQUEST: 'Gemini rejected the request.',
  BLOCKED: 'Gemini returned no content (it may have been blocked by safety filters).',
  NETWORK: 'Could not reach Gemini. Check your connection.',
  ABORTED: 'The request was cancelled.',
  INVALID_RESPONSE: 'Gemini returned a response ChatBridge could not read.',
};

export class GeminiError extends Error {
  override name = 'GeminiError';
  constructor(
    readonly code: GeminiErrorCode,
    detail?: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code], options);
  }
  get retryable(): boolean {
    return this.code === 'RATE_LIMITED' || this.code === 'UNAVAILABLE' || this.code === 'NETWORK';
  }
}

export function toGeminiError(err: unknown): GeminiError {
  if (err instanceof GeminiError) return err;
  if (err instanceof Error && err.name === 'AbortError')
    return new GeminiError('ABORTED', undefined, undefined, { cause: err });
  if (err instanceof ApiError) {
    const msg = err.message ?? '';
    const retry = /retry(?:Delay)?["\s:]*"?(\d+(?:\.\d+)?)s/i.exec(msg);
    const retryAfterMs = retry ? Math.ceil(Number(retry[1]) * 1000) : undefined;
    if (err.status === 400 && /api key not valid|API_KEY_INVALID/i.test(msg))
      return new GeminiError('INVALID_KEY', undefined, undefined, { cause: err });
    if (err.status === 400 && /token|too large|exceeds/i.test(msg))
      return new GeminiError('CONTEXT_TOO_LARGE', undefined, undefined, { cause: err });
    if (err.status === 400)
      return new GeminiError('BAD_REQUEST', firstLine(msg), undefined, { cause: err });
    if (err.status === 401 || err.status === 403)
      return new GeminiError(
        /api key/i.test(msg) ? 'INVALID_KEY' : 'PERMISSION',
        undefined,
        undefined,
        { cause: err },
      );
    if (err.status === 404)
      return new GeminiError('BAD_REQUEST', 'model not found', undefined, { cause: err });
    if (err.status === 429)
      return new GeminiError('RATE_LIMITED', undefined, retryAfterMs, { cause: err });
    if (err.status >= 500)
      return new GeminiError('UNAVAILABLE', `HTTP ${err.status}`, retryAfterMs, { cause: err });
    return new GeminiError('BAD_REQUEST', `HTTP ${err.status}`, undefined, { cause: err });
  }
  if (err instanceof TypeError)
    return new GeminiError('NETWORK', undefined, undefined, { cause: err });
  return new GeminiError(
    'INVALID_RESPONSE',
    err instanceof Error ? err.message : String(err),
    undefined,
    { cause: err },
  );
}

function firstLine(text: string): string {
  // SDK messages can embed the JSON body; keep it short and never echo request content.
  return text.split('\n')[0]!.slice(0, 200);
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: GeminiError, attempt: number, delayMs: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new GeminiError('ABORTED'));
      },
      { once: true },
    );
  });

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      options.signal?.throwIfAborted();
      return await fn();
    } catch (raw) {
      const err = toGeminiError(raw);
      if (!err.retryable || attempt >= retries) throw err;
      const jitter = Math.random() * base;
      const delay = Math.min(60_000, err.retryAfterMs ?? base * 2 ** attempt + jitter);
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, options.signal);
    }
  }
}

export interface ModelInfo {
  name: string;
  displayName: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export class GeminiClient {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly retry: Omit<RetryOptions, 'signal'> = {},
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Models that support generateContent, with their context limits. */
  async listModels(): Promise<ModelInfo[]> {
    return withRetry(async () => {
      const pager = await this.ai.models.list({ config: { pageSize: 100 } });
      const out: ModelInfo[] = [];
      for await (const model of pager) {
        if (!model.name || !(model.supportedActions ?? []).includes('generateContent')) continue;
        out.push({
          name: model.name.replace(/^models\//, ''),
          displayName: model.displayName ?? model.name,
          inputTokenLimit: model.inputTokenLimit ?? null,
          outputTokenLimit: model.outputTokenLimit ?? null,
        });
      }
      return out;
    }, this.retry);
  }

  /** Exact token count. Sends the content to Gemini, so call it only with consent. */
  async countTokens(model: string, contents: Content[], signal?: AbortSignal): Promise<number> {
    return withRetry(
      async () => {
        const res = await this.ai.models.countTokens({
          model,
          contents,
          ...(signal ? { config: { abortSignal: signal } } : {}),
        });
        if (typeof res.totalTokens !== 'number')
          throw new GeminiError('INVALID_RESPONSE', 'no token count');
        return res.totalTokens;
      },
      { ...this.retry, ...(signal ? { signal } : {}) },
    );
  }

  structured(model: string): StructuredLlm {
    return {
      model,
      generateJson: ({ system, prompt, schema, signal }) =>
        withRetry(
          async () => {
            const res = await this.ai.models.generateContent({
              model,
              contents: prompt,
              config: {
                systemInstruction: system,
                responseMimeType: 'application/json',
                responseJsonSchema: stripMeta(schema),
                temperature: 0.1,
                ...(signal ? { abortSignal: signal } : {}),
              },
            });
            const text = res.text;
            if (!text)
              throw new GeminiError(
                'BLOCKED',
                res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason,
              );
            try {
              return JSON.parse(text) as unknown;
            } catch (err) {
              throw new GeminiError('INVALID_RESPONSE', 'output was not valid JSON', undefined, {
                cause: err,
              });
            }
          },
          { ...this.retry, ...(signal ? { signal } : {}) },
        ),
    };
  }

  /**
   * Streams a reply to `message` given the full history. Retries only before the
   * first chunk arrives; a stream that fails midway is reported, not replayed.
   */
  async *streamChat(params: {
    model: string;
    history: Content[];
    systemInstruction: string;
    message: string;
    signal?: AbortSignal;
  }): AsyncGenerator<string> {
    const { signal } = params;
    // The SDK *replaces* the chat config with a per-message config rather than
    // merging them, so the system instruction must travel with every message.
    const config = {
      systemInstruction: params.systemInstruction,
      ...(signal ? { abortSignal: signal } : {}),
    };
    const chat = this.ai.chats.create({ model: params.model, history: params.history, config });
    const stream = await withRetry(
      () => chat.sendMessageStream({ message: params.message, config }),
      {
        ...this.retry,
        ...(signal ? { signal } : {}),
      },
    );
    let produced = false;
    try {
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          produced = true;
          yield text;
        }
      }
    } catch (err) {
      throw toGeminiError(err);
    }
    if (!produced) throw new GeminiError('BLOCKED');
  }
}

/** Gemini's JSON-schema support does not accept the meta keyword `$schema`. */
function stripMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}
