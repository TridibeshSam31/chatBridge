import type { z } from 'zod';
import {
  type DetectedConversation,
  DetectResponseSchema,
  type ErrorCodeSchema,
  PROTOCOL_VERSION,
  type Request,
} from '../shared/protocol';
import { isChatGptUrl } from '../content/chatgpt/url';

export const CONTENT_SCRIPT_FILE = 'content/chatgpt.js';

export type BridgeErrorCode =
  'CONTENT_SCRIPT_UNAVAILABLE' | 'INVALID_RESPONSE' | z.infer<typeof ErrorCodeSchema>;

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BridgeError';
  }
}

export type ActiveTabState =
  | { kind: 'no-tab' }
  | { kind: 'not-chatgpt' }
  | { kind: 'detected'; tabId: number; conversation: DetectedConversation };

/**
 * Resolves what the side panel should show for the focused tab. Tab URLs are only
 * visible for hosts we have permission for, so an undefined URL means "not ChatGPT".
 */
export async function inspectActiveTab(): Promise<ActiveTabState> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return { kind: 'no-tab' };
  if (!isChatGptUrl(tab.url)) return { kind: 'not-chatgpt' };
  return { kind: 'detected', tabId: tab.id, conversation: await detectInTab(tab.id) };
}

export function detectInTab(tabId: number): Promise<DetectedConversation> {
  return requestTab(
    tabId,
    { type: 'chatbridge/detect', protocol: PROTOCOL_VERSION },
    DetectResponseSchema,
  );
}

type Envelope<T> =
  { ok: true; data: T } | { ok: false; error: { code: BridgeErrorCode; message: string } };

/** Sends a request to the tab's content script and validates the response envelope. */
export async function requestTab<T>(
  tabId: number,
  request: Request,
  schema: z.ZodType<Envelope<T>>,
): Promise<T> {
  const raw = await sendWithInjection(tabId, request);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BridgeError('INVALID_RESPONSE', 'The ChatGPT tab sent an unexpected response.', {
      cause: parsed.error,
    });
  }
  if (!parsed.data.ok) throw new BridgeError(parsed.data.error.code, parsed.data.error.message);
  return parsed.data.data;
}

/**
 * Tabs opened before install (or before an extension reload) have no live content
 * script. In that case inject it once and retry; any other failure is surfaced.
 */
async function sendWithInjection(tabId: number, request: Request): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (err) {
    if (!isNoReceiverError(err)) throw err;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  } catch (err) {
    throw new BridgeError(
      'CONTENT_SCRIPT_UNAVAILABLE',
      'ChatBridge could not connect to this ChatGPT tab. Reload the tab and try again.',
      { cause: err },
    );
  }
  return chrome.tabs.sendMessage(tabId, request);
}

function isNoReceiverError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Receiving end does not exist');
}
