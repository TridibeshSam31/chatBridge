export type Route =
  | { name: 'home' }
  | { name: 'import' }
  | { name: 'transcript'; id: string }
  | { name: 'migrate'; transcriptId: string }
  | { name: 'chat'; sessionId: string }
  | { name: 'settings' }
  | { name: 'diagnostics' };

export type Navigate = (route: Route) => void;
