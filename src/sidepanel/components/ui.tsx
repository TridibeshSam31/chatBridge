import { type ReactNode, useState } from 'react';
import type { ContentBlock, NormalizedMessage } from '../../core/conversation/schema';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const METHOD_LABEL: Record<string, string> = {
  dom: 'Page (DOM)',
  export: 'Export file',
  'internal-api': 'Internal endpoint · unofficial',
};

export function MethodBadge({ method }: { method: string }) {
  return (
    <Badge tone={method === 'internal-api' ? 'warn' : 'info'}>
      {METHOD_LABEL[method] ?? method}
    </Badge>
  );
}

export function CompletenessBadge({ value }: { value: string }) {
  return (
    <Badge tone={value === 'complete' ? 'good' : value === 'partial' ? 'bad' : 'warn'}>
      completeness: {value}
    </Badge>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="card card-error" role="alert">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Inline consent gate. Nothing that sends data to an external service runs until
 * the user has read what will be sent and ticked the box.
 */
export function Consent({
  what,
  to,
  actionLabel,
  disabled,
  busy,
  agreeLabel,
  onConfirm,
}: {
  what: ReactNode;
  to: string;
  actionLabel: string;
  disabled?: boolean;
  busy?: boolean;
  agreeLabel?: string;
  onConfirm: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="consent" data-testid="consent">
      <p className="small">
        <strong>{agreeLabel ? to : `This sends data to ${to}.`}</strong> {what}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          data-testid="consent-check"
        />
        <span>{agreeLabel ?? `I agree to send this to ${to}.`}</span>
      </label>
      <button
        className="btn btn-primary"
        disabled={!agreed || disabled || busy}
        onClick={onConfirm}
      >
        {busy ? 'Working…' : actionLabel}
      </button>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  system: 'System',
  model: 'Gemini',
};

export function MessageView({
  message,
  aside,
}: {
  /** `model` is a destination reply (e.g. Gemini), distinct from the imported assistant. */
  message: Pick<NormalizedMessage, 'id' | 'content'> & {
    role: NormalizedMessage['role'] | 'model';
    visibility?: string;
  };
  aside?: ReactNode;
}) {
  return (
    <article className={`msg msg-${message.role}`} id={`msg-${message.id}`}>
      <header className="msg-head">
        <span className="msg-role">{ROLE_LABEL[message.role] ?? message.role}</span>
        {message.visibility === 'hidden' && <Badge>hidden in source</Badge>}
        <span className="msg-aside">{aside}</span>
      </header>
      {message.content.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </article>
  );
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <div className="msg-text">{block.text}</div>;
    case 'code':
      return (
        <pre className="msg-code" data-language={block.language ?? ''}>
          {block.language && <span className="code-lang">{block.language}</span>}
          <code>{block.text}</code>
        </pre>
      );
    case 'image':
      return (
        <p className="placeholder">Image{block.alt ? `: ${block.alt}` : ''} — not transferable</p>
      );
    case 'file':
      return <p className="placeholder">File: {block.name} — not transferable</p>;
    case 'unsupported':
      return (
        <p className="placeholder">
          Unsupported content ({block.originalType}): {block.description}
        </p>
      );
  }
}

export function useAsync<T>() {
  const [state, setState] = useState<{
    status: 'idle' | 'running' | 'done' | 'error';
    value?: T;
    error?: unknown;
  }>({ status: 'idle' });
  const run = async (fn: () => Promise<T>) => {
    setState({ status: 'running' });
    try {
      const value = await fn();
      setState({ status: 'done', value });
      return value;
    } catch (error) {
      console.error('[ChatBridge]', error);
      setState({ status: 'error', error });
      return undefined;
    }
  };
  return [state, run] as const;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('[ChatBridge] clipboard write failed', err);
    return false;
  }
}
