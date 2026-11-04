/**
 * Every ChatGPT DOM selector lives here so a ChatGPT UI change is a one-file fix.
 *
 * Prefer data-* attributes: ChatGPT's class names are utility classes that change
 * often. Strategies are tried in order; the first one that matches anything wins
 * and its name is reported, so breakage shows up as "no strategy matched" rather
 * than as a silently empty result.
 *
 * The first strategy matches the layout seen on a real account in Nov 2026 (from
 * a structure-only Diagnostics report); the others cover older layouts. Run
 * Diagnostics → Page structure to see which one matches.
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

const UNIT_ROLE = /:(user|assistant|system|tool)$/;

const messageIdOf = (el: Element): string | null =>
  el.getAttribute('data-chatgpt-search-message-ids') ??
  el
    .querySelector('[data-chatgpt-search-message-ids]')
    ?.getAttribute('data-chatgpt-search-message-ids') ??
  el
    .querySelector('[data-chatgpt-selection-message-id]')
    ?.getAttribute('data-chatgpt-selection-message-id') ??
  null;

export const MESSAGE_STRATEGIES: readonly MessageSelectorStrategy[] = [
  {
    // Layout seen on a real account (Nov 2026): one search unit per message, keyed
    // "<turn>:<n>:<role>", holding the message content and its ids. Not
    // [data-conversation-role]: there it marks the hidden "You said:" label.
    name: 'search-unit',
    message: '[data-chatgpt-search-unit-key]',
    role: (el) =>
      UNIT_ROLE.exec(el.getAttribute('data-chatgpt-search-unit-key') ?? '')?.[1] ??
      el.closest('[data-conversation-role]')?.getAttribute('data-conversation-role') ??
      null,
    id: (el) => messageIdOf(el) ?? el.getAttribute('data-chatgpt-search-unit-key'),
  },
  {
    name: 'data-message-author-role',
    message: '[data-message-author-role]',
    role: (el) => el.getAttribute('data-message-author-role'),
    id: (el) => el.getAttribute('data-message-id'),
  },
  {
    // Turn containers of any tag (an <article> in older layouts, a <section> in newer
    // ones), with the role taken from the container or a nested attribute.
    name: 'conversation-turn',
    message: '[data-testid^="conversation-turn-"]',
    role: (el) =>
      el.getAttribute('data-turn') ??
      el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ??
      null,
    id: (el) => el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null,
  },
  {
    name: 'data-turn',
    message: '[data-turn="user"], [data-turn="assistant"]',
    role: (el) => el.getAttribute('data-turn'),
    id: (el) =>
      el.getAttribute('data-message-id') ??
      el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ??
      null,
  },
  {
    // Last resort: message ids alone; the role comes from the nearest turn marker.
    name: 'data-message-id',
    message: '[data-message-id]',
    role: (el) =>
      el.closest('[data-turn]')?.getAttribute('data-turn') ??
      el.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') ??
      null,
    id: (el) => el.getAttribute('data-message-id'),
  },
];

/** Sidebar link for a conversation; its text is the conversation title. */
export const sidebarLinkFor = (conversationId: string): string =>
  `nav a[href$="/c/${conversationId}"]`;

/** document.title values that mean "no real conversation title". */
export const GENERIC_TITLES = new Set(['chatgpt', 'new chat']);

/** Rendered markdown of an assistant message (newer layout first). */
export const ASSISTANT_MARKDOWN = '[data-markdown-text-style="assistant-message"], .markdown';
/** Plain-text body of a user message (newer layout first). */
export const USER_TEXT = '[data-user-message-bubble], .whitespace-pre-wrap';
/** Page chrome inside a message that is not its content: buttons, hidden screen-reader labels. */
export const COPY_EXCLUDED = '[data-markdown-copy="exclude"], .sr-only';
/** A code block container, and the element holding its source in the newer layout. */
export const CODE_BLOCK = '[data-code-block="true"]';
export const CODE_SOURCE = '[data-code-block-source]';
/** Present while a response is still streaming. */
export const STOP_GENERATING = '[data-testid="stop-button"]';
/** Branch pager text, e.g. "2/3", rendered as a leaf element inside a turn. */
export const PAGER_TEXT = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;
/** Short language labels in code-block headers. */
export const LANGUAGE_LABEL = /^[A-Za-z][A-Za-z0-9+#. -]{0,19}$/;
/** The container of one turn, used for turn numbers and branch pagers. */
export const TURN_CONTAINER = '[data-turn-key], [data-testid^="conversation-turn-"], article';
/** Extracts the turn number from a turn container's data-testid. */
export const TURN_NUMBER = /conversation-turn-(\d+)$/;
