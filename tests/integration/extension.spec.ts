import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test as base, type Worker } from '@playwright/test';

const DIST = resolve(import.meta.dirname, '../../dist');
const CONVERSATION_ID = '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const CHATGPT_URL = `https://chatgpt.com/c/${CONVERSATION_ID}`;
const FIXTURE = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-dom/conversation.html'),
  'utf8',
);

const test = base.extend<{ context: BrowserContext; serviceWorker: Worker; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    // Serve the fixture *as* chatgpt.com so the real content script is injected,
    // without touching the network or a real account.
    await context.route('https://chatgpt.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
    );
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

test('content script answers detection requests on chatgpt.com', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(CHATGPT_URL);

  await expect
    .poll(
      () =>
        serviceWorker.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url: `${url}*` });
          if (tab?.id === undefined) return null;
          return chrome.tabs
            .sendMessage(tab.id, { type: 'chatbridge/detect', protocol: 1 })
            .catch((err: unknown) => ({ error: String(err) }));
        }, CHATGPT_URL),
      { timeout: 10_000 },
    )
    .toMatchObject({
      ok: true,
      data: {
        conversationId: CONVERSATION_ID,
        title: 'Debugging the auth middleware',
        renderedMessageCount: 4,
      },
    });
});

test('side panel shows the conversation of the focused ChatGPT tab', async ({
  context,
  extensionId,
}) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // While the panel page itself is the active tab, it is not a ChatGPT tab.
  await expect(panel.getByTestId('state-not-chatgpt')).toBeVisible();

  const chat = await context.newPage();
  await chat.goto(CHATGPT_URL);
  await chat.bringToFront();

  // The panel reacts to tab activation/updates, exactly as the real side panel does.
  await expect(panel.getByTestId('conversation-title')).toHaveText('Debugging the auth middleware');
  await expect(panel.getByTestId('message-count')).toHaveText('4');
});
