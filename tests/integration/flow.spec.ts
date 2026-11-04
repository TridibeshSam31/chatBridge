import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type Request,
  test as base,
} from '@playwright/test';

const DIST = resolve(import.meta.dirname, '../../dist');
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const SHOTS = resolve(import.meta.dirname, '../../docs/screenshots');
const CONVERSATION_ID = '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b';
const DOM_FIXTURE = readFileSync(resolve(FIXTURES, 'chatgpt-dom/conversation.html'), 'utf8');
const EXPORT_PATH = resolve(FIXTURES, 'chatgpt-export/conversations.json');
const API_KEY = 'AIzaTEST-not-a-real-key';

interface GeminiLog {
  requests: { url: string; key: string | undefined; body: Record<string, unknown> | null }[];
}

const test = base.extend<{ context: BrowserContext; extensionId: string; gemini: GeminiLog }>({
  // eslint-disable-next-line no-empty-pattern
  gemini: async ({}, use) => {
    await use({ requests: [] });
  },
  context: async ({ gemini }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 420, height: 900 },
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await context.route('https://chatgpt.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: DOM_FIXTURE }),
    );
    // A stand-in for the Gemini API: same paths and wire format as the real service.
    await context.route('https://generativelanguage.googleapis.com/**', (route) => {
      const req: Request = route.request();
      const url = req.url();
      gemini.requests.push({
        url,
        key: req.headers()['x-goog-api-key'],
        body: req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null,
      });
      if (url.includes('/models?') || url.endsWith('/models')) {
        return route.fulfill({
          json: {
            models: [
              {
                name: 'models/gemini-test-pro',
                displayName: 'Gemini Test Pro',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
              },
            ],
          },
        });
      }
      if (url.includes(':streamGenerateContent')) {
        const chunks = ['Picking up where we left off', ' — the header fix is in place.'];
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: chunks
            .map(
              (t) =>
                `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\n\n`,
            )
            .join(''),
        });
      }
      return route.fulfill({ status: 404, json: { error: { code: 404, message: 'not mocked' } } });
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

const pageErrors: string[] = [];
test.afterEach(() => {
  expect(pageErrors, 'uncaught errors in the side panel').toEqual([]);
  pageErrors.length = 0;
});

async function openPanel(
  context: BrowserContext,
  extensionId: string,
): Promise<{ panel: Page; chat: Page }> {
  const panel = await context.newPage();
  panel.on('pageerror', (err) =>
    pageErrors.push(`${err.message}
${err.stack ?? ''}`),
  );
  panel.on('console', (msg) => {
    if (msg.type() === 'error') console.warn('[panel console]', msg.text());
  });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const chat = await context.newPage();
  await chat.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
  // Activation events can be missed under load; focusing again is what a user would do.
  await expect(async () => {
    await chat.bringToFront();
    await expect(panel.getByTestId('state-detected')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  return { panel, chat };
}

test.describe.configure({ timeout: 120_000 });

const shot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
};

test('page extraction → analysis → migration → continued Gemini chat', async ({
  context,
  extensionId,
  gemini,
}) => {
  const { panel } = await openPanel(context, extensionId);
  await shot(panel, '1-home');

  // Phase 2: extract from the page; the service worker persists the transcript.
  await panel.getByRole('button', { name: 'Analyze conversation' }).click();
  const report = panel.getByTestId('extraction-report');
  await expect(report).toBeVisible();
  await expect(panel.getByTestId('transcript-count')).toHaveText('4');
  await expect(report.getByText('Page (DOM)')).toBeVisible();
  await expect(report.getByText('completeness: unknown')).toBeVisible();

  // Phase 3: the local context pass ran automatically and cites evidence.
  const profile = panel.getByTestId('context-profile');
  await expect(
    profile.getByText('Always use TypeScript in your answers from now on.', { exact: true }),
  ).toBeVisible();
  await expect(profile.getByText('Express', { exact: true })).toBeVisible();
  await shot(panel, '2-analysis');

  // Phase 4: API key and model discovery.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByTestId('api-key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByTestId('saved-key')).toContainText('••••');
  await expect(panel.getByTestId('settings-model')).toHaveValue('gemini-test-pro');
  expect(await panel.content()).not.toContain(API_KEY);

  // Back to the transcript via the library, then plan the migration.
  await panel.getByRole('button', { name: 'Home' }).click();
  await panel.getByTestId('library').getByRole('button').first().click();
  await panel.getByRole('button', { name: 'Prepare migration' }).click();
  const preview = panel.getByTestId('plan-preview');
  await expect(preview.getByText('fits', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('plan-included')).toHaveText('4');

  // Over budget, Full History refuses instead of truncating.
  await panel.getByTestId('budget').fill('1000');
  await expect(panel.getByTestId('plan-problem').first()).toContainText('never truncates');
  await panel.getByTestId('budget').fill('200000');
  await shot(panel, '3-preview');

  const before = gemini.requests.length;
  await expect(panel.getByRole('button', { name: 'Start migration' })).toBeDisabled(); // consent not given yet
  expect(gemini.requests.length).toBe(before);
  await panel.getByTestId('consent-check').last().check();
  await panel.getByRole('button', { name: 'Start migration' }).click();

  // Continued chat, clearly labelled as an API chat.
  await expect(panel.getByTestId('destination-banner')).toContainText(
    'not visible in gemini.google.com',
  );
  await panel.getByTestId('composer').fill('Can we add rate limiting next?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-turns')).toContainText('the header fix is in place.');
  await shot(panel, '4-chat');

  const call = gemini.requests.find((r) => r.url.includes(':streamGenerateContent'))!;
  expect(call.key).toBe(API_KEY);
  expect(call.url).toContain('models/gemini-test-pro');
  const body = call.body as {
    contents: { role: string; parts: { text: string }[] }[];
    systemInstruction: { parts: { text: string }[] };
  };
  expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
  expect(body.contents[1]!.parts[0]!.text).toContain(
    "```js\nconst token = req.get('authorization')",
  );
  expect(body.contents.at(-1)!.parts[0]!.text).toBe('Can we add rate limiting next?');
  expect(body.systemInstruction.parts[0]!.text).toContain('imported');
  expect(body.systemInstruction.parts[0]!.text).toContain('4 of 4 messages are included verbatim');
  // Answer like the original assistant; in Full history its replies are already the examples.
  expect(body.systemInstruction.parts[0]!.text).toContain('# Response style to continue');
  expect(body.systemInstruction.parts[0]!.text).toContain('history above show this style');

  // The session survives closing the panel: reopen and find it in the library.
  await panel.close();
  const { panel: again } = await openPanel(context, extensionId);
  await again.getByText('Continued chats').waitFor();
  await again.getByRole('button', { name: /gemini-test-pro · 2 new turn/ }).click();
  await expect(again.getByTestId('chat-turns')).toContainText('rate limiting next?');
});

test('export import → complete transcript with branches and custom instructions; delete all data', async ({
  context,
  extensionId,
}) => {
  const { panel } = await openPanel(context, extensionId);
  await panel.getByRole('button', { name: 'Choose export file…' }).click();
  await panel.getByTestId('import-file').setInputFiles(EXPORT_PATH);
  await expect(panel.getByTestId('export-list').getByRole('button')).toHaveCount(3);
  await panel.getByRole('button', { name: /SENTINEL_TITLE_A/ }).click();

  const report = panel.getByTestId('extraction-report');
  await expect(report.getByText('Export file')).toBeVisible();
  await expect(report.getByText('completeness: complete', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('transcript-count')).toHaveText('9');
  await expect(report.getByText(/2 excluded item/)).toBeVisible();
  await expect(
    panel.getByTestId('context-profile').getByText(/SENTINEL_INSTRUCTIONS Be concise/),
  ).toBeVisible();

  // Smart mode needs no API key for the web package path.
  await panel.getByRole('button', { name: 'Prepare migration' }).click();
  await panel.getByLabel(/Smart/).check();
  await expect(panel.getByTestId('plan-included')).toHaveText('0');
  await expect(panel.getByRole('button', { name: 'Copy migration package' })).toBeEnabled();

  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'Delete all ChatBridge data…' }).click();
  await panel.getByRole('button', { name: 'Delete everything' }).click();
  await expect(panel.getByRole('button', { name: 'All data deleted' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Home' }).click();
  await expect(panel.getByText('Nothing extracted yet.')).toBeVisible();
});

test('the unofficial endpoint is hidden until enabled, then extracts with consent', async ({
  context,
  extensionId,
}) => {
  const conversation = (JSON.parse(readFileSync(EXPORT_PATH, 'utf8')) as unknown[])[0];
  await context.route('https://chatgpt.com/api/auth/session', (r) =>
    r.fulfill({ json: { accessToken: 'tok' } }),
  );
  await context.route('https://chatgpt.com/backend-api/conversation/**', (r) =>
    r.fulfill({ json: conversation }),
  );

  const { panel } = await openPanel(context, extensionId);
  await expect(panel.getByText('Advanced · unofficial endpoint')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByTestId('endpoint-toggle').check();
  await panel.getByRole('button', { name: 'Home' }).click();
  await panel.getByText('Advanced · unofficial endpoint').click();
  const extract = panel.getByRole('button', { name: 'Extract via internal endpoint' });
  await expect(extract).toBeDisabled();
  await panel.getByTestId('consent-check').check();
  await extract.click();

  const report = panel.getByTestId('extraction-report');
  await expect(report.getByText('Internal endpoint · unofficial')).toBeVisible();
  await expect(panel.getByTestId('transcript-count')).toHaveText('9');
});
