import { describe, expect, it } from 'vitest';
import { isChatGptUrl, parseConversationId } from '../../src/content/chatgpt/url';

const ID = '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';

describe('isChatGptUrl', () => {
  it.each([
    ['https://chatgpt.com/', true],
    ['https://chat.openai.com/c/x', true],
    ['http://chatgpt.com/', false],
    ['https://evil-chatgpt.com/', false],
    ['https://chatgpt.com.evil.io/', false],
    ['chrome://extensions', false],
    ['not a url', false],
    [undefined, false],
  ])('%s → %s', (url, expected) => {
    expect(isChatGptUrl(url)).toBe(expected);
  });
});

describe('parseConversationId', () => {
  it('reads a plain conversation link', () => {
    expect(parseConversationId(`https://chatgpt.com/c/${ID}`)).toBe(ID);
  });

  it('reads GPT and project conversation links', () => {
    expect(parseConversationId(`https://chatgpt.com/g/g-abc123-helper/c/${ID}`)).toBe(ID);
    expect(parseConversationId(`https://chatgpt.com/g/g-p-xyz/project/c/${ID}?model=x`)).toBe(ID);
  });

  it('normalizes case', () => {
    expect(parseConversationId(`https://chatgpt.com/c/${ID.toUpperCase()}`)).toBe(ID);
  });

  it('returns null where there is no conversation', () => {
    expect(parseConversationId('https://chatgpt.com/')).toBeNull();
    expect(parseConversationId('https://chatgpt.com/?temporary-chat=true')).toBeNull();
    expect(parseConversationId('https://chatgpt.com/c/not-a-uuid')).toBeNull();
    expect(parseConversationId(`https://example.com/c/${ID}`)).toBeNull();
  });
});
