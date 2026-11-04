// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient, GeminiError, withRetry } from '../../src/providers/gemini/client';
import { createGeminiSession, retryLast, sendTurn } from '../../src/providers/gemini/session';
import type { Session } from '../../src/core/migration/session';
import { buildPlan } from '../../src/core/migration/plan';
import { conversationOf } from '../helpers';

const KEY = 'AIzaSENTINELKEY';
const noSleep = { sleep: () => Promise.resolve(), baseDelayMs: 1 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (...texts: string[]) =>
  new Response(
    texts
      .map(
        (t) =>
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\n\n`,
      )
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const apiError = (status: number, message: string, details: unknown[] = []) =>
  json({ error: { code: status, message, status: 'ERR', details } }, status);

function stubFetch(...responses: (() => Response)[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('GeminiClient', () => {
  it('lists generateContent models with their token limits', async () => {
    stubFetch(() =>
      json({
        models: [
          {
            name: 'models/gemini-x',
            displayName: 'Gemini X',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/embed',
            displayName: 'Embed',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    );
    const models = await new GeminiClient(KEY, noSleep).listModels();
    expect(models).toEqual([
      {
        name: 'gemini-x',
        displayName: 'Gemini X',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      },
    ]);
  });

  it('requests structured JSON and parses it', async () => {
    const fetchMock = stubFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }] }),
    );
    const out = await new GeminiClient(KEY, noSleep).structured('gemini-x').generateJson({
      system: 'sys',
      prompt: 'p',
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    });
    expect(out).toEqual({ summary: 'ok' });
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual({ type: 'object' });
  });

  it('maps an invalid key to an actionable error without retrying', async () => {
    const fetchMock = stubFetch(() =>
      apiError(400, 'API key not valid. Please pass a valid API key.'),
    );
    const err = await new GeminiClient(KEY, noSleep).listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err).toMatchObject({ code: 'INVALID_KEY' });
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const fetchMock = stubFetch(
      () => apiError(429, 'Resource exhausted'),
      () => apiError(503, 'Unavailable'),
      () => json({ models: [] }),
    );
    await expect(new GeminiClient(KEY, noSleep).listModels()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry limit with the last error', async () => {
    stubFetch(...Array.from({ length: 4 }, () => () => apiError(500, 'Internal')));
    await expect(
      new GeminiClient(KEY, { ...noSleep, retries: 3 }).listModels(),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('streams a chat reply', async () => {
    stubFetch(() => sse('Hel', 'lo'));
    const chunks: string[] = [];
    for await (const c of new GeminiClient(KEY, noSleep).streamChat({
      model: 'gemini-x',
      history: [],
      systemInstruction: 's',
      message: 'hi',
    }))
      chunks.push(c);
    expect(chunks.join('')).toBe('Hello');
  });
});

describe('streamChat request', () => {
  it('sends the system instruction even when a cancel signal is attached', async () => {
    const fetchMock = stubFetch(() => sse('ok'));
    const client = new GeminiClient(KEY, noSleep);
    for await (const _ of client.streamChat({
      model: 'gemini-x',
      history: [],
      systemInstruction: 'IMPORTED CONTEXT',
      message: 'hi',
      signal: new AbortController().signal,
    })) {
      // drain
    }
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as {
      systemInstruction?: { parts: { text: string }[] };
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe('IMPORTED CONTEXT');
  });
});

describe('withRetry', () => {
  it('honours the server retry delay', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (n++ === 0) throw new GeminiError('RATE_LIMITED', undefined, 7000);
        return 1;
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([7000]);
  });

  it('does not retry non-transient errors', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new GeminiError('INVALID_KEY');
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    expect(n).toBe(1);
  });
});

describe('sendTurn / retryLast', () => {
  const conv = conversationOf([
    ['user', 'q'],
    ['assistant', 'a'],
  ]);
  const plan = buildPlan({
    conversation: conv,
    transcriptId: 't',
    profile: null,
    profileId: null,
    contextDocument: '',
    mode: 'full',
    provider: 'gemini',
    model: 'gemini-x',
    modelInputLimit: null,
    budgetTokens: 100_000,
    outputReserve: 1000,
    preambleTokens: 100,
    recentMessages: 0,
    pinned: new Set(),
    summarizeSegments: false,
  });

  function memoryStore(initial: Session) {
    let current = initial;
    return {
      update: async (_id: string, fn: (s: Session) => Session) => (current = fn(current)),
      get: () => current,
    };
  }

  it('persists both turns and sends the imported history', async () => {
    const fetchMock = stubFetch(() => sse('fine'));
    const session = createGeminiSession({
      plan,
      planId: 'p',
      conversation: conv,
      contextDocument: '',
      segmentSummaries: [],
    });
    const store = memoryStore(session);
    const result = await sendTurn({
      sessionId: 's',
      session,
      text: 'next?',
      client: new GeminiClient(KEY, noSleep),
      store,
    });
    expect(result.turns.map((t) => [t.role, t.status, t.text])).toEqual([
      ['user', 'complete', 'next?'],
      ['model', 'complete', 'fine'],
    ]);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as { contents: { role: string }[] };
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('records a failure visibly and can retry it', async () => {
    stubFetch(
      () => apiError(400, 'API key not valid'),
      () => sse('recovered'),
    );
    const session = createGeminiSession({
      plan,
      planId: 'p',
      conversation: conv,
      contextDocument: '',
      segmentSummaries: [],
    });
    const store = memoryStore(session);
    const client = new GeminiClient(KEY, noSleep);
    await expect(
      sendTurn({ sessionId: 's', session, text: 'hi', client, store }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    expect(store.get().turns[1]).toMatchObject({ status: 'failed' });
    const after = await retryLast({ sessionId: 's', session: store.get(), client, store });
    expect(after.turns.map((t) => t.status)).toEqual(['complete', 'complete']);
    expect(after.turns[1]!.text).toBe('recovered');
  });
});
