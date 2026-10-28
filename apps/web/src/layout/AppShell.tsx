import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Scale,
  Settings,
  ShieldCheck,
  Code2,
  Sun,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { useSession } from '../app/session';
import { useTheme, type ThemePreference } from '../app/theme';
import { useQuery } from '../hooks/useQuery';
import { Button, Select, cx } from '../ui/primitives';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/tasks', label: 'Engineering tasks', icon: Code2 },
  { to: '/approvals', label: 'Patch approvals', icon: ShieldCheck },
  { to: '/runs', label: 'Verifications', icon: ListChecks, end: true },
  { to: '/repositories', label: 'Repositories', icon: FolderGit2 },
  { to: '/policies', label: 'Policies', icon: Scale },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const THEME_NEXT: Record<ThemePreference, ThemePreference> = { light: 'dark', dark: 'system', system: 'light' };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
        <ShieldCheck className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-fg">ASEA</div>
        <div className="text-2xs text-subtle">Safe-to-merge verification</div>
      </div>
    </div>
  );
}

function ApiStatus() {
  // The readiness probe, refreshed every 30 s
  const ready = useQuery('ready', () => api.ready(), { pollMs: () => 30_000 });
  const up = ready.data?.status === 'ready';
  const label = ready.loading ? 'Checking API…' : ready.error ? 'API unreachable' : up ? 'API online' : 'API degraded';
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-muted" data-testid="api-status">
      <span className={cx('h-2 w-2 rounded-full', ready.loading ? 'bg-subtle' : ready.error ? 'bg-danger' : up ? 'bg-ok' : 'bg-warn')} />
      {label}
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, workspaces, workspace, selectWorkspace, signOut } = useSession();
  const { preference, setPreference } = useTheme();
  const ThemeIcon = THEME_ICON[preference];

  return (
    <div className="flex h-full flex-col gap-5 p-3">
      <Logo />
      {workspaces.length > 1 ? (
        <Select aria-label="Workspace" value={workspace?.id} onChange={(e) => selectWorkspace(e.target.value)} className="h-8 text-xs">
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      ) : (
        <div className="truncate rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-muted" title={workspace?.name}>
          {workspace?.name}
        </div>
      )}

      <NavLink
        to="/runs/new"
        onClick={onNavigate}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg shadow-sm hover:bg-accent/90"
      >
        <Plus className="h-4 w-4" /> New verification
      </NavLink>
      <NavLink
        to="/tasks/new"
        onClick={onNavigate}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2"
      >
        <Plus className="h-4 w-4" /> New engineering task
      </NavLink>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg'
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-3">
        <ApiStatus />
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {user?.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-medium text-fg">{user?.displayName}</div>
            <div className="truncate text-2xs text-subtle">{user?.email}</div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Theme: ${preference}. Switch to ${THEME_NEXT[preference]}`}
            title={`Theme: ${preference}`}
            icon={<ThemeIcon className="h-3.5 w-3.5" />}
            onClick={() => setPreference(THEME_NEXT[preference])}
          />
          <Button size="sm" variant="ghost" aria-label="Sign out" title="Sign out" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => void signOut()} />
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-full lg:pl-60">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-bg lg:block">
        <SidebarContent />
      </aside>

      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-border bg-bg/90 px-3 backdrop-blur lg:hidden">
        <Logo />
        <Button variant="ghost" size="sm" aria-label="Open navigation" icon={<Menu className="h-5 w-5" />} onClick={() => setOpen(true)} />
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <aside className="relative h-full w-72 max-w-[85vw] border-r border-border bg-bg shadow-xl">
            <Button className="absolute right-2 top-2" variant="ghost" size="sm" aria-label="Close navigation" icon={<X className="h-4 w-4" />} onClick={() => setOpen(false)} />
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
