import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationSchema, messageText } from '../../src/core/conversation/schema';
import { elementToBlocks } from '../../src/content/chatgpt/dom-to-blocks';
import { DomExtractionError, extractFromDom } from '../../src/content/chatgpt/extractor';

const URL_ = 'https://chatgpt.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const fixture = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation.html'),
  'utf8',
);
const docFrom = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const fixture2026 = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation-2026.html'),
  'utf8',
);
const URL_2026 = 'https://chatgpt.com/g/g-p-abc-dsa/c/6aa18b1f-077c-83ee-9850-c4144d40a054';

describe('extractFromDom on the Nov 2026 layout', () => {
  it('reads roles, ids, text and code blocks without page chrome', async () => {
    const conv = await extractFromDom(docFrom(fixture2026), URL_2026, { scroll: false });
    expect(conv.metadata).toMatchObject({ selectorStrategy: 'search-unit' });
    expect(conv.title).toBe('SENTINEL_TITLE_2026');
    expect(conv.messages.map((m) => [m.id, m.role])).toEqual([
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['u2', 'user'],
      // No message id on the page: the unit key is stable, so scrolling cannot merge messages.
      ['t2:1:assistant', 'assistant'],
    ]);
    expect(conv.extraction.warnings.map((w) => w.code)).not.toContain('DOM_NO_IDS');
    expect(conv.messages[0]!.content).toEqual([
      { type: 'text', text: 'Merge sort samjhao', format: 'plain' },
    ]);
    expect(conv.messages[1]!.content).toEqual([
      { type: 'text', text: '**Flow yaad rakh:**', format: 'markdown' },
      { type: 'code', text: 'slow = head;\nfast = head->next;', language: 'c++' },
      {
        type: 'text',
        text: 'Ye `fast = head->next` intentionally rakha hai.',
        format: 'markdown',
      },
      { type: 'code', text: 'split → sort → merge' },
    ]);
    const all = JSON.stringify(conv);
    expect(all).not.toMatch(/SIDEBAR_MUST_NOT_BE_READ|Retry|Copy|Edit|said:/);
  });
});

describe('extraction sanity check', () => {
  it('flags a page where every message has the same text', async () => {
    const turns = Array.from(
      { length: 4 },
      (_, i) =>
        `<div data-message-author-role="${i % 2 ? 'assistant' : 'user'}" data-message-id="m${i}">You said:</div>`,
    ).join('');
    const conv = await extractFromDom(docFrom(`<main>${turns}</main>`), URL_, { scroll: false });
    expect(conv.extraction.warnings.map((w) => w.code)).toContain('SUSPICIOUS_CONTENT');
  });
});

describe('extractFromDom', () => {
  it('extracts messages in order with roles, text and code', async () => {
    const conv = await extractFromDom(docFrom(fixture), URL_, { scroll: false });
    expect(ConversationSchema.safeParse(conv).success).toBe(true);
    expect(conv.title).toBe('Debugging the auth middleware');
    expect(conv.messages.map((m) => [m.id, m.role])).toEqual([
      ['aaa1', 'user'],
      ['bbb1', 'assistant'],
      ['aaa2', 'user'],
      ['bbb2', 'assistant'],
    ]);
    expect(conv.messages[0]!.content).toEqual([
      {
        type: 'text',
        text: 'My Express auth middleware returns 401 for valid tokens.',
        format: 'plain',
      },
    ]);
    expect(conv.messages[1]!.content).toEqual([
      {
        type: 'text',
        text: "Check that you're reading the header case-insensitively:",
        format: 'markdown',
      },
      {
        type: 'code',
        text: "const token = req.get('authorization')?.split(' ')[1];",
        language: 'js',
      },
    ]);
  });

  it('never claims completeness from the DOM, and says why', async () => {
    const conv = await extractFromDom(docFrom(fixture), URL_, { scroll: false });
    expect(conv.extraction.method).toBe('dom');
    expect(conv.extraction.completeness).toBe('unknown');
    expect(conv.extraction.completenessReasons.join(' ')).toMatch(/not scrolled/);
  });

  it('marks messages with alternative versions and warns', async () => {
    const doc = docFrom(fixture);
    doc
      .querySelector('[data-testid="conversation-turn-4"]')!
      .insertAdjacentHTML(
        'beforeend',
        '<div><button aria-label="Previous response">‹</button><div>2/3</div></div>',
      );
    const conv = await extractFromDom(doc, URL_, { scroll: false });
    expect(conv.messages[3]!.provenance).toEqual({ siblingCount: 3, branchIndex: 1 });
    expect(conv.extraction.warnings.map((w) => w.code)).toContain('BRANCHES_PRESENT');
  });

  it('ignores message-like markup in the sidebar', async () => {
    const doc = docFrom(fixture);
    doc
      .querySelector('nav')!
      .insertAdjacentHTML(
        'beforeend',
        '<div data-message-author-role="user" data-message-id="x">no</div>',
      );
    expect((await extractFromDom(doc, URL_, { scroll: false })).messages).toHaveLength(4);
  });

  it('fails clearly when there is no conversation or no messages', async () => {
    await expect(
      extractFromDom(docFrom(fixture), 'https://chatgpt.com/', { scroll: false }),
    ).rejects.toMatchObject({
      code: 'NO_CONVERSATION',
    });
    await expect(
      extractFromDom(docFrom('<main></main>'), URL_, { scroll: false }),
    ).rejects.toBeInstanceOf(DomExtractionError);
  });

  it('warns when messages have no stable ids', async () => {
    const doc = docFrom(`<main>
      <article data-testid="conversation-turn-1"><div data-message-author-role="user">a</div></article>
      <article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>b</p></div></div></article></main>`);
    const conv = await extractFromDom(doc, URL_, { scroll: false });
    expect(conv.messages.map((m) => m.id)).toEqual(['turn-1-0', 'turn-2-1']);
    expect(conv.extraction.warnings.map((w) => w.code)).toContain('DOM_NO_IDS');
  });
});

