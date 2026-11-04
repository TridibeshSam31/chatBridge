import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationSchema, messageText } from '../../src/core/conversation/schema';
import {
  ConversationParseError,
  listExportConversations,
  parseConversationTree,
} from '../../src/core/import/chatgpt-export/parse';

const conversations = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/chatgpt-export/conversations.json'),
    'utf8',
  ),
) as Record<string, unknown>[];

describe('parseConversationTree', () => {
  const conv = parseConversationTree(conversations[0], 'export');

  it('produces a schema-valid conversation', () => {
    expect(ConversationSchema.safeParse(conv).success).toBe(true);
    expect(conv.conversationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(conv.createdAt).toBe(new Date(1730000000123).toISOString());
  });

  it('follows the selected branch in chronological order', () => {
    expect(conv.messages.map((m) => m.id)).toEqual([
      'uec1',
      'u1',
      'a1',
      'u2b',
      'a2b2',
      't1',
      'a3',
      'u4',
      'a4',
    ]);
    expect(conv.messages.map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('does not flatten other branches in, but counts them', () => {
    const ids = conv.messages.map((m) => m.id);
    for (const offPath of ['u2a', 'a2a', 'a2b1']) expect(ids).not.toContain(offPath);
    expect(conv.extraction.offPathMessages).toBe(3);
    expect(conv.extraction.warnings.map((w) => w.code)).toContain('BRANCHES_PRESENT');
  });

  it('records branch position for edited and regenerated messages', () => {
    const edited = conv.messages.find((m) => m.id === 'u2b')!;
    expect(edited.provenance).toMatchObject({ siblingCount: 2, branchIndex: 1, parentId: 'a1' });
    const regenerated = conv.messages.find((m) => m.id === 'a2b2')!;
    expect(regenerated.provenance).toMatchObject({ siblingCount: 2, branchIndex: 1 });
  });

  it('excludes reasoning and empty hidden system messages with reasons, never silently', () => {
    expect(conv.extraction.excluded).toEqual([
      {
        sourceNodeId: 'sys1',
        role: 'system',
        contentType: 'text',
        reason: 'Empty hidden system message',
      },
      {
        sourceNodeId: 'th1',
        role: 'assistant',
        contentType: 'thoughts',
        reason: 'Model reasoning is not transferred',
      },
    ]);
  });

  it('captures custom instructions as user context and a hidden message', () => {
    expect(conv.userContext.map((c) => c.text)).toEqual([
      'SENTINEL_PROFILE I am a backend engineer.',
      'SENTINEL_INSTRUCTIONS Be concise. Use TypeScript.',
    ]);
    expect(conv.messages[0]!.visibility).toBe('hidden');
  });

  it('converts code, tool output and multimodal content', () => {
    const code = conv.messages.find((m) => m.id === 'a2b2')!;
    expect(code.content).toEqual([{ type: 'code', text: 'SENTINEL_CODE print(token)' }]);
    expect(code.metadata.recipient).toBe('python');
    const tool = conv.messages.find((m) => m.id === 't1')!;
    expect(tool.content[0]).toMatchObject({ type: 'code', language: 'output' });
    const multimodal = conv.messages.find((m) => m.id === 'u4')!;
    expect(multimodal.content).toEqual([
      { type: 'image', available: false, ref: 'file-service://file-SENTINELASSET' },
      { type: 'text', text: 'SENTINEL_U4 here is the screenshot', format: 'markdown' },
    ]);
    expect(conv.attachments).toEqual([
      {
        id: 'file-SENTINELASSET',
        messageId: 'u4',
        name: 'SENTINEL_FILENAME.png',
        mimeType: 'image/png',
        size: 12345,
      },
    ]);
  });

  it('reports complete for an intact tree', () => {
    expect(conv.extraction.completeness).toBe('complete');
    expect(conv.extraction.method).toBe('export');
  });

  it('reports partial, with reasons, when the path is broken', () => {
    const broken = parseConversationTree(conversations[2], 'export');
    expect(broken.messages).toHaveLength(1);
    expect(broken.extraction.completeness).toBe('partial');
    expect(broken.extraction.warnings.map((w) => w.code)).toContain('MISSING_PARENT');
  });

  it('falls back to the latest leaf when current_node is missing', () => {
    const { current_node: _omit, ...rest } = conversations[0]!;
    const conv2 = parseConversationTree(rest, 'export');
    expect(conv2.extraction.warnings.map((w) => w.code)).toContain('NO_CURRENT_NODE');
    expect(conv2.messages.at(-1)!.id).toBe('a4');
  });

  it('detects cycles', () => {
    const cyclic = {
      conversation_id: 'x',
      current_node: 'b',
      mapping: {
        a: { id: 'a', parent: 'b', children: ['b'], message: msg('a', 'user', 'hi') },
        b: { id: 'b', parent: 'a', children: ['a'], message: msg('b', 'assistant', 'yo') },
      },
    };
    const conv3 = parseConversationTree(cyclic, 'export');
    expect(conv3.extraction.completeness).toBe('partial');
    expect(conv3.extraction.warnings.map((w) => w.code)).toContain('CYCLE');
  });

  it('skips malformed nodes and messages but keeps the rest', () => {
    const tree = {
      conversation_id: 'y',
      current_node: 'c',
      mapping: {
        a: { id: 'a', parent: null, children: ['b'], message: msg('a', 'user', 'first') },
        b: { id: 'b', parent: 'a', children: ['c'], message: { garbage: true } },
        c: { id: 'c', parent: 'b', children: [], message: msg('c', 'assistant', 'last') },
        d: 'not a node',
      },
    };
    const conv4 = parseConversationTree(tree, 'export');
    expect(conv4.messages.map((m) => m.id)).toEqual(['a', 'c']);
    expect(conv4.extraction.excluded).toEqual([
      { sourceNodeId: 'b', reason: 'Malformed message record' },
    ]);
    expect(conv4.extraction.completeness).toBe('partial');
  });

  it('flags consecutive duplicates without removing them', () => {
    const tree = {
      conversation_id: 'z',
      current_node: 'b',
      mapping: {
        a: { id: 'a', parent: null, children: ['b'], message: msg('a', 'user', 'same') },
        b: { id: 'b', parent: 'a', children: [], message: msg('b', 'user', 'same') },
      },
    };
    const conv5 = parseConversationTree(tree, 'export');
    expect(conv5.messages).toHaveLength(2);
    expect(
      conv5.extraction.warnings.find((w) => w.code === 'DUPLICATE_MESSAGE')?.messageIds,
    ).toEqual(['a', 'b']);
  });

  it('keeps unknown content types as unsupported, with their text', () => {
    const tree = {
      conversation_id: 'u',
      current_node: 'a',
      mapping: {
        a: {
          id: 'a',
          parent: null,
          children: [],
          message: {
            ...msg('a', 'assistant', ''),
            content: { content_type: 'future_type', parts: ['kept text'] },
          },
        },
      },
    };
    const conv6 = parseConversationTree(tree, 'export');
    expect(conv6.messages[0]!.content[0]).toMatchObject({
      type: 'unsupported',
      originalType: 'future_type',
    });
    expect(messageText(conv6.messages[0]!)).toContain('kept text');
  });

  it('rejects input that is not a conversation', () => {
    expect(() => parseConversationTree({ title: 'x' }, 'export')).toThrow(ConversationParseError);
    expect(() => parseConversationTree({ conversation_id: 'e', mapping: {} }, 'export')).toThrow(
      'no messages',
    );
  });
});

describe('listExportConversations', () => {
  it('lists entries without converting them', () => {
    const list = listExportConversations(conversations);
    expect(list).toHaveLength(3);
    expect(list[1]).toMatchObject({
      index: 1,
      conversationId: '22222222-2222-4222-8222-222222222222',
      nodeCount: 3,
    });
  });
});

function msg(id: string, role: string, text: string) {
  return {
    id,
    author: { role },
    create_time: 1,
    content: { content_type: 'text', parts: [text] },
    metadata: {},
  };
}
