import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/migration/session';
import { Badge, ErrorBox, MessageView } from '../components/ui';
import type { Navigate } from '../routes';
import { chatRetry, chatSend, loadSession } from '../services';

export function ChatPage({ sessionId, navigate }: { sessionId: string; navigate: Navigate }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadSession(sessionId).then(setSession, (err: unknown) => setError(err));
    return () => abort.current?.abort();
  }, [sessionId]);

  useEffect(() => {
    // Block body on purpose: newer Chromium returns a Promise from scrollIntoView,
    // and React would treat a returned value as the effect's cleanup function.
    void bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [session, streaming]);

  if (!session) return error ? <ErrorBox error={error} /> : <p className="muted">Loading…</p>;

  const busy = streaming !== null;
  const last = session.turns.at(-1);
  const canRetry = !busy && last?.role === 'model' && last.status !== 'complete';

  const act = async (fn: (signal: AbortSignal) => Promise<Session>) => {
    abort.current = new AbortController();
    setError(null);
    setStreaming('');
    try {
      setSession(await fn(abort.current.signal));
    } catch (err) {
      console.error('[ChatBridge] chat request failed', err);
      setError(err);
      // The failed turn was persisted; reload to show it.
      setSession(await loadSession(sessionId).catch(() => session));
    } finally {
      setStreaming(null);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void act((signal) => chatSend(sessionId, session, text, setStreaming, signal));
  };

  return (
    <div className="chat">
      <section className="card chat-banner" data-testid="destination-banner">
        <p className="small">
          <Badge tone="warn">API chat</Badge> {session.destinationLabel}
        </p>
        <p className="muted small">
          {session.title ?? 'Untitled conversation'} · {session.model} · {session.importedTurnCount}{' '}
          imported turn(s) ·{' '}
          <button
            className="link"
            onClick={() => navigate({ name: 'transcript', id: session.transcriptId })}
          >
            original transcript
          </button>
        </p>
        <details>
          <summary className="small">What Gemini received</summary>
          <pre className="doc" data-testid="system-instruction">
            {session.systemInstruction}
          </pre>
        </details>
      </section>

      <div className="messages" data-testid="chat-turns">
        {session.turns.length === 0 && !busy && (
          <p className="muted small">
            The imported conversation is loaded. Send a message to continue it.
          </p>
        )}
        {session.turns
          .filter((t) => !(busy && t.status === 'pending'))
          .map((t) => (
            <MessageView
              key={t.id}
              message={{
                id: t.id,
                role: t.role,
                content: [
                  {
                    type: 'text',
                    text: t.text || (t.status === 'pending' ? '…' : ''),
                    format: 'plain',
                  },
                ],
              }}
              aside={
                t.status !== 'complete' ? (
                  <Badge tone={t.status === 'pending' ? 'info' : 'bad'}>{t.status}</Badge>
                ) : null
              }
            />
          ))}
        {busy && (
          <MessageView
            message={{
              id: 'streaming',
              role: 'model',
              content: [{ type: 'text', text: streaming || '…', format: 'plain' }],
            }}
            aside={<Badge tone="info">Gemini is replying</Badge>}
          />
        )}
        {last?.error && !busy && <p className="error small">{last.error}</p>}
        <div ref={bottom} />
      </div>

      <ErrorBox error={error} />
      <div className="composer">
        <textarea
          className="input"
          rows={3}
          value={draft}
          placeholder="Continue the conversation…"
          aria-label="Message"
          data-testid="composer"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="actions">
          {busy ? (
            <button className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={!draft.trim()}>
              Send
            </button>
          )}
          {canRetry && (
            <button
              className="btn"
              onClick={() =>
                void act((signal) => chatRetry(sessionId, session, setStreaming, signal))
              }
            >
              Retry last message
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
