import { useMemo, useState } from 'react';
import type { ExportEntry } from '../../core/import/chatgpt-export/parse';
import { ErrorBox, useAsync } from '../components/ui';
import type { Navigate } from '../routes';
import { importConversation, openExport } from '../services';

export function ImportPage({ navigate }: { navigate: Navigate }) {
  const [file, runOpen] = useAsync<{ conversations: unknown[]; entries: ExportEntry[] }>();
  const [importing, runImport] = useAsync<string>();
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const all = file.value?.entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((e) => (e.title ?? '').toLowerCase().includes(q)) : all;
    return [...filtered].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [file.value, query]);

  const choose = async (entry: ExportEntry) => {
    const raw = file.value?.conversations[entry.index];
    const id = await runImport(async () => (await importConversation(raw)).id);
    if (id) navigate({ name: 'transcript', id });
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Import from your ChatGPT export</h2>
        <p className="muted small">
          Get it in ChatGPT → Settings → Data controls → Export data (it arrives by email). Choose
          the <code>.zip</code>, or the <code>conversations.json</code> inside it. It is read on
          this device only.
        </p>
        <input
          type="file"
          accept=".zip,.json,application/zip,application/json"
          data-testid="import-file"
          disabled={file.status === 'running'}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void runOpen(() => openExport(f));
          }}
        />
        {file.status === 'running' && <p className="muted small">Reading file…</p>}
        <ErrorBox error={file.error} />
      </section>

      {file.value && (
        <section className="card">
          <h2>Pick a chat ({file.value.entries.length})</h2>
          <input
            className="input"
            placeholder="Search by title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
          />
          <ErrorBox error={importing.error} />
          <ul className="list" data-testid="export-list">
            {entries.slice(0, 300).map((e) => (
              <li key={e.index}>
                <button
                  className="list-item"
                  disabled={importing.status === 'running'}
                  onClick={() => void choose(e)}
                >
                  <span className="list-title">{e.title ?? 'Untitled conversation'}</span>
                  <span className="muted small">
                    {e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : 'no date'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {entries.length > 300 && (
            <p className="muted small">Showing 300 of {entries.length}. Search to narrow down.</p>
          )}
        </section>
      )}
    </div>
  );
}
