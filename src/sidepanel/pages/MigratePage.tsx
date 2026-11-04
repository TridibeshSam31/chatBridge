import { useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedConversation } from '../../core/conversation/schema';
import { renderWebPackage } from '../../core/context/render';
import { styleGuideFor } from '../../core/context/style';
import { estimateTextTokens } from '../../core/token-management/estimate';
import { type MigrationMode, buildPlan } from '../../core/migration/plan';
import type { ModelInfo } from '../../providers/gemini/client';
import type { TranscriptRecord } from '../../storage/db';
import {
  type Settings,
  getApiKey,
  getSettings,
  setApiKey,
  updateSettings,
} from '../../storage/settings';
import {
  Badge,
  Callout,
  Consent,
  ErrorBox,
  Spinner,
  Stepper,
  copyText,
  useAsync,
} from '../components/ui';
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
    label: 'Whole chat',
    detail: 'Gemini gets every message word for word. Best for short and medium chats.',
  },
  {
    value: 'hybrid',
    label: 'Recent messages + summary',
    detail:
      'Recent messages word for word; older parts summarized. Best for long chats — cheaper and faster.',
  },
  {
    value: 'smart',
    label: 'Summary only',
    detail:
      'Only what ChatBridge understood: your project, decisions, preferences and current task. Smallest.',
  },
];

const OUTPUT_RESERVE = 8192;
/** Long single messages are unreliable in the gemini.google.com composer. */
const WEB_PACKAGE_SOFT_LIMIT = 100_000;

interface PlanInputs {
  conversation: NormalizedConversation;
  transcriptId: string;
  profile: StoredProfile | null;
  contextDocument: string;
  styleTokens: number;
  mode: MigrationMode;
  model: string;
  modelInfo: ModelInfo | null;
  budget: number;
  recent: number;
  pinned: Set<string>;
  summarize: boolean;
}

