import type { Navigate, Route } from '../routes';

interface Props {
  route: Route;
  navigate: Navigate;
}

const TABS: { name: 'home' | 'settings' | 'diagnostics'; label: string }[] = [
  { name: 'home', label: 'Home' },
  { name: 'settings', label: 'Settings' },
  { name: 'diagnostics', label: 'Diagnostics' },
];

export function Header({ route, navigate }: Props) {
  return (
    <header className="header">
      <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 15c0-4 3-7 8-7s8 3 8 7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M2 15h20M7 15v4M17 15v4" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="brand">ChatBridge</span>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((tab) => (
          <button
            key={tab.name}
            className="tab"
            aria-current={route.name === tab.name ? 'page' : undefined}
            onClick={() => navigate({ name: tab.name })}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
