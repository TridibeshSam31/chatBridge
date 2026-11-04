import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  CONTENT_SCRIPT_FILE,
  detectInTab,
  inspectActiveTab,
} from '../../src/sidepanel/tab-bridge';
import type { DetectedConversation } from '../../src/shared/protocol';

const conversation: DetectedConversation = {
  provider: 'chatgpt',
  url: 'https://chatgpt.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b',
  conversationId: '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b',
  title: 'T',
  renderedMessageCount: 2,
  renderedRoleCounts: { user: 1, assistant: 1, other: 0 },
  selectorStrategy: 'data-message-author-role',
};

const noReceiver = () => new Error('Could not establish connection. Receiving end does not exist.');

function installChrome(overrides: {
  query?: () => Promise<Partial<chrome.tabs.Tab>[]>;
  sendMessage?: (...args: unknown[]) => Promise<unknown>;
  executeScript?: (...args: unknown[]) => Promise<unknown>;
}) {
  const fake = {
    tabs: {
      query: vi.fn(overrides.query ?? (() => Promise.resolve([]))),
      sendMessage: vi.fn(overrides.sendMessage ?? (() => Promise.resolve(undefined))),
    },
    scripting: { executeScript: vi.fn(overrides.executeScript ?? (() => Promise.resolve([]))) },
  };
  vi.stubGlobal('chrome', fake);
  return fake;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('detectInTab', () => {
  it('returns the validated detection payload', async () => {
    installChrome({ sendMessage: () => Promise.resolve({ ok: true, data: conversation }) });
    await expect(detectInTab(1)).resolves.toEqual(conversation);
  });

  it('injects the content script once when no receiver exists, then retries', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(noReceiver())
      .mockResolvedValueOnce({ ok: true, data: conversation });
    const fake = installChrome({ sendMessage: send });

    await expect(detectInTab(7)).resolves.toEqual(conversation);
    expect(fake.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: [CONTENT_SCRIPT_FILE],
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports an actionable error when injection is not possible', async () => {
    installChrome({
      sendMessage: () => Promise.reject(noReceiver()),
      executeScript: () => Promise.reject(new Error('Frame with ID 0 is showing error page')),
    });
    await expect(detectInTab(1)).rejects.toMatchObject({
      code: 'CONTENT_SCRIPT_UNAVAILABLE',
      message: expect.stringContaining('Reload the tab'),
    });
  });

  it('does not hide unrelated messaging failures behind injection', async () => {
    const fake = installChrome({
      sendMessage: () => Promise.reject(new Error('Tab was discarded')),
    });
    await expect(detectInTab(1)).rejects.toThrow('Tab was discarded');
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('rejects malformed responses', async () => {
    installChrome({ sendMessage: () => Promise.resolve({ ok: true, data: { provider: 'x' } }) });
    await expect(detectInTab(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('surfaces content-script errors with their code', async () => {
    installChrome({
      sendMessage: () =>
        Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED_PROTOCOL', message: 'Reload' } }),
    });
    const err = await detectInTab(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' });
  });
});

describe('inspectActiveTab', () => {
  it('reports no tab', async () => {
    installChrome({ query: () => Promise.resolve([]) });
    await expect(inspectActiveTab()).resolves.toEqual({ kind: 'no-tab' });
  });

  it('reports non-ChatGPT tabs without messaging them', async () => {
    // Without the "tabs" permission Chrome omits url for hosts we can't access.
    const fake = installChrome({ query: () => Promise.resolve([{ id: 3 }]) });
    await expect(inspectActiveTab()).resolves.toEqual({ kind: 'not-chatgpt' });
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('detects the conversation in a ChatGPT tab', async () => {
    installChrome({
      query: () => Promise.resolve([{ id: 3, url: conversation.url }]),
      sendMessage: () => Promise.resolve({ ok: true, data: conversation }),
    });
    await expect(inspectActiveTab()).resolves.toEqual({ kind: 'detected', tabId: 3, conversation });
  });
});
