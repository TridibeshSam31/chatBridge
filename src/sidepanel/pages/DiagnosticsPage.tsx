import { useState } from 'react';
import { analyzeExport } from '../../core/import/chatgpt-export/structure';
import { DiagnosticResponseSchema, PROTOCOL_VERSION } from '../../shared/protocol';
import type { PanelState } from '../App';
import { ReportView } from '../components/ReportView';
import { BridgeError, requestTab } from '../tab-bridge';

interface Props {
  state: PanelState;
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; report: unknown }
  | { kind: 'error'; message: string };

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

export function DiagnosticsPage({ state }: Props) {
  const tabId =
    state.kind === 'detected' && state.conversation.conversationId !== null ? state.tabId : null;

  const [scrollTest, setScrollTest] = useState(false);
  const [dom, setDom] = useState<RunState>({ kind: 'idle' });
  const [endpointConsent, setEndpointConsent] = useState(false);
  const [endpoint, setEndpoint] = useState<RunState>({ kind: 'idle' });
  const [exportRun, setExportRun] = useState<RunState>({ kind: 'idle' });

  async function run(set: (s: RunState) => void, work: () => Promise<unknown>) {
    set({ kind: 'running' });
    try {
      set({ kind: 'done', report: await work() });
    } catch (err) {
      console.error('[ChatBridge] diagnostic failed', err);
      set({
        kind: 'error',
        message: err instanceof BridgeError || err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runDom = (id: number) =>
    run(setDom, () =>
      requestTab(
        id,
        { type: 'chatbridge/diagnose-dom', protocol: PROTOCOL_VERSION, scrollTest },
        DiagnosticResponseSchema,
      ),
    );

  const runEndpoint = (id: number) =>
    run(setEndpoint, () =>
      requestTab(
        id,
        { type: 'chatbridge/diagnose-endpoint', protocol: PROTOCOL_VERSION, consent: true },
        DiagnosticResponseSchema,
      ),
    );

  const runExport = (file: File) =>
    run(setExportRun, async () => {
      if (file.size > MAX_EXPORT_BYTES) {
        throw new Error(
          'File is larger than 1 GB. Unzip the export and choose conversations.json.',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch (err) {
        throw new Error(
          `Not valid JSON (${err instanceof Error ? err.name : 'parse error'}). Choose conversations.json from the unzipped export.`,
          { cause: err },
        );
      }
      return analyzeExport(parsed, file.size);
    });

  return (
    <div className="stack">
      <p className="muted small">
        These checks describe the <em>structure</em> of ChatGPT’s page and data so the extractor can
        be validated. Reports contain tags, attribute names, counts and text lengths — no message
        text, titles, file names or credentials. Review a report before sharing it.
      </p>

      <section className="card" data-testid="diag-dom">
        <h2>1 · Page structure</h2>
        <p className="muted small">
          Reads the open conversation’s DOM. Nothing leaves your browser.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={scrollTest}
            onChange={(e) => setScrollTest(e.target.checked)}
          />
          <span>
            Also scroll the conversation top to bottom to test lazy loading (takes up to a minute;
            your scroll position is restored).
          </span>
        </label>
        <div className="actions">
          <button
            className="btn btn-primary"
            disabled={tabId === null || dom.kind === 'running'}
            onClick={() => tabId !== null && void runDom(tabId)}
          >
            {dom.kind === 'running' ? 'Checking…' : 'Run page check'}
          </button>
        </div>
        {tabId === null && <p className="muted small">Open a ChatGPT conversation tab first.</p>}
        <RunResult state={dom} name="chatbridge-dom-probe" />
      </section>

      <section className="card card-caution" data-testid="diag-endpoint">
        <p className="eyebrow">Unofficial · unsupported · off by default</p>
        <h2>2 · Internal conversation endpoint</h2>
        <p className="muted small">
          Asks chatgpt.com for this conversation the same way the ChatGPT web app does, using the
          session you are already signed in with. OpenAI does not document or support this; it may
          stop working at any time. ChatBridge never needs it to work. The access token stays in the
          page and is not included in the report.
        </p>
        <label className="check">
          <input
            type="checkbox"
            data-testid="endpoint-consent"
            checked={endpointConsent}
            onChange={(e) => setEndpointConsent(e.target.checked)}
          />
          <span>
            I understand this uses an unofficial ChatGPT endpoint, and I allow this one check.
          </span>
        </label>
        <div className="actions">
          <button
            className="btn"
            disabled={tabId === null || !endpointConsent || endpoint.kind === 'running'}
            onClick={() => tabId !== null && void runEndpoint(tabId)}
          >
            {endpoint.kind === 'running' ? 'Checking…' : 'Run endpoint check'}
          </button>
        </div>
        <RunResult state={endpoint} name="chatbridge-endpoint-probe" />
      </section>

      <section className="card" data-testid="diag-export">
        <h2>3 · Export file structure</h2>
        <p className="muted small">
          Choose <code>conversations.json</code> from your unzipped ChatGPT data export. It is read
          locally in this panel and never uploaded.
        </p>
        <input
          type="file"
          accept=".json,application/json"
          data-testid="export-file"
          disabled={exportRun.kind === 'running'}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void runExport(file);
          }}
        />
        <RunResult state={exportRun} name="chatbridge-export-probe" />
      </section>
    </div>
  );
}

function RunResult({ state, name }: { state: RunState; name: string }) {
  if (state.kind === 'error') {
    return (
      <p className="error small" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.kind === 'done') return <ReportView report={state.report} name={name} />;
  return null;
}
