import type { DetectedConversation } from '../../shared/protocol';
import { GENERIC_TITLES, MESSAGE_STRATEGIES, sidebarLinkFor } from './selectors';
import { parseConversationId } from './url';

/** Pure detection over a document, so it can be tested against saved HTML. */
export function detectConversation(doc: Document, url: string): DetectedConversation {
  const conversationId = parseConversationId(url);
  const counts = { user: 0, assistant: 0, other: 0 };
  let selectorStrategy: string | null = null;

  for (const strategy of MESSAGE_STRATEGIES) {
    const elements = Array.from(doc.querySelectorAll(strategy.message));
    if (elements.length === 0) continue;

    selectorStrategy = strategy.name;
    // The same message can appear in nested nodes during streaming; dedupe by id.
    const seen = new Set<string>();
    for (const el of elements) {
      const id = strategy.id(el);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const role = strategy.role(el);
      if (role === 'user') counts.user++;
      else if (role === 'assistant') counts.assistant++;
      else counts.other++;
    }
    break;
  }

  return {
    provider: 'chatgpt',
    url,
    conversationId,
    title: conversationId ? readTitle(doc, conversationId) : null,
    renderedMessageCount: counts.user + counts.assistant + counts.other,
    renderedRoleCounts: counts,
    selectorStrategy,
  };
}

export function readTitle(doc: Document, conversationId: string): string | null {
  const fromSidebar = doc.querySelector(sidebarLinkFor(conversationId))?.textContent?.trim();
  if (fromSidebar) return fromSidebar;

  const fromDocument = doc.title.trim();
  if (fromDocument && !GENERIC_TITLES.has(fromDocument.toLowerCase())) return fromDocument;
  return null;
}
