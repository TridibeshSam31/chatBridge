import { useEffect, useState } from 'react';
import type { Session } from '../../core/migration/session';
import { listTranscripts } from '../../storage/db';
import { Badge, ErrorBox, sourceSummary } from '../components/ui';
import type { Navigate } from '../routes';
import { listSessions } from '../services';

type Transcripts = Awaited<ReturnType<typeof listTranscripts>>;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Everything stored locally: chats ChatBridge got, and chats continued in Gemini. */
export function Library({ navigate }: { navigate: Navigate }) {
  const [transcripts, setTranscripts] = useState<Transcripts | null>(null);
  const [sessions, setSessions] = useState<
    { id: string; createdAt: string; session: Session }[] | null
  >(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    Promise.all([listTranscripts(), listSessions()]).then(
      ([t, s]) => {
        setTranscripts(t);
        setSessions(s);
      },
      (err: unknown) => {
        console.error('[ChatBridge] loading library failed', err);
        setError(err);
      },
    );
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!transcripts || !sessions) return null;

  return (
    <div className="stack">
      {sessions.length > 0 && (
        <section className="card">
          <h2>Your Gemini chats</h2>
          <p className="muted small">Pick up where you left off.</p>
          <ul className="list">
            {sessions.map(({ id, createdAt, session }) => (
              <li key={id}>
                <button
                  className="list-item"
                  onClick={() => navigate({ name: 'chat', sessionId: id })}
                >
                  <span className="list-title">{session.title ?? 'Untitled chat'}</span>
                  <span className="muted small">
                    {session.turns.length} new message(s) · {session.model} · {when(createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <h2>Saved ChatGPT chats</h2>
        {transcripts.length === 0 ? (
          <p className="muted small">
            Nothing saved yet. Chats you get stay on this device until you delete them.
          </p>
        ) : (
          <ul className="list" data-testid="library">
            {transcripts.map((t) => {
              const source = sourceSummary(t.method, t.completeness);
              return (
                <li key={t.id}>
                  <button
                    className="list-item"
                    onClick={() => navigate({ name: 'transcript', id: t.id })}
                  >
                    <span className="list-title">{t.title ?? 'Untitled chat'}</span>
                    <span className="row small">
                      <Badge tone={source.tone}>
                        {source.tone === 'good'
                          ? 'Complete'
                          : source.tone === 'bad'
                            ? 'Incomplete'
                            : 'From page'}
                      </Badge>
                      <span className="muted">
                        {t.messageCount} messages · {when(t.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
