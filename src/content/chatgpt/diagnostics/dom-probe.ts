import { bump, type Histogram, shapeOf, urlShape } from '../../../shared/redact';
import { MESSAGE_STRATEGIES, sidebarLinkFor, GENERIC_TITLES, TURN_CONTAINER } from '../selectors';
import { parseConversationId } from '../url';

/**
 * Structural snapshot of the ChatGPT conversation DOM, used to validate selectors
 * against a real session. It records tags, data-* attribute names, shaped
 * attribute values and text *lengths*. It never records message text, titles,
 * the sidebar's other conversations, or URLs beyond host + shaped path.
 */

export interface SkeletonNode {
  tag: string;
  attrs?: Record<string, string>;
  children?: (SkeletonNode | string)[];
}

export interface StrategyResult {
  name: string;
  matches: number;
  withId: number;
  duplicateIds: number;
  roles: Histogram;
}

export interface ScrollTestResult {
  performed: boolean;
  reason?: string;
  durationMs?: number;
  initialRendered?: number;
  renderedAtTop?: number;
  renderedAtBottom?: number;
  minRendered?: number;
  maxRendered?: number;
  distinctIdsSeen?: number;
  topLoadRounds?: number;
  /** Ids rendered at the top that were gone at the bottom: >0 means virtualization. */
  topIdsMissingAtBottom?: number;
  steps?: number;
  scrollRestored?: boolean;
}

export interface DomProbeReport {
  kind: 'dom-probe';
  probeVersion: 1;
  path: string;
  hasConversationId: boolean;
  page: { documentTitleIsGeneric: boolean; sidebarLinkFound: boolean; mainElementFound: boolean };
  strategies: StrategyResult[];
  turns: { articles: number; testIds: Histogram; contentVisibilityAuto: number };
  attributeCensus: Record<string, { count: number; values: string[] }>;
  codeBlocks: { pre: number; codeLanguageClasses: Histogram; headerLabels: Histogram };
  branchPagers: { count: number; sample: SkeletonNode | null };
  images: { inUserMessages: number; inAssistantMessages: number; hosts: Histogram };
  timestamps: { timeElements: number; datetimeAttributes: number };
  scrollContainer: SkeletonNode | null;
  scrollTest: ScrollTestResult;
  samples: Record<string, SkeletonNode | null>;
}

const MAX_DEPTH = 14;
const MAX_CHILDREN = 12;
const UI_LABEL = /^[A-Za-z][A-Za-z ]{0,40}$/;
const LANGUAGE_LABEL = /^[A-Za-z][A-Za-z0-9+#. -]{0,19}$/;
const PAGER_TEXT = /^\s*\d+\s*\/\s*\d+\s*$/;

export function skeleton(el: Element, depth = 0): SkeletonNode {
  const node: SkeletonNode = { tag: el.tagName.toLowerCase() };
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    const { name, value } = attr;
    if (name.startsWith('data-') || ['role', 'contenteditable', 'dir', 'type'].includes(name)) {
      attrs[name] = shapeOf(value);
    } else if (name === 'aria-label' && el.tagName === 'BUTTON') {
      // Button labels are UI strings ("Copy", "Edit message"); anything else is redacted.
      attrs[name] = UI_LABEL.test(value) ? value : `<str:${value.length}>`;
    } else if (name === 'href' || name === 'src') {
      attrs[name] = urlShape(value);
    } else if (name === 'class') {
      const tokens = value.split(/\s+/).filter((t) => t && t.length <= 40);
      attrs[name] =
        tokens.slice(0, 8).join(' ') + (tokens.length > 8 ? ` …+${tokens.length - 8}` : '');
    }
  }
  if (Object.keys(attrs).length > 0) node.attrs = attrs;

  if (depth >= MAX_DEPTH) {
    if (el.childNodes.length > 0) node.children = ['<depth limit>'];
    return node;
  }
  const children: (SkeletonNode | string)[] = [];
  let skipped = 0;
  for (const child of Array.from(el.childNodes)) {
    let entry: SkeletonNode | string | null = null;
    if (child.nodeType === Node.ELEMENT_NODE) entry = skeleton(child as Element, depth + 1);
    else if (child.nodeType === Node.TEXT_NODE) {
      const length = child.textContent?.trim().length ?? 0;
      if (length > 0) entry = `#text(${length})`;
    }
    if (entry === null) continue;
    if (children.length < MAX_CHILDREN) children.push(entry);
    else skipped++;
  }
  if (skipped > 0) children.push(`…+${skipped} more`);
  if (children.length > 0) node.children = children;
  return node;
}