describe('elementToBlocks', () => {
  const blocks = (html: string) =>
    elementToBlocks(docFrom(`<div id="r">${html}</div>`).getElementById('r')!);

  it('converts headings, lists, emphasis, links and inline code to markdown', () => {
    expect(
      blocks(
        '<h2>Plan</h2><ul><li>One <strong>bold</strong></li><li>Two<ol><li>nested</li></ol></li></ul>' +
          '<p>See <a href="https://x.dev">docs</a> and <code>npm i</code>, <em>ok</em>.</p>',
      ),
    ).toEqual([
      {
        type: 'text',
        format: 'markdown',
        text: '## Plan\n\n- One **bold**\n- Two\n  1. nested\n\nSee [docs](https://x.dev) and `npm i`, *ok*.',
      },
    ]);
  });

  it('drops non-http links and UI buttons', () => {
    expect(blocks('<p><a href="javascript:alert(1)">x</a><button>Copy</button></p>')).toEqual([
      { type: 'text', format: 'markdown', text: 'x' },
    ]);
  });

  it('reads code language from a header label when there is no class', () => {
    expect(
      blocks(
        '<pre><div><span>python</span><button>Copy code</button></div><code>print(1)\n</code></pre>',
      ),
    ).toEqual([{ type: 'code', text: 'print(1)', language: 'python' }]);
  });

  it('renders tables and math', () => {
    expect(
      blocks(
        '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>' +
          '<p><span class="katex"><annotation>x^2</annotation><span>x2</span></span></p>',
      ),
    ).toEqual([
      { type: 'text', format: 'markdown', text: '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n$x^2$' },
    ]);
  });
});

describe('scrolling a virtualized chat', () => {
  const TOTAL = 40;
  const ROW = 100;

  /** A chat that, like ChatGPT, keeps only the rows near the viewport in the page. */
  function virtualChat(opts: { stuckAt?: number } = {}) {
    // The global document: parsed documents have no window, so no computed styles.
    const doc = document;
    doc.body.innerHTML =
      '<main><div id="scroller" style="overflow-y: auto"><div id="rows"></div></div></main>';
    const scroller = doc.getElementById('scroller')!;
    const rows = doc.getElementById('rows')!;
    let top = 0;
    const render = () => {
      const first = Math.max(0, Math.floor(top / ROW) - 1);
      rows.innerHTML = '';
      for (let i = first; i < Math.min(TOTAL, first + 5); i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        rows.insertAdjacentHTML(
          'beforeend',
          `<div data-chatgpt-search-unit-key="t${i}:0:${role}"><div data-user-message-bubble="true">message ${i}</div></div>`,
        );
      }
    };
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 300 },
      scrollHeight: { get: () => TOTAL * ROW },
      scrollTop: {
        get: () => top,
        set: (v: number) => {
          const max = opts.stuckAt ?? TOTAL * ROW - 300;
          top = Math.min(Math.max(0, v), max);
          render();
        },
      },
    });
    top = 2000; // the user is looking at the middle of the chat
    render();
    return doc;
  }

  it('collects every message, in order, from top to bottom', async () => {
    const conv = await extractFromDom(virtualChat(), URL_2026, {
      scroll: true,
      settle: async () => {},
    });
    expect(conv.messages.map((m) => messageText(m))).toEqual(
      Array.from({ length: TOTAL }, (_, i) => `message ${i}`),
    );
    expect(conv.extraction.warnings.map((w) => w.code)).not.toContain('SCROLL_INCOMPLETE');
    expect(conv.extraction.completeness).toBe('unknown');
  });

  it('says so when scrolling cannot reach the end, instead of returning half silently', async () => {
    const conv = await extractFromDom(virtualChat({ stuckAt: 1500 }), URL_2026, {
      scroll: true,
      settle: async () => {},
    });
    expect(conv.messages.length).toBeLessThan(TOTAL);
    expect(conv.extraction.completeness).toBe('partial');
    expect(conv.extraction.warnings.map((w) => w.code)).toContain('SCROLL_INCOMPLETE');
  });
});
