import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { probeEndpoint } from '../../src/content/chatgpt/diagnostics/endpoint-probe';

const TOKEN = 'eyJSENTINEL_ACCESS_TOKEN';
const ID = '11111111-1111-4111-8111-111111111111';
const conversation = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../fixtures/chatgpt-export/conversations.json'),
      'utf8',
    ),
  ) as unknown[]
)[0];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function fakeFetch(
  conversationResponse: () => Response,
  session: unknown = { accessToken: TOKEN },
) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(json(session));
    if (url.includes('/backend-api/conversation/')) return Promise.resolve(conversationResponse());
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

describe('probeEndpoint', () => {
  it('reports structure when the endpoint is available, without leaking the token or content', async () => {
    const fetchImpl = fakeFetch(() => json(conversation));
    const report = await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);

    expect(report.outcome).toBe('available');
    expect(report.session).toEqual({ status: 200, hasAccessToken: true });
    expect(report.structure?.currentPathMessages).toBe(11);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toMatch(/SENTINEL/);
  });

  it('only contacts the two same-origin endpoints and uses the existing session', async () => {
    const fetchImpl = fakeFetch(() => json(conversation));
    await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [[sessionUrl], [conversationUrl, init]] = fetchImpl.mock.calls as unknown as [
      [URL],
      [URL, RequestInit],
    ];
    expect(String(sessionUrl)).toBe('https://chatgpt.com/api/auth/session');
    expect(String(conversationUrl)).toBe(`https://chatgpt.com/backend-api/conversation/${ID}`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it.each([
    [401, 'denied'],
    [403, 'denied'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [500, 'unexpected-response'],
  ] as const)('maps HTTP %i to %s and does not retry', async (status, outcome) => {
    const fetchImpl = fakeFetch(() => json({ detail: 'SENTINEL_DETAIL' }, status));
    const report = await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);
    expect(report.outcome).toBe(outcome);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL/);
  });

  it('stops before the endpoint when there is no signed-in session', async () => {
    const fetchImpl = fakeFetch(() => json(conversation), {});
    const report = await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);
    expect(report.outcome).toBe('no-session');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats an HTML challenge page as unexpected, not as data', async () => {
    const fetchImpl = fakeFetch(
      () => new Response('<html>SENTINEL</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const report = await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);
    expect(report.outcome).toBe('unexpected-response');
    expect(report.conversation.contentType).toBe('text/html');
  });

  it('reports network failures by class name only', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch SENTINEL')));
    const report = await probeEndpoint('https://chatgpt.com', ID, fetchImpl as typeof fetch);
    expect(report.outcome).toBe('network-error');
    expect(report.errorName).toBe('TypeError');
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL/);
  });
});
