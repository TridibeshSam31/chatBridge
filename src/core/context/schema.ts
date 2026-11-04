import { z } from 'zod';

/**
 * Structured, evidence-linked context derived from one transcript version.
 *
 * Status semantics:
 * - confirmed: the user stated it, or explicitly accepted an assistant proposal.
 * - proposed: only the assistant suggested it; not user-approved.
 * - inferred: ChatBridge derived it heuristically; needs confirmation.
 * - superseded: a later explicit statement replaced it (kept, never deleted).
 * - contradicted: conflicts with another item and could not be resolved.
 */

export const CATEGORIES = [
  'objective',
  'technologyStack',
  'architecture',
  'implementedFeatures',
  'pendingFeatures',
  'decisions',
  'constraints',
  'userPreferences',
  'communicationStyle',
  'explicitInstructions',
  'attemptedSolutions',
  'knownBugs',
  'unresolvedIssues',
  'currentTask',
  'nextAction',
  'importantHistoricalFacts',
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  objective: 'Objective',
  technologyStack: 'Technology stack',
  architecture: 'Architecture',
  implementedFeatures: 'Implemented',
  pendingFeatures: 'Pending',
  decisions: 'Decisions',
  constraints: 'Constraints',
  userPreferences: 'User preferences',
  communicationStyle: 'Communication style',
  explicitInstructions: 'Explicit instructions',
  attemptedSolutions: 'Attempted solutions',
  knownBugs: 'Known bugs',
  unresolvedIssues: 'Unresolved issues',
  currentTask: 'Current task',
  nextAction: 'Next action',
  importantHistoricalFacts: 'Important historical facts',
};

export const StatusSchema = z.enum([
  'confirmed',
  'proposed',
  'inferred',
  'superseded',
  'contradicted',
]);
export type ItemStatus = z.infer<typeof StatusSchema>;

export const EvidenceSchema = z.object({
  messageId: z.string(),
  quote: z.string().max(400).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ContextItemSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  status: StatusSchema,
  source: z.enum(['rules', 'llm', 'custom-instructions']),
  evidence: z.array(EvidenceSchema),
  supersededBy: z.string().optional(),
  conflictsWith: z.array(z.string()).optional(),
  /** For bugs/issues: whether a later message reported it fixed. */
  resolved: z.boolean().optional(),
  /** Position of the latest evidence in the transcript, for recency ordering. */
  order: z.number().int().nonnegative(),
});
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const ContextStatsSchema = z.object({
  messagesAnalyzed: z.number().int().nonnegative(),
  droppedForMissingEvidence: z.number().int().nonnegative(),
  droppedForUnverifiedQuote: z.number().int().nonnegative(),
  downgradedAssistantOnly: z.number().int().nonnegative(),
  truncatedForAnalysis: z.number().int().nonnegative(),
  llmChunks: z.number().int().nonnegative(),
});
export type ContextStats = z.infer<typeof ContextStatsSchema>;

export const ContextProfileSchema = z.object({
  schemaVersion: z.literal(1),
  transcriptId: z.string(),
  generatedAt: z.iso.datetime(),
  passes: z.array(z.enum(['rules', 'llm'])),
  model: z.string().optional(),
  conversationSummary: z.string(),
  items: z.record(CategorySchema, z.array(ContextItemSchema)),
  stats: ContextStatsSchema,
});
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

export function emptyItems(): Record<Category, ContextItem[]> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, []])) as unknown as Record<
    Category,
    ContextItem[]
  >;
}

export function emptyStats(): ContextStats {
  return {
    messagesAnalyzed: 0,
    droppedForMissingEvidence: 0,
    droppedForUnverifiedQuote: 0,
    downgradedAssistantOnly: 0,
    truncatedForAnalysis: 0,
    llmChunks: 0,
  };
}

/** Active items exclude superseded ones; contradicted items stay visible. */
export function activeItems(items: ContextItem[]): ContextItem[] {
  return items.filter((i) => i.status !== 'superseded');
}

/** The specification's nested JSON shape, for export and inspection. */
export function toSpecShape(profile: ContextProfile) {
  const texts = (c: Category) => activeItems(profile.items[c]).map((i) => i.text);
  const first = (c: Category) => activeItems(profile.items[c]).at(-1)?.text ?? '';
  return {
    conversationSummary: profile.conversationSummary,
    projectContext: {
      objective: first('objective'),
      technologyStack: texts('technologyStack'),
      architecture: texts('architecture'),
      implementedFeatures: texts('implementedFeatures'),
      pendingFeatures: texts('pendingFeatures'),
    },
    decisions: texts('decisions'),
    constraints: texts('constraints'),
    userPreferences: texts('userPreferences'),
    communicationStyle: texts('communicationStyle'),
    explicitInstructions: texts('explicitInstructions'),
    unresolvedIssues: texts('unresolvedIssues'),
    currentTask: first('currentTask'),
    nextAction: first('nextAction'),
    importantHistoricalFacts: texts('importantHistoricalFacts'),
  };
}
