import { isRecord } from '../../shared/redact';

/**
 * Fetches a conversation tree from ChatGPT's *unofficial* conversation endpoint,
 * the same way the ChatGPT web app does, using the session the browser already
 * has. Never adds extra or forged headers, never retries a denial, and keeps the
 * access token inside this function — it is never returned, stored or logged.
 */

export type EndpointOutcome =
  | 'available'
  | 'no-session'
  | 'session-error'
  | 'denied'
  | 'not-found'
  | 'rate-limited'
  | 'unexpected-response'
  | 'network-error';

export interface EndpointFetchResult {
  outcome: EndpointOutcome;
  session: { status: number | null; hasAccessToken: boolean };
  conversation: { status: number | null; contentType: string | null; bytes: number | null };
  /** Error class name only; messages may echo response bodies. */
  errorName: string | null;
  json?: unknown;
}

export const ENDPOINT_OUTCOME_MESSAGES: Record<Exclude<EndpointOutcome, 'available'>, string> = {
  'no-session': 'You are not signed in to ChatGPT in this tab.',
  'session-error': 'ChatGPT did not return a session for this tab.',
  denied: 'ChatGPT refused the request. The unofficial endpoint is not available to ChatBridge.',
  'not-found': 'ChatGPT could not find this conversation.',
  'rate-limited': 'ChatGPT is rate-limiting requests. Try again later.',
  'unexpected-response':
    'ChatGPT returned something other than a conversation. The endpoint may have changed.',
  'network-error': 'The request to ChatGPT failed (network error).',
};

export async function fetchConversationTree(
  origin: string,
  conversationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointFetchResult> {
  const result: EndpointFetchResult = {
    outcome: 'network-error',
    session: { status: null, hasAccessToken: false },
    conversation: { status: null, contentType: null, bytes: null },
    errorName: null,
  };

  let accessToken: string;
  try {
    const res = await fetchImpl(new URL('/api/auth/session', origin), { credentials: 'include' });
    result.session.status = res.status;
    if (!res.ok) {
      result.outcome = 'session-error';
      return result;
    }
    const body: unknown = await res.json();
    if (!isRecord(body) || typeof body.accessToken !== 'string' || body.accessToken === '') {
      result.outcome = 'no-session';
      return result;
    }
    result.session.hasAccessToken = true;
    accessToken = body.accessToken;
  } catch (err) {
    result.errorName = err instanceof Error ? err.name : typeof err;
    result.outcome = result.session.status === null ? 'network-error' : 'unexpected-response';
    return result;
  }

  try {
    const res = await fetchImpl(
      new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, origin),
      { credentials: 'include', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    result.conversation.status = res.status;
    result.conversation.contentType = res.headers.get('content-type')?.split(';')[0] ?? null;

    if (res.status === 401 || res.status === 403) result.outcome = 'denied';
    else if (res.status === 404) result.outcome = 'not-found';
    else if (res.status === 429) result.outcome = 'rate-limited';
    else if (!res.ok || result.conversation.contentType !== 'application/json') {
      result.outcome = 'unexpected-response';
    } else {
      const text = await res.text();
      result.conversation.bytes = text.length;
      const json: unknown = JSON.parse(text);
      if (isRecord(json) && isRecord(json.mapping)) {
        result.json = json;
        result.outcome = 'available';
      } else {
        result.outcome = 'unexpected-response';
      }
    }
  } catch (err) {
    result.errorName = err instanceof Error ? err.name : typeof err;
    result.outcome = result.conversation.status === null ? 'network-error' : 'unexpected-response';
  }
  return result;
}
