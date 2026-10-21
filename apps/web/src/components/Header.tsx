import React from 'react';
import {
  Menu,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Database,
  User,
  LogOut,
  Building2,
  LogIn,
} from 'lucide-react';
import type { ReadinessResponse, UserProfile, WorkspaceResponse } from '@autonomous-engineer/contracts';

interface HeaderProps {
  onToggleMobile: () => void;
  apiStatus: 'checking' | 'connected' | 'disconnected' | 'degraded';
  readinessData: ReadinessResponse | null;
  onRefresh: () => void;
  latency: number | null;
  currentUser: UserProfile | null;
  workspaces: WorkspaceResponse[];
  activeWorkspace: WorkspaceResponse | null;
  onSelectWorkspace: (ws: WorkspaceResponse) => void;
  onOpenAuth: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleMobile,
  apiStatus,
  readinessData,
  onRefresh,
  latency,
  currentUser,
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  onOpenAuth,
  onLogout,
}) => {
  const getStatusBadge = () => {
    switch (apiStatus) {
      case 'connected':
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-medium">API Online</span>
            {latency !== null && (
              <span className="text-[11px] font-mono text-emerald-500/80">({latency}ms)</span>
            )}
          </div>
        );
      case 'degraded':
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-amber-950/60 border border-amber-500/30 text-amber-400 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-medium">Dependencies Pending</span>
          </div>
        );
      case 'disconnected':
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-rose-950/60 border border-rose-500/30 text-rose-400 text-xs">
            <XCircle className="w-3.5 h-3.5 text-rose-400" />
            <span className="font-medium">API Offline</span>
          </div>
        );
      case 'checking':
      default:
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-surface-elevated border border-surface-border text-slate-400 text-xs">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Checking Services...</span>
          </div>
        );
    }
  };

  const pgStatus = readinessData?.dependencies?.['postgres']?.status || 'unprobed';
  const redisStatus = readinessData?.dependencies?.['redis']?.status || 'unprobed';

  return (
    <header className="h-16 border-b border-surface-border bg-surface/80 backdrop-blur sticky top-0 z-30 px-6 flex items-center justify-between">
      <div className="flex items-center space-x-4">
        <button
          onClick={onToggleMobile}
          className="lg:hidden text-slate-400 hover:text-slate-200 p-1.5 rounded-md hover:bg-surface-elevated"
          aria-label="Toggle navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div>
          <h1 className="text-base font-semibold text-slate-100 tracking-tight flex items-center space-x-2">
            <span>Engineering Control Plane</span>
            <span className="text-[10px] font-mono uppercase bg-primary-600/20 text-primary-400 px-2 py-0.5 rounded border border-primary-500/30">
              Phase 2
            </span>
          </h1>
          <p className="text-xs text-slate-400 hidden sm:block">
            PostgreSQL Persistence • BullMQ Queue • Role-Based Workspaces
          </p>
        </div>
      </div>

      <div className="flex items-center space-x-3">
        {/* Workspace Selector (If Authenticated) */}
        {currentUser && workspaces.length > 0 && (
          <div className="hidden sm:flex items-center space-x-2 bg-surface-elevated border border-surface-border rounded-lg px-2.5 py-1 text-xs">
            <Building2 className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={activeWorkspace?.id || ''}
              onChange={(e) => {
                const target = workspaces.find((w) => w.id === e.target.value);
                if (target) onSelectWorkspace(target);
              }}
              className="bg-transparent text-slate-200 font-medium focus:outline-none cursor-pointer"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id} className="bg-surface text-slate-100">
                  {ws.name} ({ws.role || 'MEMBER'})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Postgres & Redis Status pill */}
        <div className="hidden md:flex items-center space-x-2 px-3 py-1 bg-surface-elevated/80 border border-surface-border rounded-lg text-xs font-mono text-slate-300">
          <Database className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-slate-400">PG:</span>
          <span
            className={
              pgStatus === 'up'
                ? 'text-emerald-400'
                : pgStatus === 'down'
                ? 'text-rose-400'
                : 'text-slate-500'
            }
          >
            {pgStatus}
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Redis:</span>
          <span
            className={
              redisStatus === 'up'
                ? 'text-emerald-400'
                : redisStatus === 'down'
                ? 'text-rose-400'
                : 'text-slate-500'
            }
          >
            {redisStatus}
          </span>
        </div>

        {/* API Status Badge */}
        {getStatusBadge()}

        {/* Refresh button */}
        <button
          onClick={onRefresh}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-surface-elevated rounded-lg transition-colors border border-transparent hover:border-surface-border"
          title="Re-probe API & Dependencies"
          aria-label="Refresh status"
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        {/* User Profile / Auth Button */}
        {currentUser ? (
          <div className="flex items-center space-x-2 pl-2 border-l border-surface-border">
            <div className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-surface-elevated border border-surface-border">
              <div className="w-6 h-6 rounded-full bg-primary-600/30 text-primary-400 flex items-center justify-center text-xs font-bold font-mono">
                {currentUser.displayName.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-medium text-slate-200 hidden sm:inline">
                {currentUser.displayName}
              </span>
            </div>
            <button
              onClick={onLogout}
              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-surface-elevated rounded-lg transition-colors"
              title="Sign Out"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={onOpenAuth}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-xs font-medium transition-colors shadow-sm"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign In</span>
          </button>
        )}
      </div>
    </header>
  );
};
