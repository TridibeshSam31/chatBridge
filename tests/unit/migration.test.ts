import { describe, expect, it } from 'vitest';
import { renderContextDocument } from '../../src/core/context/render';
import { runRules } from '../../src/core/context/rules';
import { buildPlan, type PlanInput } from '../../src/core/migration/plan';
import { markInterrupted, replayableTurns, type Turn } from '../../src/core/migration/session';
import { estimateMessageTokens } from '../../src/core/token-management/estimate';
import {
  LEADING_PLACEHOLDER,
  TRAILING_PLACEHOLDER,
  mapToGeminiHistory,
} from '../../src/providers/gemini/mapper';
import { createGeminiSession, historyFor } from '../../src/providers/gemini/session';
import { PREAMBLE } from '../../src/providers/gemini/system-instruction';
import { conversationOf } from '../helpers';

const long = conversationOf(
  Array.from(
    { length: 40 },
    (_, i) => [i % 2 === 0 ? 'user' : 'assistant', `Message ${i} `.repeat(50)] as const,
  ),
);
const profile = runRules(long, 'tr');
const doc = renderContextDocument(profile, long);

const input = (patch: Partial<PlanInput> = {}): PlanInput => ({
  conversation: long,
  transcriptId: 'tr',
  profile,
  profileId: 'p1',
  contextDocument: doc,
  mode: 'full',
  provider: 'gemini',
  model: 'gemini-test',
  modelInputLimit: 1_000_000,
  budgetTokens: 200_000,
  outputReserve: 8_000,
  preambleTokens: 300,
  recentMessages: 6,
  pinned: new Set(),
  summarizeSegments: true,
  ...patch,
});

