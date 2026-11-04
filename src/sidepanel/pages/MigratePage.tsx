import { useEffect, useMemo, useRef, useState } from 'react';
import { renderWebPackage } from '../../core/context/render';
import { styleGuideFor } from '../../core/context/style';
import { estimateTextTokens } from '../../core/token-management/estimate';
import { type MigrationMode, buildPlan } from '../../core/migration/plan';
import type { ModelInfo } from '../../providers/gemini/client';
import { GEMINI_DESTINATION_LABEL } from '../../providers/gemini/session';
import type { TranscriptRecord } from '../../storage/db';
import { type Settings, getApiKey, getSettings } from '../../storage/settings';
import { Badge, Consent, ErrorBox, copyText, useAsync } from '../components/ui';
import type { Navigate } from '../routes';
import {
  PREAMBLE_TOKENS,
  type StoredProfile,
  contextDocumentFor,
  latestProfile,
  listModels,
  loadTranscript,
  startMigration,
} from '../services';

const MODES: { value: MigrationMode; label: string; detail: string }[] = [
  {
    value: 'full',
    label: 'Full history',
    detail:
      'Every message, in order, as real chat turns. Never truncated: if it does not fit, it will not start.',
  },
  {
    value: 'smart',
    label: 'Smart',
    detail:
      'The structured context document plus only the messages you pin. Best for very long chats.',
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    detail:
      'Context document, recent messages and the messages that back key decisions; older parts are summarized.',
  },
];

const OUTPUT_RESERVE = 8192;
/** Long single messages are unreliable in the gemini.google.com composer. */
const WEB_PACKAGE_SOFT_LIMIT = 100_000;

