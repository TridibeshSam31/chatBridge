import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import { ConversationSchema, type NormalizedConversation } from '../core/conversation/schema';
import { newId } from '../shared/hash';

/**
 * Local persistence (IndexedDB, extension origin). Stores are deliberately
 * separate: transcripts are append-only originals; context profiles, plans and
 * sessions are derived records that reference a transcript version and never
 * modify it. Shared by the side panel and the service worker.
 */

export interface TranscriptRecord {
  id: string;
  conversationKey: string;
  createdAt: string;
  conversation: NormalizedConversation;
}

export interface DerivedRecord<T> {
  id: string;
  transcriptId: string;
  createdAt: string;
  data: T;
}

export interface JobRecord {
  id: string;
  updatedAt: string;
  data: unknown;
}

interface ChatBridgeDB extends DBSchema {
  transcripts: { key: string; value: TranscriptRecord; indexes: { byConversation: string } };
  contextProfiles: {
    key: string;
    value: DerivedRecord<unknown>;
    indexes: { byTranscript: string };
  };
  migrationPlans: { key: string; value: DerivedRecord<unknown>; indexes: { byTranscript: string } };
  sessions: { key: string; value: DerivedRecord<unknown>; indexes: { byTranscript: string } };
  jobs: { key: string; value: JobRecord };
}

type DerivedStore = 'contextProfiles' | 'migrationPlans' | 'sessions';
const DERIVED_STORES: DerivedStore[] = ['contextProfiles', 'migrationPlans', 'sessions'];

let dbPromise: Promise<IDBPDatabase<ChatBridgeDB>> | null = null;

export function db(): Promise<IDBPDatabase<ChatBridgeDB>> {
  dbPromise ??= openDB<ChatBridgeDB>('chatbridge', 1, {
    upgrade(database) {
      database
        .createObjectStore('transcripts', { keyPath: 'id' })
        .createIndex('byConversation', 'conversationKey');
      for (const name of DERIVED_STORES) {
        database
          .createObjectStore(name, { keyPath: 'id' })
          .createIndex('byTranscript', 'transcriptId');
      }
      database.createObjectStore('jobs', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

/** Test hook: forget the cached connection (used with fake-indexeddb). */
export function resetDbConnection(): void {
  dbPromise = null;
}

export const conversationKey = (
  c: Pick<NormalizedConversation, 'sourceProvider' | 'conversationId'>,
) => `${c.sourceProvider}:${c.conversationId}`;

export async function saveTranscript(
  conversation: NormalizedConversation,
): Promise<TranscriptRecord> {
  const record: TranscriptRecord = {
    id: newId('tr'),
    conversationKey: conversationKey(conversation),
    createdAt: new Date().toISOString(),
    conversation: ConversationSchema.parse(conversation),
  };
  await (await db()).add('transcripts', record);
  return record;
}

export async function getTranscript(id: string): Promise<TranscriptRecord | undefined> {
  const record = await (await db()).get('transcripts', id);
  if (!record) return undefined;
  // Re-validate at the storage boundary: records may predate a schema change.
  return { ...record, conversation: ConversationSchema.parse(record.conversation) };
}

/** Lightweight listing; newest first. */
export async function listTranscripts(): Promise<
  {
    id: string;
    conversationKey: string;
    createdAt: string;
    title: string | null;
    method: string;
    completeness: string;
    messageCount: number;
  }[]
> {
  const all = await (await db()).getAll('transcripts');
  return all
    .map((r) => ({
      id: r.id,
      conversationKey: r.conversationKey,
      createdAt: r.createdAt,
      title: r.conversation.title,
      method: r.conversation.extraction.method,
      completeness: r.conversation.extraction.completeness,
      messageCount: r.conversation.messages.length,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putDerived<T>(
  store: DerivedStore,
  transcriptId: string,
  data: T,
  id = newId(store.slice(0, 2)),
) {
  const record: DerivedRecord<T> = { id, transcriptId, createdAt: new Date().toISOString(), data };
  await (await db()).put(store, record);
  return record;
}

export async function getDerived(
  store: DerivedStore,
  id: string,
): Promise<DerivedRecord<unknown> | undefined> {
  return (await db()).get(store, id);
}

export async function listDerived(
  store: DerivedStore,
  transcriptId: string,
): Promise<DerivedRecord<unknown>[]> {
  const records = await (await db()).getAllFromIndex(store, 'byTranscript', transcriptId);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAllDerived(store: DerivedStore): Promise<DerivedRecord<unknown>[]> {
  const records = await (await db()).getAll(store);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Read-modify-write inside one transaction, so concurrent appends cannot interleave. */
export async function updateDerived<T>(
  store: DerivedStore,
  id: string,
  update: (current: T) => T,
): Promise<T> {
  const tx = (await db()).transaction(store, 'readwrite');
  const record = await tx.store.get(id);
  if (!record) throw new Error(`Record ${id} not found in ${store}`);
  const data = update(record.data as T);
  await tx.store.put({ ...record, data });
  await tx.done;
  return data;
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  return (await db()).get('jobs', id);
}

export async function putJob(id: string, data: unknown): Promise<void> {
  await (await db()).put('jobs', { id, updatedAt: new Date().toISOString(), data });
}

/** Deletes a transcript and everything derived from it. */
export async function deleteTranscript(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['transcripts', ...DERIVED_STORES], 'readwrite');
  await tx.objectStore('transcripts').delete(id);
  for (const name of DERIVED_STORES) {
    const store = tx.objectStore(name);
    for (const key of await store.index('byTranscript').getAllKeys(id)) await store.delete(key);
  }
  await tx.done;
  // Checkpoints are keyed by transcript id prefix.
  const jobsTx = database.transaction('jobs', 'readwrite');
  for (const key of await jobsTx.store.getAllKeys()) {
    if (String(key).includes(id)) await jobsTx.store.delete(key);
  }
  await jobsTx.done;
}

export async function deleteAllData(): Promise<void> {
  const database = await db();
  const names = ['transcripts', ...DERIVED_STORES, 'jobs'] as const;
  const tx = database.transaction(names, 'readwrite');
  await Promise.all(names.map((n) => tx.objectStore(n).clear()));
  await tx.done;
}
