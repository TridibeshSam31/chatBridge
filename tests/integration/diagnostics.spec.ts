import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, test as base } from '@playwright/test';

const DIST = resolve(import.meta.dirname, '../../dist');
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const CONVERSATION_ID = '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const LONG_ID = '7a7a7a7a-1111-4222-8333-444444444444';
const TOKEN = 'eyJSENTINEL_ACCESS_TOKEN';
const DOM_FIXTURE = readFileSync(resolve(FIXTURES, 'chatgpt-dom/conversation.html'), 'utf8');
const EXPORT_PATH = resolve(FIXTURES, 'chatgpt-export/conversations.json');
const EXPORT_CONVERSATION = (JSON.parse(readFileSync(EXPORT_PATH, 'utf8')) as unknown[])[0];

/** A 40-turn conversation inside a fixed-height scroll container, rendered all at once. */
function longConversation(): string {
  const turns = Array.from({ length: 40 }, (_, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    return `<article data-testid="conversation-turn-${i + 1}" style="height:120px">
      <div data-message-author-role="${role}" data-message-id="m${i}">SENTINEL message ${i}</div>
    </article>`;
  }).join('');
  return `<!doctype html><title>SENTINEL long</title><main>
    <div id="scroller" style="height:400px; overflow-y:auto">${turns}</div></main>`;
}

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await context.route('https://chatgpt.com/**', (route) => {
      const html = route.request().url().includes(LONG_ID) ? longConversation() : DOM_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    // Later routes take precedence: fake the session and conversation endpoints.
    await context.route('https://chatgpt.com/api/auth/session', (route) =>
      route.fulfill({ json: { accessToken: TOKEN, user: { email: 'SENTINEL@example.com' } } }),
    );
    await context.route('https://chatgpt.com/backend-api/conversation/**', (route) => {
      const authorized = route.request().headers()['authorization'] === `Bearer ${TOKEN}`;
      return authorized
        ? route.fulfill({ json: EXPORT_CONVERSATION })
        : route.fulfill({ status: 401, json: { detail: 'Unauthorized' } });
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

/** Opens the panel, then focuses a ChatGPT tab so the panel targets it (as the real side panel does). */
async function openPanelFor(context: BrowserContext, extensionId: string, conversationId: string) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const chat = await context.newPage();
  await chat.goto(`https://chatgpt.com/c/${conversationId}`);
  await chat.bringToFront();
  await expect(panel.getByTestId('state-detected')).toBeVisible();
  await panel.getByRole('button', { name: 'Diagnostics' }).click();
  return { panel, chat };
}

async function reportOf(section: ReturnType<Page['getByTestId']>) {
  const text = await section.getByTestId('report-body').textContent();
  return { text: text ?? '', json: JSON.parse(text ?? 'null') as Record<string, unknown> };
}

test('page structure check runs on the open conversation and leaks no content', async ({
  context,
  extensionId,
}) => {
  const { panel } = await openPanelFor(context, extensionId, CONVERSATION_ID);
  const section = panel.getByTestId('diag-dom');
  await section.getByRole('button', { name: 'Run page check' }).click();
  await expect(section.getByTestId('report-body')).toBeVisible();

  const { text, json } = await reportOf(section);
  expect(json.kind).toBe('dom-probe');
  expect(json.strategies).toEqual([
    expect.objectContaining({ name: 'data-message-author-role', matches: 4, withId: 4 }),
    expect.objectContaining({ name: 'conversation-turn', matches: 4 }),
    expect.objectContaining({ name: 'data-turn' }),
    expect.objectContaining({ name: 'data-message-id', matches: 4 }),
  ]);
  for (const word of ['Express', 'middleware', 'Debugging', 'Grocery', CONVERSATION_ID]) {
    expect(text).not.toContain(word);
  }
});

test('scroll test walks a long conversation and restores the scroll position', async ({
  context,
  extensionId,
}) => {
  const { panel, chat } = await openPanelFor(context, extensionId, LONG_ID);
  await chat.locator('#scroller').evaluate((el) => (el.scrollTop = 1000));

  const section = panel.getByTestId('diag-dom');
  await section.getByText('Also scroll the conversation').click();
  await section.getByRole('button', { name: 'Run page check' }).click();
  await expect(section.getByTestId('report-body')).toBeVisible({ timeout: 60_000 });

  const { text, json } = await reportOf(section);
  expect(json.scrollTest).toMatchObject({
    performed: true,
    distinctIdsSeen: 40,
    topIdsMissingAtBottom: 0,
    topLoadRounds: 0,
    scrollRestored: true,
  });
  expect(await chat.locator('#scroller').evaluate((el) => el.scrollTop)).toBe(1000);
  expect(text).not.toContain('SENTINEL');
});

test('endpoint check requires consent and never exposes the token', async ({
  context,
  extensionId,
}) => {
  const { panel } = await openPanelFor(context, extensionId, CONVERSATION_ID);
  const section = panel.getByTestId('diag-endpoint');
  const button = section.getByRole('button', { name: 'Run endpoint check' });

  await expect(button).toBeDisabled();
  await section.getByTestId('endpoint-consent').check();
  await button.click();
  await expect(section.getByTestId('report-body')).toBeVisible();

  const { text, json } = await reportOf(section);
  expect(json).toMatchObject({
    kind: 'endpoint-probe',
    outcome: 'available',
    session: { status: 200, hasAccessToken: true },
    structure: { currentPathMessages: 11, branchPoints: 2 },
  });
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('SENTINEL');
  expect(await panel.content()).not.toContain(TOKEN);
});

test('export check reads a local conversations.json', async ({ context, extensionId }) => {
  const { panel } = await openPanelFor(context, extensionId, CONVERSATION_ID);
  const section = panel.getByTestId('diag-export');
  await section.getByTestId('export-file').setInputFiles(EXPORT_PATH);
  await expect(section.getByTestId('report-body')).toBeVisible();

  const { text, json } = await reportOf(section);
  expect(json).toMatchObject({ kind: 'export-probe', conversationCount: 3 });
  expect(text).not.toContain('SENTINEL');
});
