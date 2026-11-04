/**
 * Every ChatGPT DOM selector lives here so a ChatGPT UI change is a one-file fix.
 *
 * Prefer data-* attributes: ChatGPT's class names are utility classes that change
 * often. Strategies are tried in order; the first one that matches anything wins
 * and its name is reported, so breakage shows up as "no strategy matched" rather
 * than as a silently empty result.
 *
 * Verified against public knowledge of the DOM as of late 2026. Re-verify against
 * a live session before Phase 2 extraction work.
 */

export interface MessageSelectorStrategy {
  name: string;
  /** Selects one element per message. */
  message: string;
  /** Reads the author role from a matched message element. */
  role: (el: Element) => string | null;
  /** Reads a stable message id, if the DOM exposes one. */
  id: (el: Element) => string | null;
}

export const MESSAGE_STRATEGIES: readonly MessageSelectorStrategy[] = [
  {
    name: 'data-message-author-role',
    message: '[data-message-author-role]',
    role: (el) => el.getAttribute('data-message-author-role'),
    id: (el) => el.getAttribute('data-message-id'),
  },
  {
    // Fallback: turn containers, with the role taken from a nested attribute if present.
    name: 'conversation-turn-article',
    message: 'article[data-testid^="conversation-turn-"]',
    role: (el) =>
      el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ??
      el.getAttribute('data-turn') ??
      null,
    id: (el) => el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null,
  },
];

/** Sidebar link for a conversation; its text is the conversation title. */
export const sidebarLinkFor = (conversationId: string): string =>
  `nav a[href$="/c/${conversationId}"]`;

/** document.title values that mean "no real conversation title". */
export const GENERIC_TITLES = new Set(['chatgpt', 'new chat']);

/** Rendered markdown of an assistant message. */
export const ASSISTANT_MARKDOWN = '.markdown';
/** Plain-text body of a user message. */
export const USER_TEXT = '.whitespace-pre-wrap';
/** Present while a response is still streaming. */
export const STOP_GENERATING = '[data-testid="stop-button"]';
/** Branch pager text, e.g. "2/3", rendered as a leaf element inside a turn. */
export const PAGER_TEXT = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;
/** Short language labels in code-block headers. */
export const LANGUAGE_LABEL = /^[A-Za-z][A-Za-z0-9+#. -]{0,19}$/;
/** Extracts the turn number from a turn container's data-testid. */
export const TURN_NUMBER = /conversation-turn-(\d+)$/;
