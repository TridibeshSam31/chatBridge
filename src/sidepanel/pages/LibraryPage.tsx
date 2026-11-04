import { useEffect, useState } from 'react';
import type { Session } from '../../core/migration/session';
import { listTranscripts } from '../../storage/db';
import { CompletenessBadge, ErrorBox, MethodBadge } from '../components/ui';
import type { Navigate } from '../routes';
import { listSessions } from '../services';

type Transcripts = Awaited<ReturnType<typeof listTranscripts>>;

/** Everything stored locally: extracted transcripts and continued chats. */
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
          <h2>Continued chats</h2>
          <ul className="list">
            {sessions.map(({ id, createdAt, session }) => (
              <li key={id}>
                <button
                  className="list-item"
                  onClick={() => navigate({ name: 'chat', sessionId: id })}
                >
                  <span className="list-title">{session.title ?? 'Untitled conversation'}</span>
                  <span className="muted small">
                    {session.model} · {session.turns.length} new turn(s) ·{' '}
                    {new Date(createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <h2>Saved transcripts</h2>
        {transcripts.length === 0 ? (
          <p className="muted small">
            Nothing extracted yet. Transcripts stay on this device until you delete them.
          </p>
        ) : (
          <ul className="list" data-testid="library">
            {transcripts.map((t) => (
              <li key={t.id}>
                <button
                  className="list-item"
                  onClick={() => navigate({ name: 'transcript', id: t.id })}
                >
                  <span className="list-title">{t.title ?? 'Untitled conversation'}</span>
                  <span className="row small">
                    <MethodBadge method={t.method} />
                    <CompletenessBadge value={t.completeness} />
                    <span className="muted">
                      {t.messageCount} messages · {new Date(t.createdAt).toLocaleString()}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
