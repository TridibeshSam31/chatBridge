import {
  type ContentBlock,
  ConversationSchema,
  type ExtractionWarning,
  type NormalizedConversation,
  type NormalizedMessage,
  type Role,
  messageText,
} from '../../core/conversation/schema';
import { hashString } from '../../shared/hash';
import { readTitle } from './adapter';
import { findScrollContainer, settleDom } from './diagnostics/dom-probe';
import { elementToBlocks } from './dom-to-blocks';
import {
  ASSISTANT_MARKDOWN,
  MESSAGE_STRATEGIES,
  PAGER_TEXT,
  STOP_GENERATING,
  TURN_CONTAINER,
  TURN_NUMBER,
  USER_TEXT,
} from './selectors';
import { parseConversationId } from './url';

export class DomExtractionError extends Error {
  override name = 'DomExtractionError';
  constructor(
    readonly code: 'NO_CONVERSATION' | 'NO_MESSAGES',
    message: string,
  ) {
    super(message);
  }
}

interface Collected {
  key: string;
  hasId: boolean;
  turn: number | null;
  seq: number;
  role: Role;
  content: ContentBlock[];
  pager: { index: number; count: number } | null;
}

export interface DomExtractOptions {
  /** Scroll top → bottom collecting messages, for lazily rendered conversations. */
  scroll: boolean;
  settle?: (container: Element) => Promise<void>;
}

/**
 * Extracts the conversation as rendered in the page. The DOM cannot prove that
 * every message was loaded, so completeness is reported as "unknown" at best.
 */
export async function extractFromDom(
  doc: Document,
  url: string,
  options: DomExtractOptions,
): Promise<NormalizedConversation> {
  const conversationId = parseConversationId(url);
  if (conversationId === null) {
    throw new DomExtractionError('NO_CONVERSATION', 'Open a saved ChatGPT conversation first.');
  }
  const root = doc.querySelector('main') ?? doc.body;
  const strategy = MESSAGE_STRATEGIES.find((s) =>
    Array.from(root.querySelectorAll(s.message)).some((el) => !el.closest('nav, aside')),
  );
  if (!strategy) {
    throw new DomExtractionError(
      'NO_MESSAGES',
      'No messages were found on the page. Wait for the chat to load, or use the export file — ChatGPT’s layout may have changed.',
    );
  }

  const collected = new Map<string, Collected>();
  let seq = 0;
  const collect = () => {
    const elements = Array.from(root.querySelectorAll(strategy.message)).filter(
      (el) => !el.closest('nav, aside'),
    );
    elements.forEach((el, index) => {
      const id = strategy.id(el);
      const turnEl = el.closest(TURN_CONTAINER);
      const turnMatch = TURN_NUMBER.exec(turnEl?.getAttribute('data-testid') ?? '');
      const turn = turnMatch ? Number(turnMatch[1]) : null;
      // Without ids, fall back to turn number (stable across scrolling) or DOM position.
      const key = id ?? (turn !== null ? `turn-${turn}-${index}` : `pos-${index}`);
      if (collected.has(key)) return;
      collected.set(key, {
        key,
        hasId: id !== null,
        turn,
        seq: seq++,
        role: mapRole(strategy.role(el)),
        content: messageBlocks(el, strategy.role(el)),
        pager: readPager(turnEl ?? el),
      });
    });
  };

  const warnings: ExtractionWarning[] = [];
  const reasons = ['Read from the rendered page, which cannot prove every message was loaded.'];
  collect();

  let scrolled = false;
  if (options.scroll) {
    const first = root.querySelector(strategy.message);
    const container = first ? findScrollContainer(first) : null;
    if (container) {
      scrolled = true;
      await scrollCollect(container, options.settle ?? settleDom, collect);
    } else {
      warnings.push({
        code: 'NO_SCROLL_CONTAINER',
        message: 'Could not find the scrolling area; extracted what is currently rendered.',
      });
    }
  }
  if (!scrolled) {
    reasons.push(
      'The conversation was not scrolled through; long chats may not be fully rendered.',
    );
  }

  const items = [...collected.values()];
  const allTurns = items.every((i) => i.turn !== null);
  items.sort((a, b) => (allTurns ? a.turn! - b.turn! || a.seq - b.seq : a.seq - b.seq));

  if (items.some((i) => !i.hasId)) {
    warnings.push({
      code: 'DOM_NO_IDS',
      message: 'Some messages have no stable id; duplicates cannot be ruled out.',
    });
  }
  const branched = items.filter((i) => i.pager && i.pager.count > 1);
  if (branched.length > 0) {
    reasons.push(
      'Some messages have alternative versions (edits or regenerations); only the displayed version was read.',
    );
    warnings.push({
      code: 'BRANCHES_PRESENT',
      message: `${branched.length} message(s) have alternative versions not visible on the page. The export file includes all of them.`,
      messageIds: branched.map((i) => i.key),
    });
  }
  if (doc.querySelector(STOP_GENERATING)) {
    warnings.push({
      code: 'STILL_GENERATING',
      message: 'A response was still being generated; the last message may be incomplete.',
    });
  }

  const messages: NormalizedMessage[] = items.map((item) => {
    const message: NormalizedMessage = {
      id: item.key,
      role: item.role,
      content: item.content,
      visibility: 'visible',
      provenance: item.pager
        ? { siblingCount: item.pager.count, branchIndex: item.pager.index }
        : {},
      contentHash: '',
      metadata: item.turn !== null ? { domTurn: item.turn } : {},
    };
    message.contentHash = hashString(`${message.role}\n${messageText(message)}`);
    return message;
  });
  const empty = messages.filter((m) => messageText(m).trim() === '');
  if (empty.length > 0) {
    warnings.push({
      code: 'EMPTY_MESSAGES',
      message: `${empty.length} message(s) had no readable content.`,
      messageIds: empty.map((m) => m.id),
    });
  }

  return ConversationSchema.parse({
    schemaVersion: 1,
    conversationId,
    title: readTitle(doc, conversationId),
    sourceProvider: 'chatgpt',
    messages,
    attachments: [],
    userContext: [],
    extraction: {
      method: 'dom',
      completeness: 'unknown',
      completenessReasons: reasons,
      extractedAt: new Date().toISOString(),
      warnings,
      excluded: [],
      offPathMessages: 0,
    },
    metadata: { selectorStrategy: strategy.name, scrolled },
  } satisfies NormalizedConversation);
}

