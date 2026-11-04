import { z } from 'zod';
import {
  type ContentBlock,
  type ExcludedItem,
  type ExtractionWarning,
  type NormalizedConversation,
  type NormalizedMessage,
  type Role,
  type UserContext,
  ConversationSchema,
  messageText,
} from '../../conversation/schema';
import { hashString } from '../../../shared/hash';
import { isRecord } from '../../../shared/redact';

/**
 * Parses one ChatGPT conversation tree (official export or the web app's
 * conversation endpoint — same format) into a NormalizedConversation.
 *
 * The selected path is current_node → root, reversed: the branch the user last
 * saw. Other branches (edits, regenerations) are counted, not flattened in.
 * Malformed nodes are reported and skipped; the rest still imports.
 */

const NodeSchema = z.looseObject({
  id: z.string().optional(),
  message: z.unknown().optional(),
  parent: z.string().nullable().optional(),
  children: z.array(z.string()).optional(),
});

const MessageSchema = z.looseObject({
  id: z.string(),
  author: z.looseObject({ role: z.string(), name: z.string().nullable().optional() }),
  create_time: z.number().nullable().optional(),
  content: z.looseObject({ content_type: z.string() }),
  recipient: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
type RawMessage = z.infer<typeof MessageSchema>;

const ConversationShape = z.looseObject({
  title: z.string().nullable().optional(),
  create_time: z.number().nullable().optional(),
  update_time: z.number().nullable().optional(),
  conversation_id: z.string().optional(),
  id: z.string().optional(),
  current_node: z.string().nullable().optional(),
  mapping: z.record(z.string(), z.unknown()),
});

export class ConversationParseError extends Error {
  override name = 'ConversationParseError';
}

const EXCLUDED_CONTENT_TYPES: Record<string, string> = {
  thoughts: 'Model reasoning is not transferred',
  reasoning_recap: 'Model reasoning is not transferred',
  model_editable_context: 'Model memory context is not transferred',
};

export function parseConversationTree(
  raw: unknown,
  method: 'export' | 'internal-api',
): NormalizedConversation {
  const shape = ConversationShape.safeParse(raw);
  if (!shape.success) {
    throw new ConversationParseError(
      `Not a ChatGPT conversation: ${shape.error.issues[0]?.message ?? 'invalid shape'}`,
    );
  }
  const conv = shape.data;
  const conversationId = conv.conversation_id ?? conv.id;
  if (!conversationId) throw new ConversationParseError('Conversation has no id');

  const warnings: ExtractionWarning[] = [];
  const excluded: ExcludedItem[] = [];
  const completenessReasons: string[] = [];
  let completeness: NormalizedConversation['extraction']['completeness'] = 'complete';

  const nodes = new Map<string, z.infer<typeof NodeSchema>>();
  let malformed = 0;
  for (const [id, value] of Object.entries(conv.mapping)) {
    const node = NodeSchema.safeParse(value);
    if (node.success) nodes.set(id, node.data);
    else malformed++;
  }
  if (malformed > 0) {
    warnings.push({
      code: 'MALFORMED_NODES',
      message: `${malformed} tree node(s) were malformed and skipped.`,
    });
    completeness = 'partial';
    completenessReasons.push('Some tree nodes were malformed.');
  }

  const leaf = pickLeaf(conv.current_node ?? null, nodes, warnings);
  if (leaf === null) throw new ConversationParseError('Conversation tree has no messages');

  const pathIds: string[] = [];
  const seen = new Set<string>();
  for (let cursor: string | null = leaf; cursor !== null;) {
    if (seen.has(cursor)) {
      warnings.push({
        code: 'CYCLE',
        message: 'The conversation tree contains a cycle; history before it was not reachable.',
      });
      completeness = 'partial';
      completenessReasons.push('Tree cycle cut the path short.');
      break;
    }
    seen.add(cursor);
    pathIds.push(cursor);
    const parent: string | null | undefined = nodes.get(cursor)?.parent;
    if (parent === null || parent === undefined) break;
    if (!nodes.has(parent)) {
      warnings.push({
        code: 'MISSING_PARENT',
        message: 'A parent node is missing; earlier history is not in this file.',
      });
      completeness = 'partial';
      completenessReasons.push('The path to the root is broken by a missing node.');
      break;
    }
    cursor = parent;
  }
  pathIds.reverse();
  const onPath = new Set(pathIds);

  const messages: NormalizedMessage[] = [];
  const userContext: UserContext[] = [];
  const attachments: NormalizedConversation['attachments'] = [];

  for (const nodeId of pathIds) {
    const node = nodes.get(nodeId);
    if (!node || node.message === null || node.message === undefined) continue;
    const parsed = MessageSchema.safeParse(node.message);
    if (!parsed.success) {
      excluded.push({ sourceNodeId: nodeId, reason: 'Malformed message record' });
      warnings.push({
        code: 'MALFORMED_MESSAGE',
        message: 'A message record on the selected path was malformed.',
      });
      completeness = 'partial';
      if (!completenessReasons.includes('A message on the path was malformed.')) {
        completenessReasons.push('A message on the path was malformed.');
      }
      continue;
    }
    const msg = parsed.data;
    const contentType = msg.content.content_type;

    const exclusion = EXCLUDED_CONTENT_TYPES[contentType];
    if (exclusion) {
      excluded.push({
        sourceNodeId: nodeId,
        role: msg.author.role,
        contentType,
        reason: exclusion,
      });
      continue;
    }

    const hidden = msg.metadata?.is_visually_hidden_from_conversation === true;
    const role = mapRole(msg);
    const content = convertContent(msg, warnings);

    if (contentType === 'user_editable_context') {
      userContext.push(...customInstructions(msg));
    }
    if (hidden && content.every((b) => b.type === 'text' && b.text.trim() === '')) {
      excluded.push({
        sourceNodeId: nodeId,
        role: msg.author.role,
        contentType,
        reason: 'Empty hidden system message',
      });
      continue;
    }

    for (const att of Array.isArray(msg.metadata?.attachments) ? msg.metadata.attachments : []) {
      if (!isRecord(att)) continue;
      attachments.push({
        id: typeof att.id === 'string' ? att.id : `${msg.id}-attachment-${attachments.length}`,
        messageId: msg.id,
        name: typeof att.name === 'string' ? att.name : 'unnamed attachment',
        ...(typeof att.mime_type === 'string' ? { mimeType: att.mime_type } : {}),
        ...(typeof att.size === 'number' ? { size: att.size } : {}),
      });
      // Images are already represented by image_asset_pointer parts.
      const isImage = typeof att.mime_type === 'string' && att.mime_type.startsWith('image/');
      if (!isImage && typeof att.name === 'string') {
        content.push({
          type: 'file',
          name: att.name,
          available: false,
          ...(typeof att.mime_type === 'string' ? { mimeType: att.mime_type } : {}),
        });
      }
    }

    const parentId = node.parent ?? undefined;
    const siblings = parentId ? (nodes.get(parentId)?.children ?? []) : [];
    const message: NormalizedMessage = {
      id: msg.id,
      role,
      content,
      visibility: hidden || contentType === 'user_editable_context' ? 'hidden' : 'visible',
      provenance: {
        sourceNodeId: nodeId,
        ...(parentId ? { parentId } : {}),
        ...(siblings.length > 1
          ? { siblingCount: siblings.length, branchIndex: Math.max(0, siblings.indexOf(nodeId)) }
          : {}),
      },
      contentHash: '',
      metadata: {
        sourceContentType: contentType,
        ...(msg.recipient && msg.recipient !== 'all' ? { recipient: msg.recipient } : {}),
        ...(msg.author.name ? { authorName: msg.author.name } : {}),
        ...(typeof msg.metadata?.model_slug === 'string' ? { model: msg.metadata.model_slug } : {}),
      },
    };
    if (typeof msg.create_time === 'number')
      message.timestamp = new Date(msg.create_time * 1000).toISOString();
    message.contentHash = hashString(`${message.role}\n${messageText(message)}`);
    messages.push(message);
  }

  flagConsecutiveDuplicates(messages, warnings);

  let offPathMessages = 0;
  for (const [id, node] of nodes) {
    if (!onPath.has(id) && node.message !== null && node.message !== undefined) offPathMessages++;
  }
  if (offPathMessages > 0) {
    warnings.push({
      code: 'BRANCHES_PRESENT',
      message: `${offPathMessages} message(s) belong to other branches (edits or regenerations) and were not selected. The selected branch is the one last shown in ChatGPT.`,
    });
  }

  const result: NormalizedConversation = {
    schemaVersion: 1,
    conversationId,
    title: conv.title ?? null,
    sourceProvider: 'chatgpt',
    messages,
    attachments,
    userContext,
    extraction: {
      method,
      completeness,
      completenessReasons:
        completeness === 'complete'
          ? ['Selected path reconstructed from the full conversation tree.']
          : completenessReasons,
      extractedAt: new Date().toISOString(),
      warnings,
      excluded,
      offPathMessages,
    },
    metadata:
      typeof conv.default_model_slug === 'string' ? { defaultModel: conv.default_model_slug } : {},
  };
  if (typeof conv.create_time === 'number')
    result.createdAt = new Date(conv.create_time * 1000).toISOString();
  if (typeof conv.update_time === 'number')
    result.updatedAt = new Date(conv.update_time * 1000).toISOString();
  return ConversationSchema.parse(result);
}

function pickLeaf(
  currentNode: string | null,
  nodes: Map<string, z.infer<typeof NodeSchema>>,
  warnings: ExtractionWarning[],
): string | null {
  if (currentNode !== null && nodes.has(currentNode)) return currentNode;
  // No usable current_node: fall back to the most recent leaf, and say so.
  let best: { id: string; time: number } | null = null;
  for (const [id, node] of nodes) {
    if ((node.children?.length ?? 0) > 0) continue;
    const m = MessageSchema.safeParse(node.message);
    const time = m.success ? (m.data.create_time ?? 0) : -1;
    if (best === null || time > best.time) best = { id, time };
  }
  if (best !== null) {
    warnings.push({
      code: 'NO_CURRENT_NODE',
      message:
        'The file does not say which branch was last shown; the most recent branch was selected.',
    });
  }
  return best?.id ?? null;
}

function mapRole(msg: RawMessage): Role {
  switch (msg.author.role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return msg.author.role;
    default:
      return 'tool';
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function convertContent(msg: RawMessage, warnings: ExtractionWarning[]): ContentBlock[] {
  const c = msg.content;
  const type = c.content_type;
  switch (type) {
    case 'text':
      return [{ type: 'text', text: strings(c.parts).join('\n'), format: 'markdown' }];
    case 'code':
      return [
        {
          type: 'code',
          text: typeof c.text === 'string' ? c.text : '',
          ...(typeof c.language === 'string' && c.language !== 'unknown'
            ? { language: c.language }
            : {}),
        },
      ];
    case 'execution_output':
      return [{ type: 'code', text: typeof c.text === 'string' ? c.text : '', language: 'output' }];
    case 'multimodal_text': {
      const blocks: ContentBlock[] = [];
      for (const part of Array.isArray(c.parts) ? c.parts : []) {
        if (typeof part === 'string') {
          if (part.trim()) blocks.push({ type: 'text', text: part, format: 'markdown' });
        } else if (isRecord(part) && part.content_type === 'image_asset_pointer') {
          blocks.push({
            type: 'image',
            available: false,
            ...(typeof part.asset_pointer === 'string' ? { ref: part.asset_pointer } : {}),
          });
        } else {
          const partType =
            isRecord(part) && typeof part.content_type === 'string'
              ? part.content_type
              : typeof part;
          blocks.push({
            type: 'unsupported',
            originalType: partType,
            description: 'Non-text part of a multimodal message',
          });
        }
      }
      return blocks;
    }
    case 'user_editable_context': {
      const text = [
        typeof c.user_profile === 'string' ? c.user_profile : '',
        typeof c.user_instructions === 'string' ? c.user_instructions : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return [{ type: 'text', text, format: 'plain' }];
    }
    case 'tether_quote':
      return [
        {
          type: 'text',
          format: 'plain',
          text: [c.title, c.url, c.text]
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .join('\n'),
        },
      ];
    case 'tether_browsing_display':
      return [
        {
          type: 'text',
          format: 'plain',
          text: [c.result, c.summary]
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .join('\n'),
        },
      ];
    case 'system_error':
      return [
        {
          type: 'text',
          format: 'plain',
          text: `[Tool error] ${typeof c.text === 'string' ? c.text : ''}`.trim(),
        },
      ];
    default: {
      const text = strings(c.parts).join('\n') || (typeof c.text === 'string' ? c.text : '');
      warnings.push({
        code: 'UNKNOWN_CONTENT_TYPE',
        message: `Content type "${type}" is not specifically supported; kept as unsupported content.`,
        messageIds: [msg.id],
      });
      return [
        {
          type: 'unsupported',
          originalType: type,
          description: text ? 'Text preserved below' : 'No text content',
        },
        ...(text ? [{ type: 'text' as const, text, format: 'plain' as const }] : []),
      ];
    }
  }
}

function customInstructions(msg: RawMessage): UserContext[] {
  const c = msg.content;
  const out: UserContext[] = [];
  if (typeof c.user_profile === 'string' && c.user_profile.trim()) {
    out.push({
      kind: 'custom-instructions',
      label: 'What the user told ChatGPT about themselves',
      text: c.user_profile.trim(),
      sourceMessageId: msg.id,
    });
  }
  if (typeof c.user_instructions === 'string' && c.user_instructions.trim()) {
    out.push({
      kind: 'custom-instructions',
      label: 'How the user wants responses',
      text: c.user_instructions.trim(),
      sourceMessageId: msg.id,
    });
  }
  return out;
}

function flagConsecutiveDuplicates(messages: NormalizedMessage[], warnings: ExtractionWarning[]) {
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const cur = messages[i]!;
    if (
      prev.role === cur.role &&
      prev.contentHash === cur.contentHash &&
      messageText(cur).trim() !== ''
    ) {
      warnings.push({
        code: 'DUPLICATE_MESSAGE',
        message: 'Two consecutive messages have identical content. Both were kept.',
        messageIds: [prev.id, cur.id],
      });
    }
  }
}

export interface ExportEntry {
  index: number;
  conversationId: string | null;
  title: string | null;
  updatedAt: string | null;
  nodeCount: number;
}

/** Lists conversations in a parsed conversations.json without converting them. */
export function listExportConversations(parsed: unknown): ExportEntry[] {
  if (!Array.isArray(parsed))
    throw new ConversationParseError('conversations.json must contain an array of conversations');
  return parsed.map((raw, index): ExportEntry => {
    const c = isRecord(raw) ? raw : {};
    const id =
      typeof c.conversation_id === 'string'
        ? c.conversation_id
        : typeof c.id === 'string'
          ? c.id
          : null;
    const update =
      typeof c.update_time === 'number'
        ? c.update_time
        : typeof c.create_time === 'number'
          ? c.create_time
          : null;
    return {
      index,
      conversationId: id,
      title: typeof c.title === 'string' ? c.title : null,
      updatedAt: update === null ? null : new Date(update * 1000).toISOString(),
      nodeCount: isRecord(c.mapping) ? Object.keys(c.mapping).length : 0,
    };
  });
}
