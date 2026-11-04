import type { NormalizedConversation } from '../core/conversation/schema';
import { runLlmPass } from '../core/context/llm';
import { renderContextDocument } from '../core/context/render';
import { runRules } from '../core/context/rules';
import { type ContextProfile, ContextProfileSchema } from '../core/context/schema';
import { readExportFile } from '../core/import/chatgpt-export/file';
import {
  listExportConversations,
  parseConversationTree,
} from '../core/import/chatgpt-export/parse';
import { type MigrationPlan, MigrationPlanSchema } from '../core/migration/plan';
import { type Session, SessionSchema, markInterrupted } from '../core/migration/session';
import { summarizeSegments } from '../core/migration/summarize';
import { estimateTextTokens } from '../core/token-management/estimate';
import { ExtractResponseSchema, PROTOCOL_VERSION } from '../shared/protocol';
import { GeminiClient, GeminiError, type ModelInfo } from '../providers/gemini/client';
import { createGeminiSession, retryLast, sendTurn } from '../providers/gemini/session';
import { PREAMBLE } from '../providers/gemini/system-instruction';
import {
  type TranscriptRecord,
  getDerived,
  getJob,
  getTranscript,
  listAllDerived,
  listDerived,
  putDerived,
  putJob,
  saveTranscript,
  updateDerived,
} from '../storage/db';
import { getApiKey } from '../storage/settings';
import { requestTab } from './tab-bridge';

/** Glue between the UI and the platform-free core. Every external result is validated. */

export async function extractFromTab(tabId: number, method: 'dom' | 'dom-scroll' | 'endpoint') {
  return requestTab(
    tabId,
    method === 'endpoint'
      ? { type: 'chatbridge/extract-endpoint', protocol: PROTOCOL_VERSION, consent: true }
      : {
          type: 'chatbridge/extract-dom',
          protocol: PROTOCOL_VERSION,
          scroll: method === 'dom-scroll',
        },
    ExtractResponseSchema,
  );
}

export async function openExport(file: File) {
  const conversations = await readExportFile(file);
  return { conversations, entries: listExportConversations(conversations) };
}

export async function importConversation(raw: unknown): Promise<TranscriptRecord> {
  return saveTranscript(parseConversationTree(raw, 'export'));
}

export async function loadTranscript(id: string): Promise<TranscriptRecord> {
  const record = await getTranscript(id);
  if (!record) throw new Error('This transcript no longer exists (it may have been deleted).');
  return record;
}

export interface StoredProfile {
  id: string;
  profile: ContextProfile;
}

export async function latestProfile(transcriptId: string): Promise<StoredProfile | null> {
  for (const record of await listDerived('contextProfiles', transcriptId)) {
    const parsed = ContextProfileSchema.safeParse(record.data);
    if (parsed.success) return { id: record.id, profile: parsed.data };
    console.warn('[ChatBridge] skipping an invalid stored context profile');
  }
  return null;
}

export async function analyzeLocally(record: TranscriptRecord): Promise<StoredProfile> {
  const profile = runRules(record.conversation, record.id);
  const saved = await putDerived('contextProfiles', record.id, profile);
  return { id: saved.id, profile };
}

export async function requireClient(): Promise<GeminiClient> {
  const key = await getApiKey();
  if (!key) throw new GeminiError('INVALID_KEY', 'no API key set — add one in Settings');
  return new GeminiClient(key);
}

const checkpoints = {
  get: async (key: string) => (await getJob(key))?.data,
  put: (key: string, value: unknown) => putJob(key, value),
};

export async function analyzeWithGemini(
  record: TranscriptRecord,
  model: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<StoredProfile> {
  const client = await requireClient();
  // Always build on a fresh rules pass so repeated runs don't stack on each other.
  const base = runRules(record.conversation, record.id);
  const profile = await runLlmPass(record.conversation, base, client.structured(model), {
    checkpoints,
    signal,
    onProgress,
  });
  const saved = await putDerived('contextProfiles', record.id, profile);
  return { id: saved.id, profile };
}

let modelCache: Promise<ModelInfo[]> | null = null;
export function listModels(refresh = false): Promise<ModelInfo[]> {
  if (refresh || !modelCache) {
    modelCache = requireClient().then((c) => c.listModels());
    modelCache.catch(() => (modelCache = null));
  }
  return modelCache;
}

export const PREAMBLE_TOKENS = estimateTextTokens(PREAMBLE) + 200;

export function contextDocumentFor(
  profile: ContextProfile | null,
  conversation: NormalizedConversation,
) {
  return profile ? renderContextDocument(profile, conversation) : '';
}

/** Saves the plan, summarizes omitted segments if requested, and creates the session. */
export async function startMigration(params: {
  plan: MigrationPlan;
  conversation: NormalizedConversation;
  contextDocument: string;
  onStatus: (status: string) => void;
  signal: AbortSignal;
}): Promise<string> {
  const plan = MigrationPlanSchema.parse(params.plan);
  if (!plan.fits) throw new Error('This plan does not fit the budget; adjust it before starting.');
  params.onStatus('Saving the migration plan…');
  const savedPlan = await putDerived('migrationPlans', plan.transcriptId, plan);

  let summaries: Awaited<ReturnType<typeof summarizeSegments>> = [];
  if (plan.summarizeSegments && plan.segments.length > 0) {
    const client = await requireClient();
    summaries = await summarizeSegments(plan, params.conversation, client.structured(plan.model), {
      checkpoints,
      signal: params.signal,
      onProgress: (d, t) => params.onStatus(`Summarizing omitted parts with Gemini… ${d}/${t}`),
    });
  }
  params.onStatus('Creating the Gemini session…');
  const session = createGeminiSession({
    plan,
    planId: savedPlan.id,
    conversation: params.conversation,
    contextDocument: params.contextDocument,
    segmentSummaries: summaries,
  });
  const saved = await putDerived('sessions', plan.transcriptId, session);
  return saved.id;
}

export async function loadSession(id: string): Promise<Session> {
  const record = await getDerived('sessions', id);
  if (!record) throw new Error('This chat no longer exists.');
  const session = SessionSchema.parse(record.data);
  if (session.turns.some((t) => t.status === 'pending')) {
    // Pending turns on load mean a previous panel was closed mid-request.
    return updateDerived<Session>('sessions', id, (s) => markInterrupted(SessionSchema.parse(s)));
  }
  return session;
}

export async function listSessions() {
  return (await listAllDerived('sessions'))
    .map((r) => ({
      id: r.id,
      transcriptId: r.transcriptId,
      createdAt: r.createdAt,
      session: SessionSchema.safeParse(r.data),
    }))
    .filter((r) => r.session.success)
    .map((r) => ({ id: r.id, createdAt: r.createdAt, session: r.session.data! }));
}

const sessionStore = {
  update: (id: string, fn: (s: Session) => Session) =>
    updateDerived<Session>('sessions', id, (s) => fn(SessionSchema.parse(s))),
};

export async function chatSend(
  sessionId: string,
  session: Session,
  text: string,
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  return sendTurn({
    sessionId,
    session,
    text,
    client: await requireClient(),
    store: sessionStore,
    onDelta,
    signal,
  });
}

export async function chatRetry(
  sessionId: string,
  session: Session,
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  return retryLast({
    sessionId,
    session,
    client: await requireClient(),
    store: sessionStore,
    onDelta,
    signal,
  });
}