function mapRole(role: string | null): Role {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
    ? role
    : 'tool';
}

function messageBlocks(el: Element, role: string | null): ContentBlock[] {
  const images: ContentBlock[] = Array.from(el.querySelectorAll('img')).map((img) => ({
    type: 'image',
    available: false,
    ...(img.getAttribute('alt') ? { alt: img.getAttribute('alt')! } : {}),
  }));
  if (role === 'user') {
    const body = el.querySelector(USER_TEXT);
    const text = (body ?? el).textContent?.trim() ?? '';
    return [
      ...images,
      ...(text ? [{ type: 'text' as const, text, format: 'plain' as const }] : []),
    ];
  }
  const parts = Array.from(el.querySelectorAll(ASSISTANT_MARKDOWN));
  if (parts.length === 0) return elementToBlocks(el);
  return parts.flatMap((part) => elementToBlocks(part));
}

function readPager(turn: Element): { index: number; count: number } | null {
  for (const el of Array.from(turn.querySelectorAll('div, span'))) {
    if (el.children.length > 0) continue;
    const m = PAGER_TEXT.exec(el.textContent ?? '');
    if (m) return { index: Number(m[1]) - 1, count: Number(m[2]) };
  }
  return null;
}

async function scrollCollect(
  container: HTMLElement,
  settle: (el: Element) => Promise<void>,
  collect: () => void,
): Promise<void> {
  const original = container.scrollTop;
  const deadline = Date.now() + 120_000;
  try {
    for (let round = 0; round < 30 && Date.now() < deadline; round++) {
      const before = container.scrollHeight;
      container.scrollTop = 0;
      await settle(container);
      collect();
      if (container.scrollHeight <= before) break;
    }
    for (let steps = 0; steps < 1000 && Date.now() < deadline; steps++) {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) break;
      const previous = container.scrollTop;
      container.scrollTop += Math.max(200, container.clientHeight * 0.8);
      await settle(container);
      collect();
      if (container.scrollTop === previous) break;
    }
  } finally {
    container.scrollTop = original;
  }
}
