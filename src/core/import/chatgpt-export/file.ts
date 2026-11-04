import { unzipSync } from 'fflate';
import { ConversationParseError } from './parse';

export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const CONVERSATIONS_FILE = /(^|\/)conversations(-\d+)?\.json$/;

/**
 * Reads a ChatGPT data export: either the downloaded .zip or the extracted
 * conversations.json. Only the conversation file(s) are decompressed; images and
 * other files in the archive are never read.
 */
export async function readExportFile(file: Blob & { name?: string }): Promise<unknown[]> {
  if (file.size > MAX_EXPORT_BYTES) {
    throw new ConversationParseError(
      'The file is larger than 1 GB, which ChatBridge cannot read safely in the browser.',
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  const texts: string[] = [];
  if (isZip) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, { filter: (f) => CONVERSATIONS_FILE.test(f.name) });
    } catch (err) {
      throw new ConversationParseError(
        'The .zip file could not be opened. Is it a complete ChatGPT export?',
        { cause: err },
      );
    }
    const names = Object.keys(entries).sort();
    if (names.length === 0)
      throw new ConversationParseError('No conversations.json found in this .zip file.');
    const decoder = new TextDecoder();
    for (const name of names) texts.push(decoder.decode(entries[name]));
  } else {
    texts.push(new TextDecoder().decode(bytes));
  }

  const conversations: unknown[] = [];
  for (const text of texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConversationParseError(
        'The file is not valid JSON. Choose conversations.json or the export .zip.',
        { cause: err },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ConversationParseError(
        'conversations.json must contain an array of conversations.',
      );
    }
    conversations.push(...(parsed as unknown[]));
  }
  return conversations;
}
