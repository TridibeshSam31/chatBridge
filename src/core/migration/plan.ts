import { z } from 'zod';
import type { NormalizedConversation, NormalizedMessage } from '../conversation/schema';
import type { ContextProfile } from '../context/schema';
import { CATEGORIES, activeItems } from '../context/schema';
import { estimateMessageTokens, estimateTextTokens } from '../token-management/estimate';

/**
 * Migration planning: a pure, previewable description of exactly what will be
 * sent. Every message gets a status and a reason. Nothing is silently dropped,
 * and Full History never truncates — it reports that it does not fit instead.
 */

export const ModeSchema = z.enum(['full', 'smart', 'hybrid']);
export type MigrationMode = z.infer<typeof ModeSchema>;

export const PlanEntrySchema = z.object({
  messageId: z.string(),
  role: z.string(),
  status: z.enum(['included', 'summarized', 'excluded']),
  reason: z.string(),
  tokens: z.number().int().nonnegative(),
  segment: z.number().int().nonnegative().optional(),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const SegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  messageIds: z.array(z.string()).min(1),
  tokens: z.number().int().nonnegative(),
});

export const MigrationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  transcriptId: z.string(),
  profileId: z.string().nullable(),
  mode: ModeSchema,
  provider: z.string(),
  model: z.string(),
  createdAt: z.iso.datetime(),
  budget: z.object({
    requested: z.number().int().positive(),
    modelInputLimit: z.number().int().positive().nullable(),
    outputReserve: z.number().int().nonnegative(),
    /** Tokens left for history after the fixed parts. */
    availableForHistory: z.number().int(),
  }),
  contextTokens: z.number().int().nonnegative(),
  preambleTokens: z.number().int().nonnegative(),
  summarizeSegments: z.boolean(),
  entries: z.array(PlanEntrySchema),
  segments: z.array(SegmentSchema),
  totals: z.object({
    messages: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    summarized: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    historyTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  fits: z.boolean(),
  problems: z.array(z.string()),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

export interface PlanInput {
  conversation: NormalizedConversation;
  transcriptId: string;
  profile: ContextProfile | null;
  profileId: string | null;
  contextDocument: string;
  mode: MigrationMode;
  provider: string;
  model: string;
  modelInputLimit: number | null;
  budgetTokens: number;
  outputReserve: number;
  preambleTokens: number;
  /** Hybrid: number of most recent messages kept verbatim. */
  recentMessages: number;
  pinned: ReadonlySet<string>;
  /** Hybrid: summarize omitted segments (requires an LLM call at migration time). */
  summarizeSegments: boolean;
}

/** Tokens reserved per segment summary inserted into the system instruction. */
export const SEGMENT_SUMMARY_TOKENS = 350;

const EVIDENCE_CATEGORIES = [
  'decisions',
  'constraints',
  'explicitInstructions',
  'userPreferences',
  'communicationStyle',
  'unresolvedIssues',
  'currentTask',
  'architecture',
] as const;

export function buildPlan(input: PlanInput): MigrationPlan {
  const { conversation, mode } = input;
  const problems: string[] = [];
  const usesContext = mode !== 'full' || input.profile !== null;
  const contextTokens =
    usesContext && input.contextDocument ? estimateTextTokens(input.contextDocument) : 0;
  if (mode !== 'full' && input.profile === null) {
    problems.push('Smart and Hybrid migration need a context analysis. Run the analysis first.');
  }

  const hardLimit = input.modelInputLimit ?? Number.POSITIVE_INFINITY;
  if (input.budgetTokens > hardLimit)
    problems.push(
      `The budget is larger than the model's input limit (${hardLimit.toLocaleString()} tokens); the model limit applies.`,
    );
  const ceiling = Math.min(input.budgetTokens, hardLimit);
  const available = Math.floor(
    ceiling - input.outputReserve - input.preambleTokens - contextTokens,
  );

  const tokens = new Map(conversation.messages.map((m) => [m.id, estimateMessageTokens(m)]));
  const visible = conversation.messages.filter((m) => m.visibility === 'visible');
  const included = new Set<string>();
  const reasons = new Map<string, string>();

  if (mode === 'full') {
    for (const m of visible) {
      included.add(m.id);
      reasons.set(m.id, 'Original message, in order');
    }
  } else {
    const priority: [NormalizedMessage, string][] = [];
    const queued = new Set<string>();
    const queue = (m: NormalizedMessage | undefined, reason: string) => {
      if (m && !queued.has(m.id)) {
        queued.add(m.id);
        priority.push([m, reason]);
      }
    };
    for (const m of visible) if (input.pinned.has(m.id)) queue(m, 'Pinned by you');
    if (mode === 'hybrid') {
      const byId = new Map(visible.map((m) => [m.id, m]));
      const cited = new Set<string>();
      for (const c of EVIDENCE_CATEGORIES) {
        for (const item of activeItems(input.profile?.items[c] ?? []))
          for (const e of item.evidence) cited.add(e.messageId);
      }
      // Recent messages first (they matter most for continuing), then cited evidence.
      for (const m of visible.slice(-input.recentMessages).reverse()) queue(m, 'Recent message');
      for (const id of cited) queue(byId.get(id), 'Evidence for a context item');
    }

    let used = 0;
    const segmentReserve = () =>
      mode === 'hybrid' && input.summarizeSegments
        ? segmentsOf(visible, included).length * SEGMENT_SUMMARY_TOKENS
        : 0;
    for (const [m, reason] of priority) {
      const cost = tokens.get(m.id)!;
      included.add(m.id);
      if (used + cost + segmentReserve() > available) {
        included.delete(m.id);
        reasons.set(m.id, `${reason}, but it does not fit in the budget`);
        if (input.pinned.has(m.id)) problems.push('Some pinned messages do not fit in the budget.');
        continue;
      }
      used += cost;
      reasons.set(m.id, reason);
    }
  }

  const segments = mode === 'hybrid' ? segmentsOf(visible, included) : [];
  const segmentOf = new Map(
    segments.flatMap((s) => s.messageIds.map((id) => [id, s.index] as const)),
  );

  const entries: PlanEntry[] = conversation.messages.map((m) => {
    const base = { messageId: m.id, role: m.role, tokens: tokens.get(m.id)! };
    if (m.visibility === 'hidden') {
      return {
        ...base,
        status: 'excluded',
        reason: conversation.userContext.some((c) => c.sourceMessageId === m.id)
          ? 'Hidden in the source; carried as standing user context instead'
          : 'Hidden in the source conversation',
      };
    }
    if (included.has(m.id)) return { ...base, status: 'included', reason: reasons.get(m.id)! };
    if (mode === 'smart') {
      return {
        ...base,
        status: 'summarized',
        reason: reasons.get(m.id) ?? 'Represented by the context profile, not sent verbatim',
      };
    }
    const segment = segmentOf.get(m.id);
    if (mode === 'hybrid' && input.summarizeSegments && segment !== undefined) {
      return {
        ...base,
        status: 'summarized',
        segment,
        reason: reasons.get(m.id) ?? `Summarized in segment ${segment + 1}`,
      };
    }
    return {
      ...base,
      status: 'excluded',
      reason: reasons.get(m.id) ?? 'Over budget; represented only by the context profile',
    };
  });

  const historyTokens = entries
    .filter((e) => e.status === 'included')
    .reduce((a, e) => a + e.tokens, 0);
  const summaryTokens = input.summarizeSegments ? segments.length * SEGMENT_SUMMARY_TOKENS : 0;
  const totalTokens = historyTokens + summaryTokens + contextTokens + input.preambleTokens;
  const fits = historyTokens + summaryTokens <= available && available > 0;
  if (!fits) {
    problems.push(
      mode === 'full'
        ? `The full history (~${historyTokens.toLocaleString()} tokens) does not fit the budget (~${Math.max(0, available).toLocaleString()} tokens for history). Full History never truncates: choose Smart or Hybrid, or raise the budget.`
        : `The selected content does not fit the budget (~${Math.max(0, available).toLocaleString()} tokens available).`,
    );
  }
  if (
    CATEGORIES.every((c) => (input.profile?.items[c].length ?? 0) === 0) &&
    mode !== 'full' &&
    input.profile
  ) {
    problems.push(
      'The context analysis found nothing; Smart migration would carry almost no context.',
    );
  }

  const count = (s: PlanEntry['status']) => entries.filter((e) => e.status === s).length;
  return MigrationPlanSchema.parse({
    schemaVersion: 1,
    transcriptId: input.transcriptId,
    profileId: input.profileId,
    mode,
    provider: input.provider,
    model: input.model,
    createdAt: new Date().toISOString(),
    budget: {
      requested: input.budgetTokens,
      modelInputLimit: input.modelInputLimit,
      outputReserve: input.outputReserve,
      availableForHistory: available,
    },
    contextTokens,
    preambleTokens: input.preambleTokens,
    summarizeSegments: mode === 'hybrid' && input.summarizeSegments,
    entries,
    segments: segments.map((s) => ({
      ...s,
      tokens: s.messageIds.reduce((a, id) => a + tokens.get(id)!, 0),
    })),
    totals: {
      messages: entries.length,
      included: count('included'),
      summarized: count('summarized'),
      excluded: count('excluded'),
      historyTokens,
      totalTokens,
    },
    fits,
    problems: [...new Set(problems)],
  } satisfies MigrationPlan);
}

/** Contiguous runs of visible messages that are not included. */
function segmentsOf(visible: NormalizedMessage[], included: ReadonlySet<string>) {
  const segments: { index: number; messageIds: string[]; tokens: number }[] = [];
  let current: string[] = [];
  for (const m of visible) {
    if (included.has(m.id)) {
      if (current.length) segments.push({ index: segments.length, messageIds: current, tokens: 0 });
      current = [];
    } else current.push(m.id);
  }
  if (current.length) segments.push({ index: segments.length, messageIds: current, tokens: 0 });
  return segments;
}
