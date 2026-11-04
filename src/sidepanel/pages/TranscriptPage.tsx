import { useEffect, useRef, useState } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type ContextItem,
  toSpecShape,
} from '../../core/context/schema';
import { estimateMessageTokens } from '../../core/token-management/estimate';
import { deleteTranscript, type TranscriptRecord } from '../../storage/db';
import { getSettings } from '../../storage/settings';
import {
  Badge,
  CompletenessBadge,
  Consent,
  ErrorBox,
  MessageView,
  MethodBadge,
  copyText,
  useAsync,
} from '../components/ui';
import type { Navigate } from '../routes';
import {
  type StoredProfile,
  analyzeLocally,
  analyzeWithGemini,
  latestProfile,
  loadTranscript,
} from '../services';

const STATUS_TONE: Record<ContextItem['status'], 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  confirmed: 'good',
  proposed: 'info',
  inferred: 'warn',
  superseded: 'neutral',
  contradicted: 'bad',
};

export function TranscriptPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const [record, setRecord] = useState<TranscriptRecord | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [deep, runDeep] = useAsync<StoredProfile>();
  const [progress, setProgress] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await loadTranscript(id);
      // The local pass is offline and cheap, so it runs automatically.
      const p = (await latestProfile(id)) ?? (await analyzeLocally(r));
      const s = await getSettings();
      if (!cancelled) {
        setRecord(r);
        setProfile(p);
        setModel(s.model);
      }
    })().catch((err: unknown) => {
      console.error('[ChatBridge] loading transcript failed', err);
      if (!cancelled) setLoadError(err);
    });
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, [id]);

  if (loadError) return <ErrorBox error={loadError} />;
  if (!record || !profile) return <p className="muted">Loading…</p>;

  const c = record.conversation;
  const x = c.extraction;
  const visible = c.messages.filter((m) => m.visibility === 'visible');
  const tokens = visible.reduce((a, m) => a + estimateMessageTokens(m), 0);
  const p = profile.profile;

  const runGemini = async () => {
    if (!model) return;
    abort.current = new AbortController();
    const result = await runDeep(() =>
      analyzeWithGemini(
        record,
        model,
        (d, t) => setProgress(`Analyzing part ${d} of ${t}…`),
        abort.current!.signal,
      ),
    );
    setProgress('');
    if (result) setProfile(result);
  };

  return (
    <div className="stack">
      <section className="card" data-testid="extraction-report">
        <p className="eyebrow">Transcript</p>
        <h2 className="title">{c.title ?? 'Untitled conversation'}</h2>
        <div className="row">
          <MethodBadge method={x.method} />
          <CompletenessBadge value={x.completeness} />
          <span className="muted small">{new Date(x.extractedAt).toLocaleString()}</span>
        </div>
        <dl className="stats">
          <div>
            <dt>Messages</dt>
            <dd data-testid="transcript-count">{c.messages.length}</dd>
          </div>
          <div>
            <dt>Other branches</dt>
            <dd>{x.offPathMessages}</dd>
          </div>
          <div>
            <dt>~Tokens</dt>
            <dd>{tokens.toLocaleString()}</dd>
          </div>
        </dl>
        <ul className="small reasons">
          {x.completenessReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {x.method === 'dom' && (
          <p className="small">
            Need every branch, timestamps and custom instructions?{' '}
            <button className="link" onClick={() => navigate({ name: 'import' })}>
              Import the export file
            </button>
            .
          </p>
        )}
        {(x.warnings.length > 0 || x.excluded.length > 0) && (
          <details>
            <summary>
              {x.warnings.length} warning(s), {x.excluded.length} excluded item(s)
            </summary>
            <ul className="small">
              {x.warnings.map((w, i) => (
                <li key={`w${i}`}>
                  <Badge tone="warn">{w.code}</Badge> {w.message}
                </li>
              ))}
              {x.excluded.map((e, i) => (
                <li key={`e${i}`}>
                  <Badge>excluded</Badge> {e.contentType ?? e.role ?? 'item'}: {e.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card" data-testid="context-profile">
        <div className="row spread">
          <h2>Context</h2>
          <span className="row small">
            {p.passes.map((pass) => (
              <Badge key={pass} tone="info">
                {pass === 'llm' ? `Gemini (${p.model})` : 'local rules'}
              </Badge>
            ))}
          </span>
        </div>
        {p.conversationSummary && <p className="summary">{p.conversationSummary}</p>}
        {CATEGORIES.map((category) =>
          p.items[category].length === 0 ? null : (
            <div key={category} className="category">
              <h3>{CATEGORY_LABELS[category]}</h3>
              <ul>
                {[...p.items[category]]
                  .sort((a, b) => a.order - b.order)
                  .map((item) => (
                    <li
                      key={item.id}
                      className={item.status === 'superseded' ? 'struck' : undefined}
                    >
                      <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>{' '}
                      <span className="item-text">{item.text}</span>
                      {item.resolved === true && <Badge tone="good">fixed</Badge>}
                      <span className="evidence">
                        {item.evidence.map((e) => (
                          <a key={e.messageId} href={`#msg-${e.messageId}`} title={e.quote}>
                            #{c.messages.findIndex((m) => m.id === e.messageId) + 1}
                          </a>
                        ))}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ),
        )}
        <p className="muted small">
          {p.stats.messagesAnalyzed} messages analyzed.
          {p.passes.includes('llm') &&
            ` Dropped ${p.stats.droppedForMissingEvidence + p.stats.droppedForUnverifiedQuote} unverifiable item(s); downgraded ${p.stats.downgradedAssistantOnly} assistant-only claim(s).`}{' '}
          Every item links to the message it came from.
        </p>

        <details className="advanced">
          <summary>Deeper analysis with Gemini</summary>
          {model ? (
            <Consent
              to="Google Gemini"
              what={`${visible.length} messages (~${tokens.toLocaleString()} tokens) of this conversation will be sent to the Gemini API (model ${model}) to extract project context. Results are checked against the transcript; anything without a verifiable quote is discarded.`}
              actionLabel="Analyze with Gemini"
              busy={deep.status === 'running'}
              onConfirm={() => void runGemini()}
            />
          ) : (
            <p className="small">
              Add a Gemini API key and choose a model in{' '}
              <button className="link" onClick={() => navigate({ name: 'settings' })}>
                Settings
              </button>
              .
            </p>
          )}
          {deep.status === 'running' && (
            <p className="small">
              {progress || 'Starting…'}{' '}
              <button className="link" onClick={() => abort.current?.abort()}>
                Cancel
              </button>{' '}
              (finished parts are saved and reused)
            </p>
          )}
          <ErrorBox error={deep.error} />
        </details>

        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={() => navigate({ name: 'migrate', transcriptId: id })}
          >
            Prepare migration
          </button>
          <button
            className="btn"
            onClick={() => void copyText(JSON.stringify(toSpecShape(p), null, 2))}
          >
            Copy context JSON
          </button>
        </div>
      </section>

      <details className="card">
        <summary>Transcript ({c.messages.length} messages)</summary>
        <div className="messages">
          {c.messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              aside={<span className="muted small">#{i + 1}</span>}
            />
          ))}
        </div>
      </details>

      <section className="card">
        {confirmDelete ? (
          <div className="row">
            <span className="small">Delete this transcript and its analyses, plans and chats?</span>
            <button
              className="btn btn-danger"
              onClick={() =>
                void deleteTranscript(id).then(
                  () => navigate({ name: 'home' }),
                  (err: unknown) => setLoadError(err),
                )
              }
            >
              Delete
            </button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setConfirmDelete(true)}>
            Delete transcript…
          </button>
        )}
      </section>
    </div>
  );
}
