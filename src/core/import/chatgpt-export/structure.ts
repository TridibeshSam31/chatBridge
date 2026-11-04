import { bump, type Histogram, isRecord, redactShape, shapeOf } from '../../../shared/redact';

/**
 * Structural analysis of ChatGPT conversation trees (the `mapping` format used by
 * both the official export and the web app's conversation endpoint). Produces
 * counts and shapes only, never content. Used by diagnostics to validate our
 * assumptions about the format before the Phase 2 parser is written.
 */

export interface TreeStructure {
  topLevelKeys: Histogram;
  nodeCount: number;
  messageNodeCount: number;
  rootCount: number;
  missingParentRefs: number;
  missingChildRefs: number;
  /** Parent and child links that disagree with each other. */
  inconsistentLinks: number;
  currentNodePresent: number;
  /** Message-bearing nodes on the current_node → root path, summed. */
  currentPathMessages: number;
  currentPathReachesRoot: number;
  currentPathCycle: number;
  branchPoints: number;
  maxChildren: number;
  /** Message nodes not on the current path: edits, regenerations, abandoned branches. */
  offPathMessageNodes: number;
  rolesOnPath: Histogram;
  contentTypesOnPath: Histogram;
  contentTypesAll: Histogram;
  partKinds: Histogram;
  recipients: Histogram;
  statuses: Histogram;
  messageKeys: Histogram;
  metadataKeys: Histogram;
  attachmentKeys: Histogram;
  hiddenMessages: number;
  nullCreateTime: number;
  samplesByContentType: Record<string, unknown>;
  problems: string[];
}

export function emptyStructure(): TreeStructure {
  return {
    topLevelKeys: {},
    nodeCount: 0,
    messageNodeCount: 0,
    rootCount: 0,
    missingParentRefs: 0,
    missingChildRefs: 0,
    inconsistentLinks: 0,
    currentNodePresent: 0,
    currentPathMessages: 0,
    currentPathReachesRoot: 0,
    currentPathCycle: 0,
    branchPoints: 0,
    maxChildren: 0,
    offPathMessageNodes: 0,
    rolesOnPath: {},
    contentTypesOnPath: {},
    contentTypesAll: {},
    partKinds: {},
    recipients: {},
    statuses: {},
    messageKeys: {},
    metadataKeys: {},
    attachmentKeys: {},
    hiddenMessages: 0,
    nullCreateTime: 0,
    samplesByContentType: {},
    problems: [],
  };
}

export function analyzeConversationTree(conversation: unknown): TreeStructure {
  const s = emptyStructure();
  if (!isRecord(conversation)) {
    s.problems.push('conversation is not an object');
    return s;
  }
  for (const key of Object.keys(conversation)) bump(s.topLevelKeys, key);

  const mapping = conversation.mapping;
  if (!isRecord(mapping)) {
    s.problems.push('mapping missing or not an object');
    return s;
  }

  const nodes = new Map<string, Record<string, unknown>>();
  for (const [id, node] of Object.entries(mapping)) {
    if (isRecord(node)) nodes.set(id, node);
    else s.problems.push('mapping entry is not an object');
  }
  s.nodeCount = nodes.size;

  // Current path first, so per-message stats can tell on-path from off-path.
  const onPath = new Set<string>();
  const currentNode = conversation.current_node;
  if (typeof currentNode === 'string' && nodes.has(currentNode)) {
    s.currentNodePresent = 1;
    let cursor: string | null = currentNode;
    while (cursor !== null) {
      if (onPath.has(cursor)) {
        s.currentPathCycle = 1;
        s.problems.push('cycle on current path');
        break;
      }
      onPath.add(cursor);
      const node = nodes.get(cursor);
      if (!node) break;
      const parent = node.parent;
      if (parent === null || parent === undefined) {
        s.currentPathReachesRoot = 1;
        cursor = null;
      } else if (typeof parent === 'string' && nodes.has(parent)) {
        cursor = parent;
      } else {
        s.problems.push('current path broken by a missing parent');
        cursor = null;
      }
    }
  } else {
    s.problems.push(
      currentNode === undefined ? 'current_node missing' : 'current_node not in mapping',
    );
  }

  for (const [id, node] of nodes) {
    const parent = node.parent;
    if (parent === null || parent === undefined) s.rootCount++;
    else if (typeof parent !== 'string' || !nodes.has(parent)) s.missingParentRefs++;
    else {
      const parentChildren = nodes.get(parent)?.children;
      if (!Array.isArray(parentChildren) || !parentChildren.includes(id)) s.inconsistentLinks++;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    s.maxChildren = Math.max(s.maxChildren, children.length);
    if (children.length > 1) s.branchPoints++;
    for (const child of children) {
      if (typeof child !== 'string' || !nodes.has(child)) s.missingChildRefs++;
    }

    const message = node.message;
    if (!isRecord(message)) continue;
    s.messageNodeCount++;
    const isOnPath = onPath.has(id);
    if (!isOnPath) s.offPathMessageNodes++;
    if (isOnPath) s.currentPathMessages++;
    analyzeMessage(message, isOnPath, s);
  }

  return s;
}

function analyzeMessage(message: Record<string, unknown>, onPath: boolean, s: TreeStructure) {
  for (const key of Object.keys(message)) bump(s.messageKeys, key);

  const role =
    isRecord(message.author) && typeof message.author.role === 'string'
      ? shapeOf(message.author.role)
      : '<missing>';
  const content = isRecord(message.content) ? message.content : undefined;
  const contentType =
    content && typeof content.content_type === 'string'
      ? shapeOf(content.content_type)
      : '<missing>';

  bump(s.contentTypesAll, contentType);
  if (onPath) {
    bump(s.rolesOnPath, role);
    bump(s.contentTypesOnPath, contentType);
  }
  if (!(contentType in s.samplesByContentType) && content) {
    s.samplesByContentType[contentType] = redactShape(content);
  }

  if (content && Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === 'string') bump(s.partKinds, 'string');
      else if (isRecord(part) && typeof part.content_type === 'string') {
        bump(s.partKinds, shapeOf(part.content_type));
      } else bump(s.partKinds, isRecord(part) ? 'object' : typeof part);
    }
  }

  if (typeof message.recipient === 'string') bump(s.recipients, shapeOf(message.recipient));
  if (typeof message.status === 'string') bump(s.statuses, shapeOf(message.status));
  if (message.create_time === null || message.create_time === undefined) s.nullCreateTime++;

  const metadata = message.metadata;
  if (isRecord(metadata)) {
    for (const key of Object.keys(metadata)) bump(s.metadataKeys, key);
    if (metadata.is_visually_hidden_from_conversation === true) s.hiddenMessages++;
    if (Array.isArray(metadata.attachments)) {
      for (const attachment of metadata.attachments) {
        if (isRecord(attachment))
          for (const key of Object.keys(attachment)) bump(s.attachmentKeys, key);
      }
    }
  }
}

