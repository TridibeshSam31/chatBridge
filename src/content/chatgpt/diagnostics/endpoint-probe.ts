import {
  analyzeConversationTree,
  type TreeStructure,
} from '../../../core/import/chatgpt-export/structure';
import { type EndpointFetchResult, type EndpointOutcome, fetchConversationTree } from '../endpoint';

export type { EndpointOutcome };

export interface EndpointProbeReport extends Omit<EndpointFetchResult, 'json'> {
  kind: 'endpoint-probe';
  probeVersion: 1;
  structure: TreeStructure | null;
}

/** Diagnostic: is the unofficial endpoint reachable, and what shape is its response? */
export async function probeEndpoint(
  origin: string,
  conversationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointProbeReport> {
  const { json, ...result } = await fetchConversationTree(origin, conversationId, fetchImpl);
  const structure = json === undefined ? null : analyzeConversationTree(json);
  return {
    kind: 'endpoint-probe',
    probeVersion: 1,
    ...result,
    outcome: structure && !structure.currentNodePresent ? 'unexpected-response' : result.outcome,
    structure,
  };
}
