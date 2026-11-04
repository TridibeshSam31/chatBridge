import type { Content } from '@google/genai';
import { type NormalizedMessage, blockText } from '../../core/conversation/schema';

/**
 * Maps normalized messages to Gemini chat history.
 *
 * Gemini history has only "user" and "model" roles. Assistant → model; tool
 * output is shown to the model as a labelled block inside a model turn (it was
 * produced on the assistant's side); visible system messages go to the system
 * instruction instead of the history. The result is normalized to strictly
 * alternating, user-first, non-empty turns, and every adjustment is reported.
 */

export interface MapReport {
  merged: number;
  syntheticLeadingTurn: boolean;
  syntheticTrailingTurn: boolean;
  placeholders: number;
  movedToSystemInstruction: string[];
  skippedHidden: string[];
}

export const LEADING_PLACEHOLDER =
  '[ChatBridge: the imported conversation begins with an assistant message.]';
export const TRAILING_PLACEHOLDER =
  '[ChatBridge: the original conversation has no reply to this message.]';

export function mapToGeminiHistory(messages: NormalizedMessage[]): {
  history: Content[];
  systemNotes: string[];
  report: MapReport;
} {
  const report: MapReport = {
    merged: 0,
    syntheticLeadingTurn: false,
    syntheticTrailingTurn: false,
    placeholders: 0,
    movedToSystemInstruction: [],
    skippedHidden: [],
  };
  const systemNotes: string[] = [];
  const turns: { role: 'user' | 'model'; text: string }[] = [];

  for (const m of messages) {
    if (m.visibility === 'hidden') {
      report.skippedHidden.push(m.id);
      continue;
    }
    report.placeholders += m.content.filter(
      (b) => b.type === 'image' || b.type === 'file' || b.type === 'unsupported',
    ).length;
    const body = m.content.map(blockText).join('\n\n').trim();

    if (m.role === 'system') {
      if (body) systemNotes.push(body);
      report.movedToSystemInstruction.push(m.id);
      continue;
    }
    let role: 'user' | 'model' = m.role === 'user' ? 'user' : 'model';
    let text = body || '[empty message]';
    if (m.role === 'tool') {
      const name = typeof m.metadata.authorName === 'string' ? m.metadata.authorName : 'tool';
      text = `[Tool output from ${name} in the original conversation]\n${text}`;
      role = 'model';
    } else if (m.role === 'assistant' && typeof m.metadata.recipient === 'string') {
      text = `[Tool call to ${m.metadata.recipient} in the original conversation]\n${text}`;
    }

    const last = turns.at(-1);
    if (last && last.role === role) {
      last.text += `\n\n${text}`;
      report.merged++;
    } else turns.push({ role, text });
  }

  if (turns[0]?.role === 'model') {
    turns.unshift({ role: 'user', text: LEADING_PLACEHOLDER });
    report.syntheticLeadingTurn = true;
  }
  // A trailing user turn would make the next live message a second user turn in a row.
  if (turns.at(-1)?.role === 'user') {
    turns.push({ role: 'model', text: TRAILING_PLACEHOLDER });
    report.syntheticTrailingTurn = true;
  }

  return {
    history: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    systemNotes,
    report,
  };
}