/** Sums structures from many conversations into one aggregate. */
export function mergeStructures(into: TreeStructure, from: TreeStructure, label: string): void {
  const numericKeys = [
    'nodeCount',
    'messageNodeCount',
    'rootCount',
    'missingParentRefs',
    'missingChildRefs',
    'inconsistentLinks',
    'currentNodePresent',
    'currentPathMessages',
    'currentPathReachesRoot',
    'currentPathCycle',
    'branchPoints',
    'offPathMessageNodes',
    'hiddenMessages',
    'nullCreateTime',
  ] as const;
  for (const key of numericKeys) into[key] += from[key];
  into.maxChildren = Math.max(into.maxChildren, from.maxChildren);

  const histogramKeys = [
    'topLevelKeys',
    'rolesOnPath',
    'contentTypesOnPath',
    'contentTypesAll',
    'partKinds',
    'recipients',
    'statuses',
    'messageKeys',
    'metadataKeys',
    'attachmentKeys',
  ] as const;
  for (const key of histogramKeys) {
    for (const [k, n] of Object.entries(from[key])) bump(into[key], k, n);
  }
  for (const [type, sample] of Object.entries(from.samplesByContentType)) {
    if (!(type in into.samplesByContentType)) into.samplesByContentType[type] = sample;
  }
  for (const problem of from.problems) into.problems.push(`${label}: ${problem}`);
}

export interface ExportProbeReport {
  kind: 'export-probe';
  probeVersion: 1;
  fileBytes: number;
  rootIsArray: boolean;
  conversationCount: number;
  conversationsWithBranches: number;
  largestConversationNodes: number;
  aggregate: TreeStructure;
}

/** Analyzes a parsed conversations.json. Problems are labelled by index, never by title. */
export function analyzeExport(parsed: unknown, fileBytes: number): ExportProbeReport {
  const aggregate = emptyStructure();
  const report: ExportProbeReport = {
    kind: 'export-probe',
    probeVersion: 1,
    fileBytes,
    rootIsArray: Array.isArray(parsed),
    conversationCount: 0,
    conversationsWithBranches: 0,
    largestConversationNodes: 0,
    aggregate,
  };
  if (!Array.isArray(parsed)) {
    aggregate.problems.push('root is not an array of conversations');
    return report;
  }

  report.conversationCount = parsed.length;
  parsed.forEach((conversation, index) => {
    const structure = analyzeConversationTree(conversation);
    if (structure.branchPoints > 0) report.conversationsWithBranches++;
    report.largestConversationNodes = Math.max(
      report.largestConversationNodes,
      structure.nodeCount,
    );
    mergeStructures(aggregate, structure, `conversation[${index}]`);
  });
  return report;
}
