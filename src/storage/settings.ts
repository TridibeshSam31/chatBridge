import { z } from 'zod';

/**
 * User settings (chrome.storage.local) and the Gemini API key.
 *
 * Key storage, honestly: chrome.storage.local is unencrypted on disk in the
 * Chrome profile — readable by anyone or anything with access to the profile,
 * and by this extension's own code; not by web pages. "session" keeps the key in
 * memory only (chrome.storage.session) and Chrome forgets it when the browser
 * closes. We do not pretend to encrypt it: a key stored next to the ciphertext
 * protects nothing.
 */

export const SettingsSchema = z.object({
  /** Opt-in for the unofficial ChatGPT conversation endpoint. */
  endpointEnabled: z.boolean().default(false),
  keyStorage: z.enum(['session', 'local']).default('session'),
  model: z.string().nullable().default(null),
  /** Practical history budget in tokens (not the model's hard limit). */
  budgetTokens: z.number().int().min(1000).default(200_000),
  /** Recent turns Hybrid mode keeps verbatim. */
  recentTurns: z.number().int().min(0).max(500).default(20),
});
export type Settings = z.infer<typeof SettingsSchema>;

const SETTINGS_KEY = 'settings';
const API_KEY = 'geminiApiKey';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const parsed = SettingsSchema.safeParse(stored[SETTINGS_KEY] ?? {});
  if (parsed.success) return parsed.data;
  console.warn('[ChatBridge] stored settings were invalid; using defaults');
  return SettingsSchema.parse({});
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = SettingsSchema.parse({ ...current, ...patch });
  if (patch.keyStorage && patch.keyStorage !== current.keyStorage) {
    // Move the key so it exists in exactly one place.
    const key = await readKey(current.keyStorage);
    await area(current.keyStorage).remove(API_KEY);
    if (key) await area(next.keyStorage).set({ [API_KEY]: key });
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function area(kind: Settings['keyStorage']): chrome.storage.StorageArea {
  return kind === 'local' ? chrome.storage.local : chrome.storage.session;
}

async function readKey(kind: Settings['keyStorage']): Promise<string | null> {
  const value = (await area(kind).get(API_KEY))[API_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function getApiKey(): Promise<string | null> {
  return readKey((await getSettings()).keyStorage);
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty');
  await area((await getSettings()).keyStorage).set({ [API_KEY]: trimmed });
}

export async function clearApiKey(): Promise<void> {
  await Promise.all([chrome.storage.local.remove(API_KEY), chrome.storage.session.remove(API_KEY)]);
}

/** Shows only the last 4 characters, for display. Never log the key. */
export function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}
