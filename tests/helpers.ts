import type { NormalizedConversation, NormalizedMessage } from '../src/core/conversation/schema';

/** Builds a schema-valid conversation from [role, text] pairs; text starting with ``` becomes a code block. */
export function conversationOf(
  turns: [NormalizedMessage['role'], string][],
  extra: Partial<NormalizedConversation> = {},
): NormalizedConversation {
  return {
    schemaVersion: 1,
    conversationId: 'c1',
    title: 'Test',
    sourceProvider: 'chatgpt',
    messages: turns.map(([role, text], i) => ({
      id: `m${i}`,
      role,
      content: text.startsWith('```')
        ? [
            {
              type: 'code',
              text: text.replace(/^```\w*\n|\n?```$/g, ''),
              language: /^```(\w+)/.exec(text)?.[1] ?? '',
            },
          ]
        : [{ type: 'text', text, format: 'markdown' }],
      visibility: 'visible',
      provenance: {},
      contentHash: `h${i}`,
      metadata: {},
    })),
    attachments: [],
    userContext: [],
    extraction: {
      method: 'export',
      completeness: 'complete',
      completenessReasons: [],
      extractedAt: new Date().toISOString(),
      warnings: [],
      excluded: [],
      offPathMessages: 0,
    },
    metadata: {},
    ...extra,
  };
}