export interface DomProbeOptions {
  scrollTest: boolean;
  /** Overridable for tests; defaults to real timers. */
  settle?: (container: Element) => Promise<void>;
}

export async function probeDom(
  doc: Document,
  url: string,
  options: DomProbeOptions,
): Promise<DomProbeReport> {
  const conversationId = parseConversationId(url);
  const main = doc.querySelector('main');
  // The sidebar lists other conversations; never look inside it.
  const root = main ?? doc.body;
  const inScope = (el: Element) => !el.closest('nav, aside');

  const strategies = MESSAGE_STRATEGIES.map((strategy): StrategyResult => {
    const elements = Array.from(root.querySelectorAll(strategy.message)).filter(inScope);
    const ids = new Set<string>();
    const result: StrategyResult = {
      name: strategy.name,
      matches: elements.length,
      withId: 0,
      duplicateIds: 0,
      roles: {},
    };
    for (const el of elements) {
      const id = strategy.id(el);
      if (id !== null) {
        result.withId++;
        if (ids.has(id)) result.duplicateIds++;
        ids.add(id);
      }
      const role = strategy.role(el);
      bump(result.roles, role === null ? '<none>' : shapeOf(role));
    }
    return result;
  });

  const messages = Array.from(root.querySelectorAll('[data-message-author-role]')).filter(inScope);
  const byRole = (role: string) =>
    messages.filter((m) => m.getAttribute('data-message-author-role') === role);
  const turnOf = (el: Element) => el.closest(TURN_CONTAINER) ?? el;
  const firstWith = (els: Element[], selector: string) =>
    els.find((el) => el.querySelector(selector));

  const articles = Array.from(root.querySelectorAll('article')).filter(inScope);
  const testIds: Histogram = {};
  let contentVisibilityAuto = 0;
  for (const article of articles) {
    const testId = article.getAttribute('data-testid');
    if (testId !== null) bump(testIds, shapeOf(testId));
    if (doc.defaultView?.getComputedStyle(article).contentVisibility === 'auto')
      contentVisibilityAuto++;
  }

  const census: Record<string, { count: number; values: string[] }> = {};
  for (const el of Array.from(root.querySelectorAll('*')).filter(inScope)) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith('data-')) continue;
      const entry = (census[attr.name] ??= { count: 0, values: [] });
      entry.count++;
      const shaped = shapeOf(attr.value);
      if (entry.values.length < 6 && !entry.values.includes(shaped)) entry.values.push(shaped);
    }
  }

  const codeLanguageClasses: Histogram = {};
  const headerLabels: Histogram = {};
  const pres = Array.from(root.querySelectorAll('pre')).filter(inScope);
  for (const pre of pres) {
    const code = pre.querySelector('code');
    for (const token of Array.from(code?.classList ?? [])) {
      if (token.startsWith('language-') || token.startsWith('lang-'))
        bump(codeLanguageClasses, shapeOf(token));
    }
    // Language labels are short text nodes in the block header, outside <code>.
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (code?.contains(n)) continue;
      const text = n.textContent?.trim() ?? '';
      if (text && LANGUAGE_LABEL.test(text)) bump(headerLabels, text.toLowerCase());
    }
  }

  const pagerLeaves = Array.from(root.querySelectorAll('div, span')).filter(
    (el) => inScope(el) && el.children.length === 0 && PAGER_TEXT.test(el.textContent ?? ''),
  );

  const imageHosts: Histogram = {};
  const countImages = (els: Element[]) => {
    let n = 0;
    for (const el of els) {
      for (const img of Array.from(el.querySelectorAll('img'))) {
        n++;
        const src = img.getAttribute('src');
        bump(imageHosts, src ? urlShape(src).split('/').slice(0, 3).join('/') : '<no-src>');
      }
    }
    return n;
  };

  const scrollContainer = messages[0] ? findScrollContainer(messages[0]) : null;
  const scrollTest = options.scrollTest
    ? scrollContainer
      ? await runScrollTest(scrollContainer, root, options.settle ?? settleDom)
      : { performed: false, reason: 'no scrollable ancestor of the first message' }
    : { performed: false, reason: 'not requested' };

  const sampleOf = (el: Element | undefined) => (el ? skeleton(turnOf(el)) : null);
  const users = byRole('user');
  const assistants = byRole('assistant');

  return {
    kind: 'dom-probe',
    probeVersion: 1,
    path: urlShape(url).replace(/^https?:\/\/[^/]+/, ''),
    hasConversationId: conversationId !== null,
    page: {
      documentTitleIsGeneric:
        GENERIC_TITLES.has(doc.title.trim().toLowerCase()) || doc.title.trim() === '',
      sidebarLinkFound:
        conversationId !== null && doc.querySelector(sidebarLinkFor(conversationId)) !== null,
      mainElementFound: main !== null,
    },
    strategies,
    turns: { articles: articles.length, testIds, contentVisibilityAuto },
    attributeCensus: census,
    codeBlocks: { pre: pres.length, codeLanguageClasses, headerLabels },
    branchPagers: {
      count: pagerLeaves.length,
      sample: pagerLeaves[0]?.parentElement ? skeleton(pagerLeaves[0].parentElement) : null,
    },
    images: {
      inUserMessages: countImages(users),
      inAssistantMessages: countImages(assistants),
      hosts: imageHosts,
    },
    timestamps: {
      timeElements: root.querySelectorAll('time').length,
      datetimeAttributes: root.querySelectorAll('[datetime]').length,
    },
    scrollContainer: scrollContainer
      ? { ...skeleton(scrollContainer, MAX_DEPTH), children: undefined }
      : null,
    scrollTest,
    samples: {
      user: sampleOf(users.find((u) => !u.querySelector('img'))),
      userWithImage: sampleOf(firstWith(users, 'img')),
      assistant: sampleOf(assistants.find((a) => !a.querySelector('pre'))),
      assistantWithCode: sampleOf(firstWith(assistants, 'pre')),
      otherRole: sampleOf(
        messages.find(
          (m) => !['user', 'assistant'].includes(m.getAttribute('data-message-author-role') ?? ''),
        ),
      ),
    },
  };
}

