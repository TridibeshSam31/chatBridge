import { z } from 'zod';

/**
 * Provider-independent conversation format. Every source adapter produces it and
 * every destination adapter consumes it; neither ChatGPT nor Gemini concepts leak
 * in beyond free-form `metadata`.
 */

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), format: z.enum(['markdown', 'plain']) }),
  z.object({ type: z.literal('code'), text: z.string(), language: z.string().optional() }),
  z.object({
    type: z.literal('image'),
    ref: z.string().optional(),
    alt: z.string().optional(),
    /** Whether the bytes can be fetched and re-sent. Source file pointers usually cannot. */
    available: z.boolean(),
  }),
  z.object({
    type: z.literal('file'),
    name: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    available: z.boolean(),
  }),
  z.object({ type: z.literal('unsupported'), originalType: z.string(), description: z.string() }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const RoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: RoleSchema,
  content: z.array(ContentBlockSchema),
  timestamp: z.iso.datetime().optional(),
  /** Hidden messages exist in the source but were never shown in its UI. */
  visibility: z.enum(['visible', 'hidden']),
  provenance: z.object({
    sourceNodeId: z.string().optional(),
    parentId: z.string().optional(),
    /** Number of alternatives at this point (edits / regenerations), including this one. */
    siblingCount: z.number().int().positive().optional(),
    branchIndex: z.number().int().nonnegative().optional(),
  }),
  contentHash: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});
export type NormalizedMessage = z.infer<typeof MessageSchema>;

export const ExtractionMethodSchema = z.enum(['dom', 'export', 'internal-api']);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const CompletenessSchema = z.enum(['complete', 'partial', 'unknown']);
export type Completeness = z.infer<typeof CompletenessSchema>;

export const ExtractionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  messageIds: z.array(z.string()).optional(),
});
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;

export const ExcludedItemSchema = z.object({
  sourceNodeId: z.string(),
  role: z.string().optional(),
  contentType: z.string().optional(),
  reason: z.string(),
});
export type ExcludedItem = z.infer<typeof ExcludedItemSchema>;

export const ExtractionReportSchema = z.object({
  method: ExtractionMethodSchema,
  completeness: CompletenessSchema,
  /** Human-readable reasons for the completeness verdict. */
  completenessReasons: z.array(z.string()),
  extractedAt: z.iso.datetime(),
  warnings: z.array(ExtractionWarningSchema),
  /** Source items deliberately not turned into messages. Never dropped silently. */
  excluded: z.array(ExcludedItemSchema),
  /** Messages on other branches (edits, regenerations) that were not selected. */
  offPathMessages: z.number().int().nonnegative(),
});
export type ExtractionReport = z.infer<typeof ExtractionReportSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

export const UserContextSchema = z.object({
  /** e.g. "custom-instructions" */
  kind: z.string(),
  label: z.string(),
  text: z.string(),
  sourceMessageId: z.string().optional(),
});
export type UserContext = z.infer<typeof UserContextSchema>;

export const ConversationSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: z.string().min(1),
  title: z.string().nullable(),
  sourceProvider: z.string().min(1),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  messages: z.array(MessageSchema),
  attachments: z.array(AttachmentSchema),
  /** Standing user context from the source (e.g. custom instructions). */
  userContext: z.array(UserContextSchema),
  extraction: ExtractionReportSchema,
  metadata: z.record(z.string(), z.unknown()),
});
export type NormalizedConversation = z.infer<typeof ConversationSchema>;

/** Plain text of a message: text and code blocks, placeholders for the rest. */
export function messageText(message: Pick<NormalizedMessage, 'content'>): string {
  return message.content.map(blockText).join('\n\n');
}

export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'code':
      return '```' + (block.language ?? '') + '\n' + block.text + '\n```';
    case 'image':
      return `[Image${block.alt ? `: ${block.alt}` : ''} — not transferred]`;
    case 'file':
      return `[File: ${block.name}${block.mimeType ? ` (${block.mimeType})` : ''} — not transferred]`;
    case 'unsupported':
      return `[Unsupported content: ${block.originalType} — ${block.description}]`;
  }
}
