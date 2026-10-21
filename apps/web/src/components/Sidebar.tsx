import React from 'react';
import {
  Layers,
  GitBranch,
  CheckSquare,
  ShieldAlert,
  Settings,
  BookOpen,
  Activity,
  X,
} from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  mobileOpen,
  setMobileOpen,
}) => {
  const navItems = [
    { id: 'overview', label: 'Workspace Overview', icon: Layers },
    { id: 'tasks', label: 'Engineering Tasks', icon: CheckSquare },
    { id: 'repositories', label: 'Repositories', icon: GitBranch },
    { id: 'execution', label: 'Worker Sandboxes', icon: Activity },
    { id: 'security', label: 'Security & Boundaries', icon: ShieldAlert },
    { id: 'docs', label: 'Documentation', icon: BookOpen },
    { id: 'settings', label: 'System Settings', icon: Settings },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-64 bg-surface border-r border-surface-border flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-surface-border">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-primary-600/20 border border-primary-500/40 flex items-center justify-center">
              <span className="text-primary-500 font-bold text-lg font-mono">AE</span>
            </div>
            <div>
              <span className="font-semibold text-slate-100 text-sm tracking-tight block">
                Autonomous
              </span>
              <span className="text-xs text-slate-400 font-mono">Platform v0.1.0</span>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden text-slate-400 hover:text-slate-200 p-1 rounded-md"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Phase Badge */}
        <div className="px-6 py-3 border-b border-surface-border/50 bg-surface-elevated/40">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Roadmap Stage:</span>
            <span className="px-2 py-0.5 rounded-full font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
              Phase 1 Monorepo
            </span>
          </div>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileOpen(false);
                }}
                className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary-600/15 text-primary-400 border border-primary-500/30'
                    : 'text-slate-300 hover:bg-surface-elevated hover:text-slate-100'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-primary-400' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Worker Policy Notice */}
        <div className="p-4 border-t border-surface-border">
          <div className="p-3 rounded-lg bg-surface-elevated/60 border border-surface-border text-xs text-slate-400 space-y-1">
            <div className="flex items-center space-x-1.5 text-slate-300 font-medium">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Worker Boundary</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Arbitrary host shell execution is disabled. Zero-trust isolation enforced.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
};
