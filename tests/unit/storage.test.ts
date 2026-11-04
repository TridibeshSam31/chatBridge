import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConversationTree } from '../../src/core/import/chatgpt-export/parse';
import {
  deleteAllData,
  deleteTranscript,
  getJob,
  getTranscript,
  listDerived,
  listTranscripts,
  putDerived,
  putJob,
  resetDbConnection,
  saveTranscript,
  updateDerived,
} from '../../src/storage/db';

const conversations = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/chatgpt-export/conversations.json'),
    'utf8',
  ),
) as unknown[];
const conv = parseConversationTree(conversations[0], 'export');

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbConnection();
});

describe('transcript store', () => {
  it('keeps every extraction as a separate version', async () => {
    const a = await saveTranscript(conv);
    const b = await saveTranscript(conv);
    expect(a.id).not.toBe(b.id);
    const list = await listTranscripts();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ method: 'export', completeness: 'complete', messageCount: 9 });
    expect((await getTranscript(a.id))!.conversation).toEqual(conv);
  });

  it('refuses to store an invalid conversation', async () => {
    await expect(saveTranscript({ ...conv, messages: [{ id: '' }] } as never)).rejects.toThrow();
    expect(await listTranscripts()).toHaveLength(0);
  });

  it('keeps derived records separate and linked by transcript', async () => {
    const t = await saveTranscript(conv);
    await putDerived('contextProfiles', t.id, { summary: 'x' });
    const session = await putDerived('sessions', t.id, { turns: [] as number[] });
    await updateDerived<{ turns: number[] }>('sessions', session.id, (s) => ({
      turns: [...s.turns, 1],
    }));
    expect((await listDerived('sessions', t.id))[0]!.data).toEqual({ turns: [1] });
    expect(await listDerived('contextProfiles', t.id)).toHaveLength(1);
    // The original transcript is untouched by derived writes.
    expect((await getTranscript(t.id))!.conversation).toEqual(conv);
  });

  it('deletes a transcript with everything derived from it', async () => {
    const keep = await saveTranscript(conv);
    const drop = await saveTranscript(conv);
    await putDerived('contextProfiles', drop.id, {});
    await putDerived('contextProfiles', keep.id, {});
    await putJob(`llm:${drop.id}:0`, { done: true });
    await deleteTranscript(drop.id);
    expect((await listTranscripts()).map((t) => t.id)).toEqual([keep.id]);
    expect(await listDerived('contextProfiles', drop.id)).toHaveLength(0);
    expect(await listDerived('contextProfiles', keep.id)).toHaveLength(1);
    expect(await getJob(`llm:${drop.id}:0`)).toBeUndefined();
  });

  it('deletes all data', async () => {
    const t = await saveTranscript(conv);
    await putDerived('sessions', t.id, {});
    await deleteAllData();
    expect(await listTranscripts()).toHaveLength(0);
    expect(await listDerived('sessions', t.id)).toHaveLength(0);
  });
});