export function MigratePage({
  transcriptId,
  navigate,
}: {
  transcriptId: string;
  navigate: Navigate;
}) {
  const [record, setRecord] = useState<TranscriptRecord | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelError, setModelError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [mode, setMode] = useState<MigrationMode>('full');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState(200_000);
  const [recent, setRecent] = useState(20);
  const [summarize, setSummarize] = useState(true);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [migration, runMigration] = useAsync<string>();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      const [r, p, s, key] = await Promise.all([
        loadTranscript(transcriptId),
        latestProfile(transcriptId),
        getSettings(),
        getApiKey(),
      ]);
      setRecord(r);
      setProfile(p);
      setSettings(s);
      setBudget(s.budgetTokens);
      setRecent(s.recentTurns);
      setModel(s.model ?? '');
      setHasKey(key !== null);
      if (key) {
        listModels().then(
          (list) => {
            setModels(list);
            setModel((current) => current || list[0]?.name || '');
          },
          (err: unknown) => setModelError(err),
        );
      }
    })().catch((err: unknown) => {
      console.error('[ChatBridge] loading migration page failed', err);
      setLoadError(err);
    });
    return () => abort.current?.abort();
  }, [transcriptId]);

  const contextDocument = useMemo(
    () => (record ? contextDocumentFor(profile?.profile ?? null, record.conversation) : ''),
    [record, profile],
  );
  // Upper bound for the plan: the guide with every example (some are dropped
  // later when the history already contains them).
  const styleGuide = useMemo(() => (record ? styleGuideFor(record.conversation) : ''), [record]);
  const modelInfo = models?.find((m) => m.name === model) ?? null;

  const plan = useMemo(() => {
    if (!record) return null;
    return buildPlan({
      conversation: record.conversation,
      transcriptId,
      profile: profile?.profile ?? null,
      profileId: profile?.id ?? null,
      contextDocument,
      mode,
      provider: 'gemini',
      model: model || 'unselected',
      modelInputLimit: modelInfo?.inputTokenLimit ?? null,
      budgetTokens: Math.max(1000, budget),
      outputReserve: Math.min(OUTPUT_RESERVE, modelInfo?.outputTokenLimit ?? OUTPUT_RESERVE),
      preambleTokens: PREAMBLE_TOKENS + estimateTextTokens(styleGuide),
      recentMessages: recent,
      pinned,
      summarizeSegments: summarize,
    });
  }, [
    record,
    profile,
    contextDocument,
    styleGuide,
    mode,
    model,
    modelInfo,
    budget,
    recent,
    pinned,
    summarize,
    transcriptId,
  ]);

  if (loadError) return <ErrorBox error={loadError} />;
  if (!record || !settings || !plan) return <p className="muted">Loading…</p>;

  const conv = record.conversation;
  const includedMessages = conv.messages.filter(
    (m) => plan.entries.find((e) => e.messageId === m.id)?.status === 'included',
  );
  const webPackage = profile ? renderWebPackage(profile.profile, conv, includedMessages) : '';
  const summarizedForSegments = plan.summarizeSegments
    ? plan.segments.reduce((a, s) => a + s.messageIds.length, 0)
    : 0;

  const start = async () => {
    abort.current = new AbortController();
    const id = await runMigration(() =>
      startMigration({
        plan,
        conversation: conv,
        contextDocument,
        onStatus: setStatus,
        signal: abort.current!.signal,
      }),
    );
    if (id) navigate({ name: 'chat', sessionId: id });
  };

  const togglePin = (id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="stack">
      <section className="card">
        <p className="eyebrow">Migrate · {conv.title ?? 'Untitled conversation'}</p>
        <fieldset className="modes">
          <legend>Mode</legend>
          {MODES.map((m) => (
            <label key={m.value} className="mode">
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <span>
                <strong>{m.label}</strong>
                <span className="muted small"> — {m.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode !== 'full' && !profile && (
          <p className="warn small">Run the context analysis first.</p>
        )}

        <div className="grid2">
          <label className="field">
            <span>Gemini model</span>
            {models ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="model-select"
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.displayName}
                    {m.inputTokenLimit ? ` · ${(m.inputTokenLimit / 1000).toFixed(0)}k in` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={model}
                placeholder={hasKey ? 'Loading models…' : 'Add an API key in Settings'}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </label>
          <label className="field">
            <span>Context budget (tokens)</span>
            <input
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value) || 0)}
              data-testid="budget"
            />
          </label>
          {mode === 'hybrid' && (
            <>
              <label className="field">
                <span>Recent messages kept verbatim</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={500}
                  value={recent}
                  onChange={(e) => setRecent(Number(e.target.value) || 0)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={summarize}
                  onChange={(e) => setSummarize(e.target.checked)}
                />
                <span>Summarize omitted parts with Gemini</span>
              </label>
            </>
          )}
        </div>
        <ErrorBox error={modelError} />
        <p className="muted small">
          The budget is what ChatBridge will send per message, not the model’s maximum: Gemini
          re-reads the whole history on every turn, so larger budgets cost more and respond slower.
          Token counts are conservative local estimates.
        </p>
      </section>

      <section className="card" data-testid="plan-preview">
        <div className="row spread">
          <h2>Preview</h2>
          {plan.fits ? <Badge tone="good">fits</Badge> : <Badge tone="bad">does not fit</Badge>}
        </div>
        <dl className="stats">
          <div>
            <dt>Included</dt>
            <dd data-testid="plan-included">{plan.totals.included}</dd>
          </div>
          <div>
            <dt>Summarized</dt>
            <dd>{plan.totals.summarized}</dd>
          </div>
          <div>
            <dt>Excluded</dt>
            <dd>{plan.totals.excluded}</dd>
          </div>
        </dl>
        <p className="small">
          ~{plan.totals.totalTokens.toLocaleString()} tokens total (history{' '}
          {plan.totals.historyTokens.toLocaleString()}, context{' '}
          {plan.contextTokens.toLocaleString()}, instructions {plan.preambleTokens.toLocaleString()}
          ) · reserve {plan.budget.outputReserve.toLocaleString()} for the reply.
        </p>
        {plan.problems.map((p) => (
          <p key={p} className="warn small" data-testid="plan-problem">
            {p}
          </p>
        ))}
        <details>
          <summary>Every message ({plan.entries.length}) — pin to always include</summary>
          <table className="plan-table">
            <tbody>
              {plan.entries.map((e, i) => (
                <tr key={e.messageId}>
                  <td>#{i + 1}</td>
                  <td>{e.role}</td>
                  <td>
                    <Badge
                      tone={
                        e.status === 'included'
                          ? 'good'
                          : e.status === 'summarized'
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {e.status}
                    </Badge>
                  </td>
                  <td className="muted">{e.reason}</td>
                  <td>{e.tokens}</td>
                  <td>
                    {mode !== 'full' && conv.messages[i]?.visibility === 'visible' && (
                      <input
                        type="checkbox"
                        aria-label={`Pin message ${i + 1}`}
                        checked={pinned.has(e.messageId)}
                        onChange={() => togglePin(e.messageId)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {contextDocument && mode !== 'full' && (
          <details>
            <summary>Context document Gemini will receive</summary>
            <pre className="doc">{contextDocument}</pre>
          </details>
        )}
        {styleGuide && (
          <details>
            <summary>Response style Gemini will match</summary>
            <pre className="doc" data-testid="style-guide">
              {styleGuide}
            </pre>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Continue with the Gemini API</h2>
        <p className="small">
          <Badge tone="warn">API chat</Badge> {GEMINI_DESTINATION_LABEL}. You will continue the
          conversation here in the side panel, using your own API key.
        </p>
        {hasKey ? (
          <Consent
            to="Google Gemini"
            what={`${plan.totals.included} message(s) verbatim (~${plan.totals.historyTokens.toLocaleString()} tokens)${plan.contextTokens ? ', the context document' : ''}${summarizedForSegments ? `, and ${summarizedForSegments} older message(s) to be summarized` : ''} will be sent to the Gemini API (model ${model || '—'}). Every new message you send resends this history.`}
            actionLabel="Start migration"
            disabled={!plan.fits || !model}
            busy={migration.status === 'running'}
            onConfirm={() => void start()}
          />
        ) : (
          <p className="small">
            <button className="link" onClick={() => navigate({ name: 'settings' })}>
              Add a Gemini API key
            </button>{' '}
            to start an API chat.
          </p>
        )}
        {migration.status === 'running' && (
          <p className="small" role="status">
            {status}{' '}
            <button className="link" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </p>
        )}
        <ErrorBox error={migration.error} />
      </section>

      <section className="card">
        <h2>Or paste into gemini.google.com</h2>
        <p className="small muted">
          The Gemini website cannot import chat history, so this is a single message containing the
          context
          {includedMessages.length > 0 ? ` and ${includedMessages.length} original message(s)` : ''}
          . It is not a native Gemini conversation.{' '}
          {webPackage.length > WEB_PACKAGE_SOFT_LIMIT &&
            'This package is very long; the website may reject it — use Smart mode or fewer pinned messages.'}
        </p>
        <div className="actions">
          <button
            className="btn"
            disabled={!webPackage}
            onClick={() => void copyText(webPackage).then((ok) => setCopied(ok ? 'ok' : 'failed'))}
          >
            {copied === 'ok'
              ? 'Copied'
              : copied === 'failed'
                ? 'Copy failed'
                : 'Copy migration package'}
          </button>
          <button
            className="btn"
            onClick={() => void chrome.tabs.create({ url: 'https://gemini.google.com/app' })}
          >
            Open gemini.google.com
          </button>
        </div>
        {!profile && <p className="muted small">Run the context analysis to build a package.</p>}
      </section>
    </div>
  );
}
