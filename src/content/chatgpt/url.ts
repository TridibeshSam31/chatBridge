const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

// Matches /c/<id> anywhere in the path, which also covers GPT and project
// conversations such as /g/g-p-abc123/c/<id>.
const CONVERSATION_PATH =
  /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function isChatGptUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && CHATGPT_HOSTS.has(url.hostname);
  } catch {
    // Not a parseable URL (e.g. undefined-ish or chrome:// edge cases) is simply "not ChatGPT".
    return false;
  }
}

export function parseConversationId(rawUrl: string): string | null {
  if (!isChatGptUrl(rawUrl)) return null;
  const match = CONVERSATION_PATH.exec(new URL(rawUrl).pathname);
  return match?.[1]?.toLowerCase() ?? null;
}
