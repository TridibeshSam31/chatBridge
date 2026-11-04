import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectConversation } from '../../src/content/chatgpt/adapter';
import { DetectedConversationSchema } from '../../src/shared/protocol';

const ID = '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const URL_ = `https://chatgpt.com/c/${ID}`;
const fixture = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation.html'),
  'utf8',
);

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('detectConversation', () => {
  it('detects id, title and rendered counts from the fixture', () => {
    const result = detectConversation(docFrom(fixture), URL_);
    expect(DetectedConversationSchema.parse(result)).toEqual({
      provider: 'chatgpt',
      url: URL_,
      conversationId: ID,
      title: 'Debugging the auth middleware',
      renderedMessageCount: 4,
      renderedRoleCounts: { user: 2, assistant: 2, other: 0 },
      selectorStrategy: 'data-message-author-role',
    });
  });

  it('dedupes messages that appear twice with the same id', () => {
    const doc = docFrom(fixture);
    const dup = doc.querySelector('[data-message-id="bbb1"]')!.cloneNode(true);
    doc.querySelector('main')!.appendChild(dup);
    expect(detectConversation(doc, URL_).renderedMessageCount).toBe(4);
  });

  it('falls back to document.title when the sidebar link is missing', () => {
    const doc = docFrom(fixture);
    doc.querySelector('nav')!.remove();
    expect(detectConversation(doc, URL_).title).toBe('Debugging the auth middleware');
  });

  it('treats generic page titles as no title', () => {
    const doc = docFrom('<html><head><title>ChatGPT</title></head><body></body></html>');
    expect(detectConversation(doc, URL_).title).toBeNull();
  });

  it('reports no strategy when the DOM has no recognisable messages', () => {
    const result = detectConversation(docFrom('<main><div>hello</div></main>'), URL_);
    expect(result.selectorStrategy).toBeNull();
    expect(result.renderedMessageCount).toBe(0);
  });

  it('uses the turn-article fallback when role attributes are absent', () => {
    const doc = docFrom(`
      <article data-testid="conversation-turn-1" data-turn="user"><p>hi</p></article>
      <article data-testid="conversation-turn-2" data-turn="assistant"><p>hello</p></article>`);
    const result = detectConversation(doc, URL_);
    expect(result.selectorStrategy).toBe('conversation-turn');
    expect(result.renderedRoleCounts).toEqual({ user: 1, assistant: 1, other: 0 });
  });

  it('finds <section> turn containers', () => {
    const doc = docFrom(`
      <section data-testid="conversation-turn-1" data-turn="user"><p>hi</p></section>
      <section data-testid="conversation-turn-2" data-turn="assistant"><p>hello</p></section>`);
    const result = detectConversation(doc, URL_);
    expect(result.selectorStrategy).toBe('conversation-turn');
    expect(result.renderedRoleCounts).toEqual({ user: 1, assistant: 1, other: 0 });
  });

  it('falls back to data-turn, then to bare message ids', () => {
    const turns = docFrom(`
      <div data-turn="user"><p>hi</p></div><div data-turn="assistant"><p>hello</p></div>`);
    expect(detectConversation(turns, URL_).selectorStrategy).toBe('data-turn');
    const ids = docFrom(`<div data-message-id="a"><p>hi</p></div>`);
    const result = detectConversation(ids, URL_);
    expect(result.selectorStrategy).toBe('data-message-id');
    expect(result.renderedMessageCount).toBe(1);
  });

  it('has no conversation on the home page', () => {
    const result = detectConversation(docFrom(fixture), 'https://chatgpt.com/');
    expect(result.conversationId).toBeNull();
    expect(result.title).toBeNull();
  });
});
