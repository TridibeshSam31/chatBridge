import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationSchema } from '../../src/core/conversation/schema';
import { elementToBlocks } from '../../src/content/chatgpt/dom-to-blocks';
import { DomExtractionError, extractFromDom } from '../../src/content/chatgpt/extractor';

const URL_ = 'https://chatgpt.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const fixture = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation.html'),
  'utf8',
);
const docFrom = (html: string) => new DOMParser().parseFromString(html, 'text/html');

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
