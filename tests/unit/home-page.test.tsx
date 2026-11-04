import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../../src/sidepanel/pages/HomePage';
import type { PanelState } from '../../src/sidepanel/App';
import type { DetectedConversation } from '../../src/shared/protocol';

afterEach(cleanup);

const base: DetectedConversation = {
  provider: 'chatgpt',
  url: 'https://chatgpt.com/c/6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b',
  conversationId: '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b',
  title: 'Debugging the auth middleware',
  renderedMessageCount: 4,
  renderedRoleCounts: { user: 2, assistant: 2, other: 0 },
  selectorStrategy: 'data-message-author-role',
};

const detected = (c: Partial<DetectedConversation> = {}): PanelState => ({
  kind: 'detected',
  tabId: 1,
  conversation: { ...base, ...c },
});

const page = (
  state: PanelState,
  extra: { endpointEnabled?: boolean; onRefresh?: () => void } = {},
) =>
  render(
    <HomePage
      state={state}
      onRefresh={extra.onRefresh ?? vi.fn()}
      navigate={vi.fn()}
      endpointEnabled={extra.endpointEnabled ?? false}
    />,
  );

describe('HomePage', () => {
  it('shows the detected conversation with extraction enabled', () => {
    page(detected());
    expect(screen.getByTestId('conversation-title').textContent).toBe(
      'Debugging the auth middleware',
    );
    expect(screen.getByTestId('message-count').textContent).toBe('4');
    expect(screen.getByRole('button', { name: 'Analyze conversation' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('disables extraction and points to the export when no messages are found', () => {
    page(detected({ selectorStrategy: null, renderedMessageCount: 0 }));
    expect(screen.getByTestId('selector-warning').textContent).toMatch(/export file/);
    expect(screen.getByRole('button', { name: 'Analyze conversation' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('hides the unofficial endpoint unless enabled in settings', () => {
    page(detected());
    expect(screen.queryByText(/unofficial endpoint/i)).toBeNull();
    cleanup();
    page(detected(), { endpointEnabled: true });
    expect(screen.getByText(/Advanced · unofficial endpoint/)).toBeTruthy();
  });

  it('always offers the export import', () => {
    page({ kind: 'not-chatgpt' });
    expect(screen.getByTestId('state-not-chatgpt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose export file…' })).toBeTruthy();
  });

  it('asks for a conversation on the ChatGPT home page', () => {
    page(detected({ conversationId: null }));
    expect(screen.getByTestId('state-no-conversation')).toBeTruthy();
  });

  it('shows errors with a retry action', () => {
    const onRefresh = vi.fn();
    page({ kind: 'error', message: 'Reload the tab' }, { onRefresh });
    screen.getByRole('button', { name: 'Refresh' }).click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('Reload the tab');
  });
});
