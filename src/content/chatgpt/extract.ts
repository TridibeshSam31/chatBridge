import type { NormalizedConversation } from '../../core/conversation/schema';
import {
  ConversationParseError,
  parseConversationTree,
} from '../../core/import/chatgpt-export/parse';
import { CodedError } from '../../shared/errors';
import {
  type ExtractResult,
  PROTOCOL_VERSION,
  StoreTranscriptResponseSchema,
} from '../../shared/protocol';
import { getSettings } from '../../storage/settings';
import { ENDPOINT_OUTCOME_MESSAGES, fetchConversationTree } from './endpoint';
import { extractFromDom } from './extractor';
import { parseConversationId } from './url';

/**
 * Extraction entry points run in the ChatGPT tab. Results are handed to the
 * service worker for storage, so a transcript survives even if the side panel is
 * closed while extraction runs.
 */

export async function extractDomAndStore(scroll: boolean): Promise<ExtractResult> {
  return store(await extractFromDom(document, location.href, { scroll }));
}

export async function extractEndpointAndStore(): Promise<ExtractResult> {
  // Defence in depth: the panel hides the option, but the setting is checked here too.
  if (!(await getSettings()).endpointEnabled) {
    throw new CodedError('ENDPOINT_DISABLED', 'The unofficial endpoint is turned off in Settings.');
  }
  const conversationId = parseConversationId(location.href);
  if (conversationId === null)
    throw new CodedError('NO_CONVERSATION', 'Open a saved conversation first.');

  const result = await fetchConversationTree(location.origin, conversationId);
  if (result.outcome !== 'available') {
    throw new CodedError(
      'ENDPOINT_UNAVAILABLE',
      `${ENDPOINT_OUTCOME_MESSAGES[result.outcome]} Use page extraction or the export file instead.`,
    );
  }
  let conversation: NormalizedConversation;
  try {
    conversation = parseConversationTree(result.json, 'internal-api');
  } catch (err) {
    if (err instanceof ConversationParseError) {
      throw new CodedError(
        'PARSE_FAILED',
        `The endpoint response could not be read: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
  return store(conversation);
}

async function store(conversation: NormalizedConversation): Promise<ExtractResult> {
  const raw: unknown = await chrome.runtime.sendMessage({
    type: 'chatbridge/store-transcript',
    protocol: PROTOCOL_VERSION,
    conversation,
  });
  const response = StoreTranscriptResponseSchema.safeParse(raw);
  if (!response.success)
    throw new CodedError(
      'STORAGE_FAILED',
      'ChatBridge did not confirm that the transcript was saved.',
    );
  if (!response.data.ok) throw new CodedError('STORAGE_FAILED', response.data.error.message);
  return {
    transcriptId: response.data.data.transcriptId,
    messageCount: conversation.messages.length,
    completeness: conversation.extraction.completeness,
  };
}
