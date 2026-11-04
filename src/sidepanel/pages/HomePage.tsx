import { useState } from 'react';
import type { PanelState } from '../App';
import { Consent, ErrorBox, useAsync } from '../components/ui';
import type { Navigate } from '../routes';
import { extractFromTab } from '../services';

interface Props {
  state: PanelState;
  onRefresh: () => void;
  navigate: Navigate;
  endpointEnabled: boolean;
}

export function HomePage({ state, onRefresh, navigate, endpointEnabled }: Props) {
  return (
    <div className="stack">
      <SourceCard
        state={state}
        onRefresh={onRefresh}
        navigate={navigate}
        endpointEnabled={endpointEnabled}
      />
      <section className="card">
        <h2>Import from a ChatGPT data export</h2>
        <p className="muted small">
          The most complete method: includes every branch, custom instructions and timestamps.
          Request it in ChatGPT → Settings → Data controls → Export data. Read locally, never
          uploaded.
        </p>
        <button className="btn" onClick={() => navigate({ name: 'import' })}>
          Choose export file…
        </button>
      </section>
    </div>
  );
}

function SourceCard({ state, onRefresh, navigate, endpointEnabled }: Props) {
  const [scroll, setScroll] = useState(true);
  const [extraction, run] = useAsync<string>();
  const busy = extraction.status === 'running';

  const extract = async (tabId: number, method: 'dom' | 'dom-scroll' | 'endpoint') => {
    const id = await run(async () => (await extractFromTab(tabId, method)).transcriptId);
    if (id) navigate({ name: 'transcript', id });
  };

  switch (state.kind) {
    case 'loading':
      return (
        <p className="muted" role="status">
          Checking the current tab…
        </p>
      );
    case 'no-tab':
    case 'not-chatgpt':
      return (
        <section className="card" data-testid="state-not-chatgpt">
          <h2>Open a ChatGPT conversation</h2>
          <p className="muted">
            Switch to a tab on chatgpt.com with the conversation you want to move. This panel
            updates automatically.
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
          <section className="card" data-testid="state-no-conversation">
            <h2>No conversation selected</h2>
            <p className="muted">
              Open an existing chat from the ChatGPT sidebar. New and temporary chats can’t be
              migrated until they have a conversation link.
            </p>
          </section>
        );
      }
      return (
        <section className="card" data-testid="state-detected">
          <p className="eyebrow">Source · ChatGPT</p>
          <h2 className="title" data-testid="conversation-title">
            {c.title ?? 'Untitled conversation'}
          </h2>
          <dl className="stats">
            <div>
              <dt>Rendered messages</dt>
              <dd data-testid="message-count">{c.renderedMessageCount}</dd>
            </div>
            <div>
              <dt>You</dt>
              <dd>{c.renderedRoleCounts.user}</dd>
            </div>
            <div>
              <dt>ChatGPT</dt>
              <dd>{c.renderedRoleCounts.assistant}</dd>
            </div>
          </dl>
          {c.selectorStrategy === null ? (
            <p className="warn" data-testid="selector-warning">
              No messages found on the page. The chat may still be loading, or ChatGPT’s layout has
              changed — use the export file instead.
            </p>
          ) : (
            <p className="muted small">
              Counts what the page has rendered so far. Page extraction reports exactly what it
              captured; it cannot see other branches of edited messages.
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={scroll} onChange={(e) => setScroll(e.target.checked)} />
            <span>Scroll through the whole conversation first (recommended for long chats)</span>
          </label>
          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy || c.selectorStrategy === null}
              onClick={() => void extract(state.tabId, scroll ? 'dom-scroll' : 'dom')}
            >
              {busy ? 'Extracting…' : 'Analyze conversation'}
            </button>
            <button className="btn" onClick={onRefresh} disabled={busy}>
              Refresh
            </button>
          </div>
          {extraction.status === 'error' && (
            <>
              <ErrorBox error={extraction.error} />
              <p className="small">
                Fallback:{' '}
                <button className="link" onClick={() => navigate({ name: 'import' })}>
                  import the export file
                </button>{' '}
                instead.
              </p>
            </>
          )}
          {endpointEnabled && (
            <details className="advanced">
              <summary>Advanced · unofficial endpoint</summary>
              <Consent
                to="ChatGPT’s unofficial conversation endpoint"
                what="ChatBridge will request this conversation from chatgpt.com using your signed-in session, as the ChatGPT web app does. It is unsupported and may stop working. Nothing is sent anywhere else."
                agreeLabel="I understand and allow this request."
                actionLabel="Extract via internal endpoint"
                busy={busy}
                onConfirm={() => void extract(state.tabId, 'endpoint')}
              />
            </details>
          )}
          <p className="muted small mono">{c.conversationId}</p>
        </section>
      );
    }
  }
}