function planFor(i: PlanInputs) {
  return buildPlan({
    conversation: i.conversation,
    transcriptId: i.transcriptId,
    profile: i.profile?.profile ?? null,
    profileId: i.profile?.id ?? null,
    contextDocument: i.contextDocument,
    mode: i.mode,
    provider: 'gemini',
    model: i.model || 'unselected',
    modelInputLimit: i.modelInfo?.inputTokenLimit ?? null,
    budgetTokens: Math.max(1000, i.budget),
    outputReserve: Math.min(OUTPUT_RESERVE, i.modelInfo?.outputTokenLimit ?? OUTPUT_RESERVE),
    preambleTokens: PREAMBLE_TOKENS + i.styleTokens,
    recentMessages: i.recent,
    pinned: i.pinned,
    summarizeSegments: i.summarize,
  });
}

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

  const loadModels = (refresh = false) =>
    listModels(refresh).then(
      (list) => {
        setModels(list);
        setModelError(null);
        setModel((current) => current || list[0]?.name || '');
        return list;
      },
      (err: unknown) => {
        setModelError(err);
        return null;
      },
    );

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
      // Recommend the whole chat when it fits the default budget, else recent + summary.
      const fullFits = planFor({
        conversation: r.conversation,
        transcriptId,
        profile: p,
        contextDocument: contextDocumentFor(p?.profile ?? null, r.conversation),
        styleTokens: estimateTextTokens(styleGuideFor(r.conversation)),
        mode: 'full',
        model: s.model ?? '',
        modelInfo: null,
        budget: s.budgetTokens,
        recent: s.recentTurns,
        pinned: new Set(),
        summarize: true,
      }).fits;
      setMode(fullFits || !p ? 'full' : 'hybrid');
      if (key) void loadModels();
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
    return planFor({
      conversation: record.conversation,
      transcriptId,
      profile,
      contextDocument,
      styleTokens: estimateTextTokens(styleGuide),
      mode,
      model,
      modelInfo,
      budget,
      recent,
      pinned,
      summarize,
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
  const needsProfile = mode !== 'full' && !profile;

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

  const copyAndOpen = async () => {
    const ok = await copyText(webPackage);
    setCopied(ok ? 'ok' : 'failed');
    if (ok) void chrome.tabs.create({ url: 'https://gemini.google.com/app' });
  };

  return (
    <div className="stack">
      <section className="card hero">
        <Stepper current={3} />
        <p className="section-title">Continue in Gemini</p>
        <h2 className="title">{conv.title ?? 'Untitled chat'}</h2>
        <p className="meta">
          Gemini will pick up this chat where you left off, in the same style ChatGPT answered you.
        </p>
      </section>

      {!hasKey && (
        <KeySetup
          onSaved={async () => {
            setHasKey(true);
            const list = await loadModels(true);
            const first = list?.[0]?.name;
            if (first && !settings.model) setSettings(await updateSettings({ model: first }));
          }}
        />
      )}

      <section className="card" data-testid="plan-preview">
        <h2>How much should Gemini get?</h2>
        <fieldset className="choices">
          <legend className="sr-only">Amount of the chat to send</legend>
          {MODES.map((m) => (
            <label key={m.value} className="choice">
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <span>
                <span className="choice-title">{m.label}</span>
                <span className="muted small">{m.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {needsProfile ? (
          <Callout tone="warn" title="Go back to Review first">
            <p className="small">This option needs the summary from the Review step.</p>
          </Callout>
        ) : plan.fits ? (
          <Callout tone="good" title="Ready" testId="plan-ready">
            <p className="small">
              Gemini gets <strong data-testid="plan-included">{plan.totals.included}</strong>{' '}
              message(s) word for word
              {plan.totals.summarized > 0 && `, ${plan.totals.summarized} as a summary`}
              {plan.contextTokens > 0 && ', plus what ChatBridge understood'}.
              {plan.totals.excluded > 0 &&
                ` ${plan.totals.excluded} item(s) can’t be sent (like images).`}
            </p>
          </Callout>
        ) : (
          <Callout tone="bad" title="Too long for this option">
            {plan.problems.map((p) => (
              <p key={p} className="small" data-testid="plan-problem">
                {p}
              </p>
            ))}
            <p className="small">
              Pick “Recent messages + summary”, or raise the limit under Advanced.
            </p>
            <span hidden data-testid="plan-included">
              {plan.totals.included}
            </span>
          </Callout>
        )}

        <details className="more">
          <summary>Advanced</summary>
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
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  value={model}
                  placeholder={hasKey ? 'Loading models…' : 'Add your API key first'}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
            </label>
            <label className="field">
              <span>Most text to send (tokens)</span>
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
                  <span>Recent messages kept word for word</span>
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
                  <span>Let Gemini summarize the older parts</span>
                </label>
              </>
            )}
          </div>
          <ErrorBox error={modelError} />
          <p className="muted small">
            Gemini re-reads everything you send on every new message, so sending more costs more and
            replies slower. ~{plan.totals.totalTokens.toLocaleString()} tokens with these settings
            (estimate).
          </p>
          <details>
            <summary>What happens to each message ({plan.entries.length})</summary>
            {mode !== 'full' && (
              <p className="muted small">Tick a message to always send it word for word.</p>
            )}
            <table className="plan-table">
              <tbody>
                {plan.entries.map((e, i) => (
                  <tr key={e.messageId}>
                    <td>#{i + 1}</td>
                    <td>
                      {e.role === 'assistant' ? 'ChatGPT' : e.role === 'user' ? 'You' : e.role}
                    </td>
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
                        {e.status === 'included'
                          ? 'word for word'
                          : e.status === 'summarized'
                            ? 'summarized'
                            : 'not sent'}
                      </Badge>
                    </td>
                    <td className="muted">{e.reason}</td>
                    <td>
                      {mode !== 'full' && conv.messages[i]?.visibility === 'visible' && (
                        <input
                          type="checkbox"
                          aria-label={`Always send message ${i + 1}`}
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
              <summary>The summary Gemini will get</summary>
              <pre className="doc">{contextDocument}</pre>
            </details>
          )}
          {styleGuide && (
            <details>
              <summary>The answer style Gemini will match</summary>
              <pre className="doc" data-testid="style-guide">
                {styleGuide}
              </pre>
            </details>
          )}
        </details>
      </section>

      <section className="card">
        <h2>Start the Gemini chat</h2>
        <p className="muted small">
          You’ll chat with Gemini right here in this panel, using your API key. These chats are
          saved in ChatBridge and don’t appear in gemini.google.com.
        </p>
        {hasKey ? (
          <Consent
            to="Google Gemini"
            what={`It includes ${plan.totals.included} message(s) word for word${plan.contextTokens ? ' and the summary' : ''}${summarizedForSegments ? `, plus ${summarizedForSegments} older message(s) for Gemini to summarize` : ''} (model ${model || '—'}). Each new message you send includes this again.`}
            actionLabel="Start Gemini chat"
            disabled={!plan.fits || !model || needsProfile}
            busy={migration.status === 'running'}
            onConfirm={() => void start()}
          />
        ) : (
          <p className="small warn">Add your Gemini API key above to start.</p>
        )}
        {migration.status === 'running' && (
          <p className="status" role="status">
            <Spinner /> {status}{' '}
            <button className="link" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </p>
        )}
        <ErrorBox error={migration.error} />
      </section>

      <section className="card">
        <h2>Prefer the Gemini website?</h2>
        <p className="muted small">
          gemini.google.com can’t import chat history, so ChatBridge copies everything as one
          message. Paste it into Gemini with Ctrl+V.
          {webPackage.length > WEB_PACKAGE_SOFT_LIMIT &&
            ' This one is very long and the website may reject it — choose “Summary only” above.'}
        </p>
        <button className="btn" disabled={!webPackage} onClick={() => void copyAndOpen()}>
          {copied === 'ok'
            ? 'Copied — paste it into Gemini'
            : copied === 'failed'
              ? 'Copy failed — try again'
              : 'Copy and open gemini.google.com'}
        </button>
        {!profile && <p className="muted small">Open the Review step once to prepare this.</p>}
      </section>
    </div>
  );
}

/** Inline API key setup, so starting a chat needs no detour through Settings. */
function KeySetup({ onSaved }: { onSaved: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [saving, runSave] = useAsync<true>();
  return (
    <section className="card" data-testid="key-setup">
      <h2>Connect Gemini</h2>
      <p className="small">
        Paste your Gemini API key. It’s free to create:{' '}
        <button
          className="link"
          onClick={() => void chrome.tabs.create({ url: 'https://aistudio.google.com/apikey' })}
        >
          get a key at Google AI Studio
        </button>
        .
      </p>
      <div className="row">
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder="Paste API key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Gemini API key"
          data-testid="inline-api-key"
        />
        <button
          className="btn btn-primary"
          disabled={!value.trim() || saving.status === 'running'}
          onClick={() =>
            void runSave(async () => {
              await setApiKey(value);
              setValue('');
              await onSaved();
              return true as const;
            })
          }
        >
          Save key
        </button>
      </div>
      <p className="muted small">
        Sent only to Google’s Gemini API. By default it’s forgotten when the browser closes; you can
        change that in Settings.
      </p>
      <ErrorBox error={saving.error} />
    </section>
  );
}
