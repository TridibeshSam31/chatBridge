import {
  type DetectResponse,
  type ErrorResponse,
  PROTOCOL_VERSION,
  RequestSchema,
} from '../../shared/protocol';
import { detectConversation } from './adapter';
import { toErrorResponse } from '../../shared/errors';
import { extractDomAndStore, extractEndpointAndStore } from './extract';
import { probeDom } from './diagnostics/dom-probe';
import { probeEndpoint } from './diagnostics/endpoint-probe';
import { parseConversationId } from './url';

declare global {
  interface Window {
    __chatbridgeContentLoaded?: boolean;
  }
}

// The side panel may inject this script programmatically into tabs that were open
// before the extension was installed; don't register a second listener.
if (!window.__chatbridgeContentLoaded) {
  window.__chatbridgeContentLoaded = true;
  chrome.runtime.onMessage.addListener(handleMessage);
}

function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  // Only our own extension may talk to this script.
  if (sender.id !== chrome.runtime.id) return false;

  const parsed = RequestSchema.safeParse(message);
  if (!parsed.success) {
    const isOurs =
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      typeof message.type === 'string' &&
      message.type.startsWith('chatbridge/');
    if (!isOurs) return false;
    const response: ErrorResponse = {
      ok: false,
      error:
        'protocol' in message && message.protocol !== PROTOCOL_VERSION
          ? {
              code: 'UNSUPPORTED_PROTOCOL',
              message: 'This ChatGPT tab is running an older ChatBridge script. Reload the tab.',
            }
          : { code: 'INVALID_REQUEST', message: parsed.error.message },
    };
    sendResponse(response);
    return false;
  }

  switch (parsed.data.type) {
    case 'chatbridge/ping':
      sendResponse({ ok: true, data: { provider: 'chatgpt' } });
      return false;
    case 'chatbridge/detect': {
      let response: DetectResponse;
      try {
        response = { ok: true, data: detectConversation(document, location.href) };
      } catch (err) {
        console.error('[ChatBridge] detection failed', err);
        response = {
          ok: false,
          error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
        };
      }
      sendResponse(response);
      return false;
    }
    case 'chatbridge/diagnose-dom': {
      const { scrollTest } = parsed.data;
      respondAsync(sendResponse, 'DOM diagnostics', () =>
        probeDom(document, location.href, { scrollTest }),
      );
      return true;
    }
    case 'chatbridge/diagnose-endpoint': {
      const conversationId = parseConversationId(location.href);
      if (conversationId === null) {
        const response: ErrorResponse = {
          ok: false,
          error: { code: 'NO_CONVERSATION', message: 'Open a saved conversation first.' },
        };
        sendResponse(response);
        return false;
      }
      respondAsync(sendResponse, 'endpoint diagnostics', () =>
        probeEndpoint(location.origin, conversationId),
      );
      return true;
    }
    case 'chatbridge/extract-dom': {
      const { scroll } = parsed.data;
      respondAsync(sendResponse, 'page extraction', () => extractDomAndStore(scroll));
      return true;
    }
    case 'chatbridge/extract-endpoint':
      respondAsync(sendResponse, 'endpoint extraction', extractEndpointAndStore);
      return true;
  }
}

/** Runs async work and always answers, so the panel never waits on a dead channel. */
function respondAsync(
  sendResponse: (response: unknown) => void,
  label: string,
  work: () => Promise<object>,
): void {
  work().then(
    (data) => sendResponse({ ok: true, data }),
    (err: unknown) => {
      console.error(`[ChatBridge] ${label} failed`, err);
      sendResponse(toErrorResponse(err));
    },
  );
}
