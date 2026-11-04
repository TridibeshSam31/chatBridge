import type { NormalizedMessage } from '../conversation/schema';
import { blockText } from '../conversation/schema';

/**
 * Local token estimates. Deliberately conservative (over-estimates), because an
 * under-estimate would overflow the destination's context. Exact counts need the
 * destination's tokenizer, which means sending the content — that is offered
 * separately, behind consent.
 */

const PROSE_CHARS_PER_TOKEN = 3.6;
const CODE_CHARS_PER_TOKEN = 3.0;
const MESSAGE_OVERHEAD = 6;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / PROSE_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Pick<NormalizedMessage, 'content'>): number {
  let tokens = MESSAGE_OVERHEAD;
  for (const block of message.content) {
    const text = blockText(block);
    tokens += Math.ceil(
      text.length / (block.type === 'code' ? CODE_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN),
    );
  }
  return tokens;
}
