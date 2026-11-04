import { useState } from 'react';

interface Props {
  report: unknown;
  name: string;
}

/** Shows a diagnostic report as plain text with copy and download actions. */
export function ReportView({ report, name }: Props) {
  const json = JSON.stringify(report, null, 2);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopyState('copied');
    } catch (err) {
      console.error('[ChatBridge] clipboard write failed', err);
      setCopyState('failed');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="report">
      <div className="actions">
        <button className="btn" onClick={() => void copy()}>
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy report'}
        </button>
        <button className="btn" onClick={download}>
          Download .json
        </button>
        <span className="muted small">{(json.length / 1024).toFixed(1)} KB</span>
      </div>
      <pre className="report-body" data-testid="report-body">
        {json}
      </pre>
    </div>
  );
}
