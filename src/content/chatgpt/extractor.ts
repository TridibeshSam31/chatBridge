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
import { findScrollContainer } from './diagnostics/dom-probe';
import { elementToBlocks, textWithoutChrome } from './dom-to-blocks';
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
  // Page order of every message seen so far. Collection starts wherever the user
  // is looking, so new messages are placed relative to ones already known
  // rather than in the order they were discovered.
  const order: string[] = [];
  const collect = (direction: 'up' | 'down' = 'up'): number => {
    const before = collected.size;
    const elements = Array.from(root.querySelectorAll(strategy.message)).filter(
      (el) => !el.closest('nav, aside'),
    );
    let anchor: number | null = null; // index in `order` of the last known message in this pass
    const pending: string[] = []; // new messages seen before the first known one
    elements.forEach((el, index) => {
      const id = strategy.id(el);
      const turnEl = el.closest(TURN_CONTAINER);
      const turnMatch = TURN_NUMBER.exec(turnEl?.getAttribute('data-testid') ?? '');
      const turn = turnMatch ? Number(turnMatch[1]) : null;
      // Without ids, fall back to turn number (stable across scrolling) or DOM position.
      const key = id ?? (turn !== null ? `turn-${turn}-${index}` : `pos-${index}`);
      if (collected.has(key)) {
        let at = order.indexOf(key);
        if (anchor === null) {
          // Messages seen before the first known one belong right before it.
          order.splice(at, 0, ...pending);
          at += pending.length;
        }
        anchor = at;
        return;
      }
      collected.set(key, {
        key,
        hasId: id !== null,
        turn,
        role: mapRole(strategy.role(el)),
        content: messageBlocks(el, strategy.role(el)),
        pager: readPager(turnEl ?? el),
      });
      if (anchor === null) pending.push(key);
      else order.splice(++anchor, 0, key);
    });
    // No known message on screen: older ones load above, newer ones below.
    if (anchor === null) {
      if (direction === 'up') order.unshift(...pending);
      else order.push(...pending);
    }
    return collected.size - before;
  };

  const warnings: ExtractionWarning[] = [];
  const reasons = ['Read from the rendered page, which cannot prove every message was loaded.'];
  collect();

  let scrolled = false;
  let incomplete = false;
  if (options.scroll) {
    const first = root.querySelector(strategy.message);
    const container = first ? findScrollContainer(first) : null;
    if (container) {
      scrolled = true;
      const outcome = await scrollCollect(container, options.settle ?? settleScroll, collect);
      if (!outcome.reachedTop || !outcome.reachedBottom) {
        incomplete = true;
        const where = !outcome.reachedTop
          ? !outcome.reachedBottom
            ? 'the start or the end'
            : 'the start'
          : 'the end';
        reasons.push(
          `Scrolling did not reach ${where} of the chat${outcome.timedOut ? ' within 5 minutes' : ''}, so messages are missing.`,
        );
        warnings.push({
          code: 'SCROLL_INCOMPLETE',
          message: `Could not scroll to ${where} of the chat${outcome.timedOut ? ' in time' : ''}; some messages are missing. Use the one-click method or the export file for the whole chat.`,
        });
      }
    } else {
      warnings.push({
        code: 'NO_SCROLL_CONTAINER',
        message:
          'Nothing to scroll: the chat fits on screen, or its scrolling area was not found. Read what is on the page.',
      });
    }
  }
  if (!scrolled) {
    reasons.push(
      'The conversation was not scrolled through; long chats may not be fully rendered.',
    );
  }

  const position = new Map(order.map((key, i) => [key, i]));
  const items = order.map((key) => collected.get(key)!);
  const allTurns = items.every((i) => i.turn !== null);
  if (allTurns) {
    items.sort((a, b) => a.turn! - b.turn! || position.get(a.key)! - position.get(b.key)!);
  }

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
  // Many messages with the same text means the selectors hit labels, not content.
  const byText = new Map<string, number>();
  for (const m of messages) {
    const t = messageText(m).trim();
    if (t) byText.set(t, (byText.get(t) ?? 0) + 1);
  }
  const repeated = Math.max(0, ...byText.values());
  if (messages.length >= 4 && repeated >= messages.length / 2) {
    reasons.push('Most messages have identical text, so the page was probably not read correctly.');
    warnings.push({
      code: 'SUSPICIOUS_CONTENT',
      message: `${repeated} of ${messages.length} messages have identical text. ChatGPT's layout may have changed: run Diagnostics, and use the internal endpoint or the export meanwhile.`,
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
      completeness: incomplete ? 'partial' : 'unknown',
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
    const text = textWithoutChrome(body ?? el).trim();
    return [
      ...images,
      ...(text ? [{ type: 'text' as const, text, format: 'plain' as const }] : []),
    ];
  }
  // Outermost matches only: both selectors can match nested elements of one reply.
  const parts = Array.from(el.querySelectorAll(ASSISTANT_MARKDOWN)).filter((part) => {
    const outer = part.parentElement?.closest(ASSISTANT_MARKDOWN);
    return !outer || !el.contains(outer);
  });
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

export interface ScrollOutcome {
  reachedTop: boolean;
  reachedBottom: boolean;
  timedOut: boolean;
}

export const SCROLL_DEADLINE_MS = 5 * 60_000;

/**
 * Scrolls to the top (where older messages load), then down to the bottom,
 * collecting after every step. Reports whether both ends were actually reached,
 * so a cut-short scroll is never mistaken for a full one.
 */
async function scrollCollect(
  container: HTMLElement,
  settle: (el: Element) => Promise<void>,
  collect: (direction: 'up' | 'down') => number,
): Promise<ScrollOutcome> {
  const original = container.scrollTop;
  const deadline = Date.now() + SCROLL_DEADLINE_MS;
  const atTop = () => container.scrollTop <= 2;
  const atBottom = () => container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
  let reachedTop = false;
  let reachedBottom = false;
  try {
    // Older messages may load in batches at the top: keep going until the
    // height and the set of collected messages both stop growing.
    for (let round = 0; round < 60 && Date.now() < deadline; round++) {
      const height = container.scrollHeight;
      container.scrollTop = 0;
      await settle(container);
      const added = collect('up');
      reachedTop = atTop();
      if (container.scrollHeight <= height && added === 0 && reachedTop) break;
    }
    for (let steps = 0; steps < 5000 && Date.now() < deadline; steps++) {
      if (atBottom()) {
        reachedBottom = true;
        break;
      }
      const previous = container.scrollTop;
      container.scrollTop += Math.max(200, container.clientHeight * 0.9);
      await settle(container);
      collect('down');
      if (container.scrollTop === previous) {
        reachedBottom = atBottom();
        break;
      }
    }
    if (!reachedBottom) reachedBottom = atBottom();
  } finally {
    container.scrollTop = original;
  }
  return { reachedTop, reachedBottom, timedOut: Date.now() >= deadline };
}

/**
 * Waits until no new elements have been added for 250 ms (max 1.5 s). Attribute
 * and text churn (syntax highlighting, animations) is ignored, so a busy page
 * does not make every step wait for the maximum.
 */
export function settleScroll(container: Element): Promise<void> {
  return new Promise((resolve) => {
    let quiet = setTimeout(done, 250);
    const hardStop = setTimeout(done, 1500);
    const observer = new MutationObserver((records) => {
      if (!records.some((r) => Array.from(r.addedNodes).some((n) => n.nodeType === 1))) return;
      clearTimeout(quiet);
      quiet = setTimeout(done, 250);
    });
    function done() {
      clearTimeout(quiet);
      clearTimeout(hardStop);
      observer.disconnect();
      resolve();
    }
    observer.observe(container, { childList: true, subtree: true });
  });
}
