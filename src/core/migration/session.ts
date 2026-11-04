import { z } from 'zod';

/** A continued conversation at a destination, persisted turn by turn. */

export const TurnSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'model']),
  text: z.string(),
  status: z.enum(['complete', 'pending', 'failed', 'partial']),
  error: z.string().optional(),
  at: z.iso.datetime(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  /** Shown everywhere the session appears. */
  destinationLabel: z.string(),
  model: z.string(),
  planId: z.string(),
  transcriptId: z.string(),
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  systemInstruction: z.string(),
  /** Imported history in the provider's native format. */
  importedHistory: z.array(z.unknown()),
  importedTurnCount: z.number().int().nonnegative(),
  mapReport: z.record(z.string(), z.unknown()),
  turns: z.array(TurnSchema),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * Turns that may be sent back as history: complete user/model pairs only. A
 * failed or interrupted exchange stays visible to the user but is not replayed.
 */
export function replayableTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const next = turns[i + 1];
    if (t.role === 'user' && next?.role === 'model' && next.status === 'complete') {
      out.push(t, next);
      i++;
    }
  }
  return out;
}

/** Pending turns found on load belong to a panel that was closed mid-request. */
export function markInterrupted(session: Session): Session {
  return {
    ...session,
    turns: session.turns.map((t) =>
      t.status === 'pending'
        ? {
            ...t,
            status: t.text ? 'partial' : 'failed',
            error: 'Interrupted: the panel was closed before the reply finished.',
          }
        : t,
    ),
  };
}
