import type { Content } from '@google/genai';
import type { NormalizedConversation } from '../../core/conversation/schema';
import type { MigrationPlan } from '../../core/migration/plan';
import {
  type Session,
  SessionSchema,
  type Turn,
  replayableTurns,
} from '../../core/migration/session';
import type { SegmentSummary } from '../../core/migration/summarize';
import { styleGuideFor } from '../../core/context/style';
import { newId } from '../../shared/hash';
import { type GeminiClient, GeminiError, toGeminiError } from './client';
import { mapToGeminiHistory } from './mapper';
import { buildSystemInstruction } from './system-instruction';

export const GEMINI_DESTINATION_LABEL =
  'Gemini API chat in ChatBridge — not visible in gemini.google.com';

/** Builds a new session from a plan. Pure: persisting it is the caller's job. */
export function createGeminiSession(input: {
  plan: MigrationPlan;
  planId: string;
  conversation: NormalizedConversation;
  contextDocument: string;
  segmentSummaries: SegmentSummary[];
}): Session {
  const includedIds = new Set(
    input.plan.entries.filter((e) => e.status === 'included').map((e) => e.messageId),
  );
  const messages = input.conversation.messages.filter((m) => includedIds.has(m.id));
  const { history, systemNotes, report } = mapToGeminiHistory(messages);
  const systemInstruction = buildSystemInstruction({
    plan: input.plan,
    conversation: input.conversation,
    contextDocument:
      input.plan.mode === 'full' && input.plan.profileId === null ? '' : input.contextDocument,
    styleGuide: styleGuideFor(input.conversation, includedIds),
    segmentSummaries: input.segmentSummaries,
    mapReport: report,
    systemNotes,
  });
  return SessionSchema.parse({
    schemaVersion: 1,
    provider: 'gemini',
    destinationLabel: GEMINI_DESTINATION_LABEL,
    model: input.plan.model,
    planId: input.planId,
    transcriptId: input.plan.transcriptId,
    title: input.conversation.title,
    createdAt: new Date().toISOString(),
    systemInstruction,
    importedHistory: history,
    importedTurnCount: history.length,
    mapReport: report as unknown as Record<string, unknown>,
    turns: [],
  } satisfies Session);
}

export function historyFor(session: Session): Content[] {
  return [
    ...(session.importedHistory as Content[]),
    ...replayableTurns(session.turns).map((t): Content => ({
      role: t.role,
      parts: [{ text: t.text }],
    })),
  ];
}

export interface SessionStore {
  update(id: string, fn: (s: Session) => Session): Promise<Session>;
}

/**
 * Sends one user message. The user turn and a pending model turn are persisted
 * before the request, so a closed panel leaves a visible, retryable record.
 */
export async function sendTurn(params: {
  sessionId: string;
  session: Session;
  text: string;
  client: GeminiClient;
  store: SessionStore;
  onDelta?: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<Session> {
  const { store, sessionId } = params;
  const history = historyFor(params.session);
  const now = () => new Date().toISOString();
  const userTurn: Turn = {
    id: newId('turn'),
    role: 'user',
    text: params.text,
    status: 'complete',
    at: now(),
  };
  const modelTurn: Turn = {
    id: newId('turn'),
    role: 'model',
    text: '',
    status: 'pending',
    at: now(),
  };
  await store.update(sessionId, (s) => ({ ...s, turns: [...s.turns, userTurn, modelTurn] }));

  let text = '';
  try {
    for await (const delta of params.client.streamChat({
      model: params.session.model,
      history,
      systemInstruction: params.session.systemInstruction,
      message: params.text,
      ...(params.signal ? { signal: params.signal } : {}),
    })) {
      text += delta;
      params.onDelta?.(text);
    }
  } catch (raw) {
    const err = toGeminiError(raw);
    await store.update(sessionId, (s) =>
      setTurn(s, modelTurn.id, { text, status: text ? 'partial' : 'failed', error: err.message }),
    );
    throw err;
  }
  return store.update(sessionId, (s) => setTurn(s, modelTurn.id, { text, status: 'complete' }));
}

/** Retries the last failed exchange: removes it and sends the same user text again. */
export async function retryLast(
  params: Omit<Parameters<typeof sendTurn>[0], 'text'>,
): Promise<Session> {
  const turns = params.session.turns;
  const last = turns.at(-1);
  const user = turns.at(-2);
  if (
    !last ||
    !user ||
    last.role !== 'model' ||
    last.status === 'complete' ||
    user.role !== 'user'
  ) {
    throw new GeminiError('BAD_REQUEST', 'nothing to retry');
  }
  const trimmed = await params.store.update(params.sessionId, (s) => ({
    ...s,
    turns: s.turns.slice(0, -2),
  }));
  return sendTurn({ ...params, session: trimmed, text: user.text });
}

function setTurn(session: Session, id: string, patch: Partial<Turn>): Session {
  return { ...session, turns: session.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}