export function findScrollContainer(from: Element): HTMLElement | null {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const overflowY = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
      return el;
  }
  return null;
}

/** Resolves once the container has had no DOM mutations for 400 ms (max 3 s). */
export function settleDom(container: Element): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, 400);
    });
    const hardStop = setTimeout(done, 3000);
    function done() {
      clearTimeout(quiet);
      clearTimeout(hardStop);
      observer.disconnect();
      resolve();
    }
    observer.observe(container, { childList: true, subtree: true });
    quiet = setTimeout(done, 400);
  });
}

async function runScrollTest(
  container: HTMLElement,
  root: Element,
  settle: (container: Element) => Promise<void>,
): Promise<ScrollTestResult> {
  const started = Date.now();
  const deadline = started + 60_000;
  const originalTop = container.scrollTop;
  const renderedIds = () =>
    new Set(
      Array.from(root.querySelectorAll('[data-message-id]'))
        .map((el) => el.getAttribute('data-message-id'))
        .filter((id): id is string => id !== null),
    );

  const seen = new Set<string>();
  const record = () => {
    const ids = renderedIds();
    ids.forEach((id) => seen.add(id));
    min = Math.min(min, ids.size);
    max = Math.max(max, ids.size);
    return ids;
  };
  let min = Infinity;
  let max = 0;
  const initial = record();

  try {
    // Scroll to the top repeatedly: if older messages load lazily, scrollHeight grows.
    let topLoadRounds = 0;
    for (let round = 0; round < 20 && Date.now() < deadline; round++) {
      const before = container.scrollHeight;
      container.scrollTop = 0;
      await settle(container);
      if (container.scrollHeight <= before) break;
      topLoadRounds++;
    }
    const atTop = record();

    let steps = 0;
    while (
      container.scrollTop + container.clientHeight < container.scrollHeight - 2 &&
      steps < 400 &&
      Date.now() < deadline
    ) {
      const previous = container.scrollTop;
      container.scrollTop += Math.max(200, container.clientHeight * 0.8);
      await settle(container);
      record();
      steps++;
      if (container.scrollTop === previous) break;
    }
    const atBottom = record();

    return {
      performed: true,
      durationMs: Date.now() - started,
      initialRendered: initial.size,
      renderedAtTop: atTop.size,
      renderedAtBottom: atBottom.size,
      minRendered: min,
      maxRendered: max,
      distinctIdsSeen: seen.size,
      topLoadRounds,
      topIdsMissingAtBottom: [...atTop].filter((id) => !atBottom.has(id)).length,
      steps,
      scrollRestored: restore(),
    };
  } catch (err) {
    restore();
    throw err;
  }

  function restore() {
    container.scrollTop = originalTop;
    return Math.abs(container.scrollTop - originalTop) < 2;
  }
}