describe('buildPlan', () => {
  it('Full History includes every visible message in order when it fits', () => {
    const plan = buildPlan(input());
    expect(plan.fits).toBe(true);
    expect(plan.totals).toMatchObject({ messages: 40, included: 40, summarized: 0, excluded: 0 });
    expect(plan.entries.map((e) => e.messageId)).toEqual(long.messages.map((m) => m.id));
  });

  it('Full History refuses to truncate when over budget', () => {
    const plan = buildPlan(input({ budgetTokens: 5_000, outputReserve: 1_000 }));
    expect(plan.fits).toBe(false);
    expect(plan.totals.included).toBe(40);
    expect(plan.problems.join(' ')).toMatch(/never truncates/);
  });

  it('Smart sends the context, pinned messages verbatim, and marks the rest summarized', () => {
    const plan = buildPlan(input({ mode: 'smart', pinned: new Set(['m3']) }));
    expect(plan.totals.included).toBe(1);
    expect(plan.entries.find((e) => e.messageId === 'm3')).toMatchObject({
      status: 'included',
      reason: 'Pinned by you',
    });
    expect(plan.totals.summarized).toBe(39);
    expect(plan.contextTokens).toBeGreaterThan(0);
  });

  it('Hybrid keeps recent and pinned messages within budget and segments the rest', () => {
    const perMessage = estimateMessageTokens(long.messages[0]!);
    const plan = buildPlan(
      input({
        mode: 'hybrid',
        pinned: new Set(['m0']),
        budgetTokens: 8_000 + 300 + plan0().contextTokens + perMessage * 9 + 350 * 3,
        outputReserve: 8_000,
      }),
    );
    expect(plan.fits).toBe(true);
    const included = plan.entries.filter((e) => e.status === 'included').map((e) => e.messageId);
    expect(included).toContain('m0');
    expect(included).toContain('m39');
    for (const e of plan.entries) {
      if (e.status === 'summarized') expect(e.segment).toBeTypeOf('number');
    }
    expect(plan.segments.length).toBeGreaterThan(0);
    // Every message accounted for, with a reason.
    expect(plan.entries.every((e) => e.reason.length > 0)).toBe(true);
    expect(plan.totals.included + plan.totals.summarized + plan.totals.excluded).toBe(40);
  });

  it('marks over-budget pinned messages instead of dropping them silently', () => {
    const plan = buildPlan(
      input({
        mode: 'smart',
        pinned: new Set(['m1']),
        budgetTokens: 8_000 + 300 + plan0().contextTokens + 10,
        outputReserve: 8_000,
      }),
    );
    expect(plan.entries.find((e) => e.messageId === 'm1')!.reason).toMatch(/does not fit/);
    expect(plan.problems.join(' ')).toMatch(/pinned/);
  });

  it('requires a context profile for Smart and Hybrid', () => {
    expect(buildPlan(input({ mode: 'smart', profile: null })).problems[0]).toMatch(
      /context analysis/,
    );
  });

  it('caps the budget at the model limit and says so', () => {
    const plan = buildPlan(input({ modelInputLimit: 100_000, budgetTokens: 500_000 }));
    expect(plan.problems.join(' ')).toMatch(/model's input limit/);
    expect(plan.budget.availableForHistory).toBeLessThan(100_000);
  });

  it('excludes hidden messages with a reason', () => {
    const conv = {
      ...long,
      messages: [
        { ...long.messages[0]!, visibility: 'hidden' as const },
        ...long.messages.slice(1),
      ],
    };
    const plan = buildPlan(input({ conversation: conv }));
    expect(plan.entries[0]).toMatchObject({
      status: 'excluded',
      reason: 'Hidden in the source conversation',
    });
  });
});

function plan0() {
  return buildPlan(input({ mode: 'smart' }));
}

describe('mapToGeminiHistory', () => {
  it('maps roles and preserves order and code', () => {
    const conv = conversationOf([
      ['user', 'q'],
      ['assistant', 'a'],
      ['user', '```ts\nconst x = 1;\n```'],
    ]);
    const { history, report } = mapToGeminiHistory(conv.messages);
    expect(history.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(history[2]!.parts![0]!.text).toBe('```ts\nconst x = 1;\n```');
    expect(history[3]!.parts![0]!.text).toBe(TRAILING_PLACEHOLDER);
    expect(report.syntheticTrailingTurn).toBe(true);
  });

  it('merges same-role runs, labels tools, and starts with a user turn', () => {
    const conv = conversationOf([
      ['assistant', 'hello'],
      ['tool', 'output'],
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'ok'],
    ]);
    const { history, report } = mapToGeminiHistory(conv.messages);
    expect(history.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(history[0]!.parts![0]!.text).toBe(LEADING_PLACEHOLDER);
    expect(history[1]!.parts![0]!.text).toContain(
      '[Tool output from tool in the original conversation]',
    );
    expect(history[2]!.parts![0]!.text).toBe('one\n\ntwo');
    expect(report.merged).toBe(2);
  });

  it('moves system messages to the system instruction and skips hidden ones', () => {
    const conv = conversationOf([
      ['system', 'note'],
      ['user', 'q'],
      ['assistant', 'a'],
    ]);
    conv.messages[1] = { ...conv.messages[1]!, visibility: 'hidden' };
    const { history, systemNotes, report } = mapToGeminiHistory(conv.messages);
    expect(systemNotes).toEqual(['note']);
    expect(report.skippedHidden).toEqual(['m1']);
    expect(history.every((c) => (c.parts?.[0]?.text ?? '').length > 0)).toBe(true);
  });

  it('replaces attachments with explicit placeholders', () => {
    const conv = conversationOf([['user', 'look']]);
    conv.messages[0]!.content.push(
      { type: 'image', available: false },
      { type: 'file', name: 'a.pdf', available: false },
    );
    const { history, report } = mapToGeminiHistory(conv.messages);
    expect(history[0]!.parts![0]!.text).toContain('[Image — not transferred]');
    expect(history[0]!.parts![0]!.text).toContain('[File: a.pdf — not transferred]');
    expect(report.placeholders).toBe(2);
  });
});

describe('createGeminiSession', () => {
  it('builds history from included messages and a disclosing system instruction', () => {
    const plan = buildPlan(input({ mode: 'hybrid', budgetTokens: 20_000, outputReserve: 4_000 }));
    const session = createGeminiSession({
      plan,
      planId: 'pl',
      conversation: long,
      contextDocument: doc,
      segmentSummaries: [{ index: 0, messageIds: ['m0'], summary: 'Early part.' }],
    });
    expect(session.destinationLabel).toMatch(/not visible in gemini\.google\.com/);
    expect(session.systemInstruction.startsWith(PREAMBLE)).toBe(true);
    expect(session.systemInstruction).toContain(
      `${plan.totals.included} of 40 messages are included verbatim`,
    );
    expect(session.systemInstruction).toContain('ChatBridge-generated summaries');
    expect(historyFor(session).length).toBe(session.importedTurnCount);
  });
});

describe('session turns', () => {
  const t = (role: Turn['role'], status: Turn['status'], text = 'x'): Turn => ({
    id: Math.random().toString(),
    role,
    text,
    status,
    at: new Date().toISOString(),
  });

  it('replays only complete exchanges', () => {
    const turns = [
      t('user', 'complete'),
      t('model', 'complete'),
      t('user', 'complete'),
      t('model', 'failed', ''),
    ];
    expect(replayableTurns(turns)).toHaveLength(2);
  });

  it('marks requests left pending by a closed panel as interrupted', () => {
    const session = createGeminiSession({
      plan: buildPlan(input()),
      planId: 'p',
      conversation: long,
      contextDocument: '',
      segmentSummaries: [],
    });
    const marked = markInterrupted({
      ...session,
      turns: [t('user', 'complete'), t('model', 'pending', '')],
    });
    expect(marked.turns[1]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Interrupted'),
    });
  });
});
