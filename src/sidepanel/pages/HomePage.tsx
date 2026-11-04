import { useState } from 'react';
import { type Settings, updateSettings } from '../../storage/settings';
import type { PanelState } from '../App';
import { Callout, Consent, ErrorBox, Spinner, Stepper, useAsync } from '../components/ui';
import type { Navigate } from '../routes';
import { extractFromTab } from '../services';

interface Props {
  state: PanelState;
  onRefresh: () => void;
  navigate: Navigate;
  endpointEnabled: boolean;
  onSettingsChanged?: (s: Settings) => void;
}

export function HomePage(props: Props) {
  const onChatGpt = props.state.kind === 'detected' && props.state.conversation.conversationId;
  return (
    <div className="stack">
      <SourceCard {...props} />
      {!onChatGpt && (
        <section className="card">
          <h2>Have a ChatGPT export?</h2>
          <p className="muted small">
            Pick any chat from your ChatGPT data export (ChatGPT → Settings → Data controls → Export
            data). It is read on this device only.
          </p>
          <button className="btn" onClick={() => props.navigate({ name: 'import' })}>
            Choose export file…
          </button>
        </section>
      )}
    </div>
  );
}

type Phase = 'endpoint' | 'page';

function SourceCard({ state, onRefresh, navigate, endpointEnabled, onSettingsChanged }: Props) {
  const [extraction, run] = useAsync<string>();
  const [phase, setPhase] = useState<Phase>('page');
  const [enabling, setEnabling] = useState(false);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const busy = extraction.status === 'running';

  /**
   * One button: the one-click method when it is turned on, with an automatic
   * fall back to reading the page if it fails (it is unofficial and may break).
   */
  const getChat = async (tabId: number, method: 'auto' | 'page') => {
    const id = await run(async () => {
      if (method === 'auto' && endpointEnabled) {
        setPhase('endpoint');
        try {
          return (await extractFromTab(tabId, 'endpoint')).transcriptId;
        } catch (err) {
          console.warn('[ChatBridge] one-click method failed; reading the page instead', err);
        }
      }
      setPhase('page');
      return (await extractFromTab(tabId, 'dom-scroll')).transcriptId;
    });
    if (id) navigate({ name: 'transcript', id });
  };

  const enableOneClick = async () => {
    try {
      const next = await updateSettings({ endpointEnabled: true });
      onSettingsChanged?.(next);
      setEnabling(false);
    } catch (err) {
      setSettingsError(err);
    }
  };

  switch (state.kind) {
    case 'loading':
      return (
        <p className="muted status" role="status">
          <Spinner /> Looking at the current tab…
        </p>
      );
    case 'no-tab':
    case 'not-chatgpt':
      return (
        <section className="card hero" data-testid="state-not-chatgpt">
          <Stepper current={1} />
          <h2>Open the ChatGPT chat you want to move</h2>
          <p className="muted">
            Go to chatgpt.com and open a chat. This panel picks it up automatically.
          </p>
        </section>
      );
    case 'error':
      return (
        <section className="card card-error" role="alert" data-testid="state-error">
          <h2>Can’t read this tab</h2>
          <p>{state.message}</p>
          <button className="btn" onClick={onRefresh}>
            Refresh
          </button>
        </section>
      );
    case 'detected': {
      const c = state.conversation;
      if (c.conversationId === null) {
        return (
          <section className="card hero" data-testid="state-no-conversation">
            <Stepper current={1} />
            <h2>Open a saved chat</h2>
            <p className="muted">
              Pick a chat from the ChatGPT sidebar. New and temporary chats can’t be moved until
              they are saved.
            </p>
          </section>
        );
      }
      const pageUnreadable = c.selectorStrategy === null;
      return (
        <section className="card hero" data-testid="state-detected">
          <Stepper current={1} />
          <p className="section-title">This ChatGPT chat</p>
          <h2 className="title" data-testid="conversation-title">
            {c.title ?? 'Untitled chat'}
          </h2>

          <button
            className="btn btn-primary btn-lg"
            disabled={busy}
            onClick={() => void getChat(state.tabId, 'auto')}
          >
            {busy ? <Spinner /> : null}
            {busy ? 'Getting the chat…' : 'Get this chat'}
          </button>
          {busy ? (
            <p className="hint" role="status">
              {phase === 'endpoint'
                ? 'Getting the whole chat from ChatGPT…'
                : 'Scrolling through the chat to read every message. Long chats can take a minute — keep this tab open.'}
            </p>
          ) : (
            <p className="hint">
              {endpointEnabled
                ? 'Gets the whole chat in one step. Nothing leaves your computer.'
                : 'ChatBridge scrolls through the chat to read it. Nothing leaves your computer.'}
            </p>
          )}

          {extraction.status === 'error' && (
            <>
              <ErrorBox error={extraction.error} />
              <p className="small">
                You can also{' '}
                <button className="link" onClick={() => navigate({ name: 'import' })}>
                  import the chat from your ChatGPT export
                </button>
                .
              </p>
            </>
          )}

          {pageUnreadable && !endpointEnabled && (
            <Callout
              tone="warn"
              title="ChatBridge can’t see the messages on this page"
              testId="selector-warning"
            >
              <p>
                The chat may still be loading. If this stays, turn on one-click below, or use your
                export file.
              </p>
            </Callout>
          )}

          {!endpointEnabled && (
            <Callout tone="info" title="Tip: get the whole chat in one click">
              <p className="small">No scrolling, and nothing gets missed — even very long chats.</p>
              {enabling ? (
                <Consent
                  to="How it works"
                  what="ChatBridge asks chatgpt.com for this chat the same way the ChatGPT website loads it, using your logged-in session. OpenAI doesn’t officially support this, so it may stop working one day — ChatBridge then reads the page instead. Nothing is sent anywhere else. You can turn it off in Settings."
                  agreeLabel="I understand. Use this unofficial method."
                  actionLabel="Turn on one-click"
                  onConfirm={() => void enableOneClick()}
                />
              ) : (
                <button className="btn" onClick={() => setEnabling(true)}>
                  Turn on one-click…
                </button>
              )}
              <ErrorBox error={settingsError} />
            </Callout>
          )}

          <details className="more">
            <summary>Other ways to get this chat</summary>
            <div className="actions">
              {endpointEnabled && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void getChat(state.tabId, 'page')}
                >
                  Read it from the page
                </button>
              )}
              <button className="btn" onClick={() => navigate({ name: 'import' })}>
                Import from export file
              </button>
              <button className="btn" onClick={onRefresh} disabled={busy}>
                Refresh
              </button>
            </div>
          </details>
        </section>
      );
    }
  }
}
