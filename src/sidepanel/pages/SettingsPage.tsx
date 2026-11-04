import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../providers/gemini/client';
import { deleteAllData } from '../../storage/db';
import {
  type Settings,
  clearApiKey,
  getApiKey,
  getSettings,
  maskKey,
  setApiKey,
  updateSettings,
} from '../../storage/settings';
import { ErrorBox, useAsync } from '../components/ui';
import { listModels } from '../services';

export function SettingsPage({ onSettingsChanged }: { onSettingsChanged: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [models, runModels] = useAsync<ModelInfo[]>();
  const [error, setError] = useState<unknown>(null);
  const [wipe, setWipe] = useState<'idle' | 'confirm' | 'done'>('idle');

  useEffect(() => {
    Promise.all([getSettings(), getApiKey()]).then(([s, k]) => {
      setSettings(s);
      setSavedKey(k);
      if (k) void runModels(() => listModels());
    }, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return error ? <ErrorBox error={error} /> : <p className="muted">Loading…</p>;

  const patch = async (p: Partial<Settings>) => {
    const previous = settings;
    // Update the controls immediately; roll back if saving fails.
    setSettings({ ...previous, ...p });
    try {
      const next = await updateSettings(p);
      setSettings(next);
      onSettingsChanged(next);
    } catch (err) {
      setSettings(previous);
      setError(err);
    }
  };

  const saveKey = async () => {
    try {
      await setApiKey(keyInput);
      setSavedKey(keyInput.trim());
      setKeyInput('');
      const list = await runModels(() => listModels(true));
      if (list && !settings.model && list[0]) await patch({ model: list[0].name });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Gemini API key</h2>
        <p className="muted small">
          Create a key at aistudio.google.com. ChatBridge sends it only to
          generativelanguage.googleapis.com and never logs it.
        </p>
        {savedKey && (
          <p className="small" data-testid="saved-key">
            Saved key: <span className="mono">{maskKey(savedKey)}</span>{' '}
            <button
              className="link"
              onClick={() => void clearApiKey().then(() => setSavedKey(null), setError)}
            >
              Remove
            </button>
          </p>
        )}
        <div className="row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder={savedKey ? 'Replace key' : 'Paste API key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            aria-label="Gemini API key"
            data-testid="api-key"
          />
          <button
            className="btn btn-primary"
            disabled={!keyInput.trim()}
            onClick={() => void saveKey()}
          >
            Save
          </button>
        </div>
        <fieldset className="modes">
          <legend className="small">Where to keep the key</legend>
          <label className="mode">
            <input
              type="radio"
              checked={settings.keyStorage === 'session'}
              onChange={() => void patch({ keyStorage: 'session' })}
            />
            <span className="small">
              <strong>Until the browser closes</strong> (memory only; recommended)
            </span>
          </label>
          <label className="mode">
            <input
              type="radio"
              checked={settings.keyStorage === 'local'}
              onChange={() => void patch({ keyStorage: 'local' })}
            />
            <span className="small">
              <strong>Remember on this device</strong> — stored unencrypted in your Chrome profile.
              Web pages cannot read it, but anyone or any software with access to your profile can.
            </span>
          </label>
        </fieldset>
        {models.status === 'running' && <p className="muted small">Checking key…</p>}
        <ErrorBox error={models.error} />
        {models.value && (
          <label className="field">
            <span>Default model ({models.value.length} available)</span>
            <select
              value={settings.model ?? ''}
              onChange={(e) => void patch({ model: e.target.value })}
              data-testid="settings-model"
            >
              <option value="" disabled>
                Choose a model
              </option>
              {models.value.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.displayName}
                  {m.inputTokenLimit ? ` · ${(m.inputTokenLimit / 1000).toFixed(0)}k input` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="card">
        <h2>Migration defaults</h2>
        <div className="grid2">
          <label className="field">
            <span>Context budget (tokens)</span>
            <input
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={settings.budgetTokens}
              onChange={(e) =>
                void patch({ budgetTokens: Math.max(1000, Number(e.target.value) || 1000) })
              }
            />
          </label>
          <label className="field">
            <span>Hybrid: recent messages</span>
            <input
              className="input"
              type="number"
              min={0}
              max={500}
              value={settings.recentTurns}
              onChange={(e) =>
                void patch({ recentTurns: Math.min(500, Math.max(0, Number(e.target.value) || 0)) })
              }
            />
          </label>
        </div>
      </section>

      <section className="card card-caution">
        <p className="eyebrow">Unofficial · unsupported · off by default</p>
        <h2>Internal ChatGPT endpoint</h2>
        <p className="muted small">
          Lets ChatBridge request the open conversation from chatgpt.com the way the ChatGPT web app
          does, using your signed-in session. It returns every branch and is current, but OpenAI
          does not support it and it may stop working. ChatBridge never depends on it; page
          extraction and the export file always remain available. Each use asks for confirmation.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.endpointEnabled}
            onChange={(e) => void patch({ endpointEnabled: e.target.checked })}
            data-testid="endpoint-toggle"
          />
          <span>Enable the unofficial endpoint option</span>
        </label>
      </section>

      <section className="card">
        <h2>Your data</h2>
        <p className="muted small">
          Transcripts, analyses, migration plans and chats are stored only in this browser
          (IndexedDB). Delete individual transcripts from their page, or everything here.
        </p>
        {wipe === 'confirm' ? (
          <div className="row">
            <span className="small">
              Delete all ChatBridge data on this device? This cannot be undone.
            </span>
            <button
              className="btn btn-danger"
              onClick={() => void deleteAllData().then(() => setWipe('done'), setError)}
            >
              Delete everything
            </button>
            <button className="btn" onClick={() => setWipe('idle')}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setWipe('confirm')} disabled={wipe === 'done'}>
            {wipe === 'done' ? 'All data deleted' : 'Delete all ChatBridge data…'}
          </button>
        )}
        <ErrorBox error={error} />
      </section>
    </div>
  );
}
