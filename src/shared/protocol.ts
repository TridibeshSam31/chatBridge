import { z } from 'zod';

/**
 * Messages between extension pages and content scripts. Every message crossing a
 * context boundary is validated with these schemas on the receiving side.
 */

export const PROTOCOL_VERSION = 1;

export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chatbridge/ping'), protocol: z.literal(PROTOCOL_VERSION) }),
  z.object({ type: z.literal('chatbridge/detect'), protocol: z.literal(PROTOCOL_VERSION) }),
  z.object({
    type: z.literal('chatbridge/diagnose-dom'),
    protocol: z.literal(PROTOCOL_VERSION),
    /** Scrolls the conversation top to bottom (then restores) to test lazy loading. */
    scrollTest: z.boolean(),
  }),
  z.object({
    type: z.literal('chatbridge/diagnose-endpoint'),
    protocol: z.literal(PROTOCOL_VERSION),
    /** The unofficial endpoint is never contacted without this explicit flag. */
    consent: z.literal(true),
  }),
  z.object({
    type: z.literal('chatbridge/extract-dom'),
    protocol: z.literal(PROTOCOL_VERSION),
    scroll: z.boolean(),
  }),
  z.object({
    type: z.literal('chatbridge/extract-endpoint'),
    protocol: z.literal(PROTOCOL_VERSION),
    consent: z.literal(true),
  }),
]);
export type Request = z.infer<typeof RequestSchema>;

/** Content script → service worker: persist an extracted transcript. */
export const StoreTranscriptRequestSchema = z.object({
  type: z.literal('chatbridge/store-transcript'),
  protocol: z.literal(PROTOCOL_VERSION),
  conversation: z.unknown(),
});

export const ExtractResultSchema = z.object({
  transcriptId: z.string(),
  messageCount: z.number().int().nonnegative(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export const DetectedConversationSchema = z.object({
  provider: z.literal('chatgpt'),
  url: z.string(),
  /** null on the ChatGPT home page, a new chat, or a temporary chat. */
  conversationId: z.string().nullable(),
  title: z.string().nullable(),
  /**
   * Messages currently rendered in the DOM. ChatGPT may lazy-load long
   * conversations, so this is a lower bound, not the conversation's length.
   */
  renderedMessageCount: z.number().int().nonnegative(),
  renderedRoleCounts: z.object({
    user: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  /** Which selector strategy found messages; null if none matched. */
  selectorStrategy: z.string().nullable(),
});
export type DetectedConversation = z.infer<typeof DetectedConversationSchema>;

export const ErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNSUPPORTED_PROTOCOL',
  'NO_CONVERSATION',
  'NO_MESSAGES',
  'ENDPOINT_DISABLED',
  'ENDPOINT_UNAVAILABLE',
  'PARSE_FAILED',
  'STORAGE_FAILED',
  'INTERNAL',
]);

const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});

export const PingResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({ provider: z.literal('chatgpt') }) }),
  ErrorResponseSchema,
]);

export const DetectResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: DetectedConversationSchema }),
  ErrorResponseSchema,
]);
export type DetectResponse = z.infer<typeof DetectResponseSchema>;

/**
 * Diagnostic reports are free-form structural JSON built from redacted values;
 * only the envelope is validated here. The panel shows them as text, never as HTML.
 */
export const DiagnosticResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.looseObject({ kind: z.string() }) }),
  ErrorResponseSchema,
]);

export const ExtractResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: ExtractResultSchema }),
  ErrorResponseSchema,
]);

export const StoreTranscriptResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({ transcriptId: z.string() }) }),
  ErrorResponseSchema,
]);

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
