// MV3 service worker. It can be terminated at any time, so it holds no state in
// memory: it persists what it receives immediately and long-running work lives in
// the side panel with IndexedDB checkpoints.

import { ConversationSchema } from '../core/conversation/schema';
import { toErrorResponse } from '../shared/errors';
import { StoreTranscriptRequestSchema } from '../shared/protocol';
import { saveTranscript } from '../storage/db';

// Clicking the toolbar icon opens the side panel. The behaviour is persisted by
// Chrome, but setting it on every startup also repairs it after profile issues.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
  console.error('[ChatBridge] could not enable side panel on action click', err);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const request = StoreTranscriptRequestSchema.safeParse(message);
  if (!request.success) return false;

  // Only our content script, running in a ChatGPT tab, may store transcripts.
  if (!sender.tab?.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab.url)) {
    sendResponse({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'Transcripts can only come from a ChatGPT tab.' },
    });
    return false;
  }
  const conversation = ConversationSchema.safeParse(request.data.conversation);
  if (!conversation.success) {
    sendResponse({
      ok: false,
      error: { code: 'PARSE_FAILED', message: 'The extracted transcript failed validation.' },
    });
    return false;
  }
  saveTranscript(conversation.data).then(
    (record) => sendResponse({ ok: true, data: { transcriptId: record.id } }),
    (err: unknown) => {
      console.error('[ChatBridge] saving transcript failed', err);
      sendResponse({
        ...toErrorResponse(err),
        error: { code: 'STORAGE_FAILED', message: 'The transcript could not be saved locally.' },
      });
    },
  );
  return true;
});
