import { useCallback, useEffect, useRef, useState } from 'react';
import { type Settings, getSettings } from '../storage/settings';
import { Header } from './components/Header';
import { ChatPage } from './pages/ChatPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { HomePage } from './pages/HomePage';
import { ImportPage } from './pages/ImportPage';
import { Library } from './pages/LibraryPage';
import { MigratePage } from './pages/MigratePage';
import { SettingsPage } from './pages/SettingsPage';
import { TranscriptPage } from './pages/TranscriptPage';
import type { Route } from './routes';
import { type ActiveTabState, BridgeError, inspectActiveTab } from './tab-bridge';

export type PanelState = { kind: 'loading' } | ActiveTabState | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const navigate = useCallback((next: Route) => {
    setRoute(next);
    window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    getSettings().then(setSettings, (err: unknown) =>
      console.error('[ChatBridge] loading settings failed', err),
    );
  }, []);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    // Tab events can fire in bursts; only the latest request may update the UI.
    const seq = ++requestSeq.current;
    try {
      const next = await inspectActiveTab();
      if (seq === requestSeq.current) setState(next);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error('[ChatBridge] tab inspection failed', err);
      setState({
        kind: 'error',
        message:
          err instanceof BridgeError
            ? err.message
            : 'Something went wrong while reading this tab. Try Refresh.',
      });
    }
  }, []);

  useEffect(() => {
    // refresh() only sets state after awaiting Chrome APIs, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    const onActivated = () => void refresh();
    // ChatGPT is a single-page app: navigating between chats changes the URL and
    // title without a page load, and Chrome reports both through onUpdated.
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.url !== undefined || info.title !== undefined || info.status === 'complete') {
        void refresh();
      }
    };
    const onFocusChanged = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) void refresh();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    };
  }, [refresh]);

  return (
    <div className="app">
      <Header route={route} navigate={navigate} />
      <main className="main">
        {route.name !== 'home' && route.name !== 'settings' && route.name !== 'diagnostics' && (
          <button className="link back" onClick={() => navigate({ name: 'home' })}>
            ← Back to start
          </button>
        )}
        {route.name === 'home' && (
          <div className="stack">
            <HomePage
              state={state}
              onRefresh={() => void refresh()}
              navigate={navigate}
              endpointEnabled={settings?.endpointEnabled ?? false}
              onSettingsChanged={setSettings}
            />
            <Library navigate={navigate} />
          </div>
        )}
        {route.name === 'import' && <ImportPage navigate={navigate} />}
        {route.name === 'transcript' && (
          <TranscriptPage key={route.id} id={route.id} navigate={navigate} />
        )}
        {route.name === 'migrate' && (
          <MigratePage
            key={route.transcriptId}
            transcriptId={route.transcriptId}
            navigate={navigate}
          />
        )}
        {route.name === 'chat' && (
          <ChatPage key={route.sessionId} sessionId={route.sessionId} navigate={navigate} />
        )}
        {route.name === 'settings' && <SettingsPage onSettingsChanged={setSettings} />}
        {route.name === 'diagnostics' && <DiagnosticsPage state={state} />}
      </main>
    </div>
  );
}
