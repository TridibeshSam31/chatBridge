import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeConversationTree,
  analyzeExport,
} from '../../src/core/import/chatgpt-export/structure';

const raw = readFileSync(
  resolve(import.meta.dirname, '../fixtures/chatgpt-export/conversations.json'),
  'utf8',
);
const conversations = JSON.parse(raw) as unknown[];

describe('analyzeConversationTree', () => {
  const s = analyzeConversationTree(conversations[0]);

  it('follows current_node back to the root', () => {
    expect(s.currentNodePresent).toBe(1);
    expect(s.currentPathReachesRoot).toBe(1);
    expect(s.currentPathCycle).toBe(0);
    // sys1, uec1, u1, a1, u2b, a2b2, t1, th1, a3, u4, a4
    expect(s.currentPathMessages).toBe(11);
  });

  it('counts edits and regenerations as branches, not as path messages', () => {
    expect(s.branchPoints).toBe(2); // a1 (edited user turn), u2b (regenerated reply)
    expect(s.maxChildren).toBe(2);
    expect(s.offPathMessageNodes).toBe(3); // u2a, a2a, a2b1
  });

  it('records the content types the parser must handle', () => {
    expect(s.contentTypesOnPath).toEqual({
      text: 6, // sys1, u1, a1, u2b, a3, a4
      user_editable_context: 1,
      code: 1,
      execution_output: 1,
      thoughts: 1,
      multimodal_text: 1,
    });
  });

  it('separates hidden messages, tool recipients and attachments', () => {
    expect(s.hiddenMessages).toBe(2);
    expect(s.recipients).toMatchObject({ all: 13, python: 1 });
    expect(s.rolesOnPath).toEqual({ system: 1, user: 4, assistant: 5, tool: 1 });
    expect(s.partKinds).toMatchObject({ image_asset_pointer: 1 });
    expect(Object.keys(s.attachmentKeys)).toEqual(
      expect.arrayContaining(['id', 'name', 'mime_type', 'size']),
    );
    expect(s.nullCreateTime).toBe(2);
  });

  it('reports a structurally broken conversation instead of throwing', () => {
    const broken = analyzeConversationTree(conversations[2]);
    expect(broken.currentPathReachesRoot).toBe(0);
    expect(broken.missingParentRefs).toBe(1);
    expect(broken.problems).toContain('current path broken by a missing parent');
  });

  it('handles non-object input', () => {
    expect(analyzeConversationTree('nope').problems).toEqual(['conversation is not an object']);
    expect(analyzeConversationTree({}).problems).toEqual(['mapping missing or not an object']);
  });
});

describe('analyzeExport', () => {
  const report = analyzeExport(conversations, raw.length);

  it('aggregates across conversations', () => {
    expect(report.rootIsArray).toBe(true);
    expect(report.conversationCount).toBe(3);
    expect(report.conversationsWithBranches).toBe(1);
    expect(report.aggregate.currentPathReachesRoot).toBe(2);
    expect(report.aggregate.problems).toEqual([
      'conversation[2]: current path broken by a missing parent',
    ]);
  });

  it('never contains conversation content, titles, file names or asset ids', () => {
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/SENTINEL/);
    expect(serialized).not.toMatch(/Bearer|TypeScript|middleware|screenshot/);
  });

  it('keeps schema enums that the parser design depends on', () => {
    const sample = report.aggregate.samplesByContentType.multimodal_text as {
      parts: unknown[];
    };
    expect(sample.parts[0]).toMatchObject({
      content_type: 'image_asset_pointer',
      asset_pointer: expect.stringMatching(/^<str:\d+>$/),
    });
  });

  it('rejects a non-array root', () => {
    expect(analyzeExport({}, 2).aggregate.problems).toEqual([
      'root is not an array of conversations',
    ]);
  });
});
