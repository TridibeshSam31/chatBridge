import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeDom, skeleton } from '../../src/content/chatgpt/diagnostics/dom-probe';

const URL_ = 'https://chatgpt.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const fixture = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation.html'),
  'utf8',
);
const docFrom = (html: string) => new DOMParser().parseFromString(html, 'text/html');

/** Words that appear only in message text, titles or the sidebar of the fixture. */
const CONTENT_WORDS = [
  'Express',
  'middleware',
  'tokens',
  'TypeScript',
  'Debugging',
  'Grocery',
  'authorization',
  'case-insensitively',
  '0a0a0a0a',
];

describe('probeDom', () => {
  it('reports selector strategies against the fixture', async () => {
    const report = await probeDom(docFrom(fixture), URL_, { scrollTest: false });
    expect(report.strategies.find((st) => st.name === 'data-message-author-role')).toEqual({
      name: 'data-message-author-role',
      matches: 4,
      withId: 4,
      duplicateIds: 0,
      roles: { user: 2, assistant: 2 },
    });
    expect(report.turns.articles).toBe(4);
    expect(report.turns.testIds).toEqual({ 'conversation-turn-#': 4 });
    expect(report.codeBlocks.codeLanguageClasses).toEqual({ 'language-js': 1 });
    expect(report.path).toBe('/c/<uuid>');
    expect(report.page).toEqual({
      documentTitleIsGeneric: false,
      sidebarLinkFound: true,
      mainElementFound: true,
    });
    expect(report.scrollTest).toEqual({ performed: false, reason: 'not requested' });
  });

  it('contains no message text, titles, other conversations or raw ids', async () => {
    const report = await probeDom(docFrom(fixture), URL_, { scrollTest: false });
    const serialized = JSON.stringify(report);
    for (const word of CONTENT_WORDS) expect(serialized).not.toContain(word);
    expect(serialized).not.toContain('6f1c2a9e');
  });

  it('never reads the sidebar even when it contains message-like markup', async () => {
    const doc = docFrom(fixture);
    doc.querySelector('nav')!.innerHTML +=
      '<div data-message-author-role="user" data-message-id="leak">Sidebar SECRET</div>';
    const report = await probeDom(doc, URL_, { scrollTest: false });
    expect(report.strategies.find((st) => st.name === 'data-message-author-role')!.matches).toBe(4);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('detects branch pagers by their "n/m" text without recording other text', async () => {
    const doc = docFrom(fixture);
    doc
      .querySelector('[data-testid="conversation-turn-3"]')!
      .insertAdjacentHTML(
        'beforeend',
        '<div class="pager"><button aria-label="Previous response">‹</button><div>2/3</div><button aria-label="Next response">›</button></div>',
      );
    const report = await probeDom(doc, URL_, { scrollTest: false });
    expect(report.branchPagers.count).toBe(1);
    expect(report.branchPagers.sample).toMatchObject({
      tag: 'div',
      children: [
        { tag: 'button', attrs: { 'aria-label': 'Previous response' } },
        { tag: 'div', children: ['#text(3)'] },
        { tag: 'button', attrs: { 'aria-label': 'Next response' } },
      ],
    });
  });

  it('reports that no scroll test ran when nothing is scrollable', async () => {
    const report = await probeDom(docFrom(fixture), URL_, { scrollTest: true });
    expect(report.scrollTest).toEqual({
      performed: false,
      reason: 'no scrollable ancestor of the first message',
    });
  });
});

describe('skeleton', () => {
  it('shapes attributes and redacts free text', () => {
    const doc = docFrom(
      '<div data-message-id="6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b" data-x="hello world">' +
        '<button aria-label="Copy">c</button><button aria-label="Open my-secret-file.pdf">x</button>' +
        '<a href="https://example.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b?q=secret">l</a>' +
        'Some private text</div>',
    );
    expect(skeleton(doc.body.firstElementChild!)).toEqual({
      tag: 'div',
      attrs: { 'data-message-id': '<uuid>', 'data-x': '<str:11>' },
      children: [
        { tag: 'button', attrs: { 'aria-label': 'Copy' }, children: ['#text(1)'] },
        { tag: 'button', attrs: { 'aria-label': '<str:23>' }, children: ['#text(1)'] },
        { tag: 'a', attrs: { href: 'https://example.com/c/<uuid>' }, children: ['#text(1)'] },
        '#text(17)',
      ],
    });
  });
});
