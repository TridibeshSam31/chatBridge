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
  Callout,
  CompletenessBadge,
  Consent,
  ErrorBox,
  MessageView,
  MethodBadge,
  Spinner,
  Stepper,
  copyText,
  sourceSummary,
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

/** Only uncertain items get a label; confirmed ones speak for themselves. */
const STATUS_LABEL: Record<
  ContextItem['status'],
  { label: string; tone: 'info' | 'warn' | 'bad' | 'neutral' } | null
> = {
  confirmed: null,
  proposed: { label: 'suggested by ChatGPT', tone: 'info' },
  inferred: { label: 'best guess', tone: 'warn' },
  superseded: { label: 'replaced later', tone: 'neutral' },
  contradicted: { label: 'conflicting', tone: 'bad' },
};

/** Warnings worth interrupting the user for, in plain words. */
const IMPORTANT_WARNINGS: Record<string, string> = {
  SCROLL_INCOMPLETE:
    'Some messages are missing — ChatBridge could not scroll through the whole chat.',
  SUSPICIOUS_CONTENT:
    'The messages look wrong (many are identical). ChatGPT’s page may have changed.',
  EMPTY_MESSAGES: 'Some messages came out empty.',
  STILL_GENERATING: 'ChatGPT was still writing a reply, so the last message may be cut off.',
};

export function TranscriptPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const [record, setRecord] = useState<TranscriptRecord | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [deep, runDeep] = useAsync<StoredProfile>();
  const [progress, setProgress] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const source = sourceSummary(x.method, x.completeness);
  const important = x.warnings.filter((w) => w.code in IMPORTANT_WARNINGS);
  const itemCount = CATEGORIES.reduce((n, cat) => n + p.items[cat].length, 0);

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
      <section className="card hero" data-testid="extraction-report">
        <Stepper current={2} />
        <p className="section-title">Review</p>
        <h2 className="title">{c.title ?? 'Untitled chat'}</h2>
        <p className="meta">
          <span data-testid="transcript-count">{c.messages.length}</span> messages
          {x.method === 'internal-api' && ' · got with one-click'}
          {x.method === 'dom' && ' · read from the page'}
          {x.method === 'export' && ' · from your export file'}
        </p>

        {important.length > 0 ? (
          <Callout tone="bad" title={source.label} testId="extraction-problems">
            {important.map((w) => (
              <p key={w.code}>{IMPORTANT_WARNINGS[w.code]}</p>
            ))}
            <p className="small">
              For the whole chat, use one-click on the start screen, or{' '}
              <button className="link" onClick={() => navigate({ name: 'import' })}>
                import your export file
              </button>
              .
            </p>
          </Callout>
        ) : (
          <Callout tone={source.tone} title={source.label}>
            {source.tone !== 'good' && (
              <p className="small">Scroll through the messages below and compare with ChatGPT.</p>
            )}
          </Callout>
        )}

        <button
          className="btn btn-primary btn-lg"
          onClick={() => navigate({ name: 'migrate', transcriptId: id })}
        >
          Continue in Gemini →
        </button>

        <details className="more">
          <summary>Technical details</summary>
          <div className="row">
            <MethodBadge method={x.method} />
            <CompletenessBadge value={x.completeness} />
            <span className="muted small">{new Date(x.extractedAt).toLocaleString()}</span>
          </div>
          <p className="small">
            ~{tokens.toLocaleString()} tokens · {x.offPathMessages} message(s) in other branches
          </p>
          <ul className="small reasons">
            {x.completenessReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {(x.warnings.length > 0 || x.excluded.length > 0) && (
            <ul className="small">
              {x.warnings.map((w, i) => (
                <li key={`w${i}`}>
                  <Badge tone="warn">{w.code}</Badge> {w.message}
                </li>
              ))}
              {x.excluded.map((e, i) => (
                <li key={`e${i}`}>
                  <Badge>not transferred</Badge> {e.contentType ?? e.role ?? 'item'}: {e.reason}
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>

      <section className="card" data-testid="context-profile">
        <h2>What ChatBridge understood</h2>
        <p className="muted small">
          Gemini gets this along with the chat, so it knows your project, decisions and preferences.
          Click a number to see the message it came from.
        </p>
        {p.conversationSummary && <p className="summary">{p.conversationSummary}</p>}
        {itemCount === 0 && (
          <p className="muted small">Nothing specific found — Gemini will rely on the messages.</p>
        )}
        {CATEGORIES.map((category) =>
          p.items[category].length === 0 ? null : (
            <div key={category} className="category">
              <h3>{CATEGORY_LABELS[category]}</h3>
              <ul>
                {[...p.items[category]]
                  .sort((a, b) => a.order - b.order)
                  .map((item) => {
                    const status = STATUS_LABEL[item.status];
                    return (
                      <li
                        key={item.id}
                        className={item.status === 'superseded' ? 'struck' : undefined}
                      >
                        <span className="item-text">{item.text}</span>{' '}
                        {status && <Badge tone={status.tone}>{status.label}</Badge>}
                        {item.resolved === true && <Badge tone="good">fixed</Badge>}
                        <span className="evidence">
                          {item.evidence.map((e) => (
                            <a key={e.messageId} href={`#msg-${e.messageId}`} title={e.quote}>
                              #{c.messages.findIndex((m) => m.id === e.messageId) + 1}
                            </a>
                          ))}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ),
        )}

        <details className="more advanced">
          <summary>Improve this with Gemini (optional)</summary>
          <p className="small muted">
            The list above was made on your computer with simple rules. Gemini can read the whole
            chat and find more. Anything it can’t back up with an exact quote is thrown away.
          </p>
          {model ? (
            <Consent
              to="Google Gemini"
              what={`${visible.length} messages (~${tokens.toLocaleString()} tokens) will be sent to the Gemini API (model ${model}).`}
              actionLabel="Analyze with Gemini"
              busy={deep.status === 'running'}
              onConfirm={() => void runGemini()}
            />
          ) : (
            <p className="small">
              Add your Gemini API key on the next step first (Continue in Gemini).
            </p>
          )}
          {deep.status === 'running' && (
            <p className="status" role="status">
              <Spinner /> {progress || 'Starting…'}{' '}
              <button className="link" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </p>
          )}
          <ErrorBox error={deep.error} />
        </details>
      </section>

      <details className="card">
        <summary>Show all {c.messages.length} messages</summary>
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

      <details className="card more">
        <summary>More</summary>
        <div className="actions">
          <button
            className="btn"
            onClick={() =>
              void copyText(JSON.stringify(toSpecShape(p), null, 2)).then((ok) => setCopied(ok))
            }
          >
            {copied ? 'Copied' : 'Copy context as JSON'}
          </button>
          {!confirmDelete && (
            <button className="btn" onClick={() => setConfirmDelete(true)}>
              Delete this chat…
            </button>
          )}
        </div>
        {confirmDelete && (
          <div className="row">
            <span className="small">
              Delete this chat from ChatBridge, with its analysis and Gemini chats?
            </span>
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
        )}
      </details>
    </div>
  );
}
