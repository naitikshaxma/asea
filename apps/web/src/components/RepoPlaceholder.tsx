import React from 'react';
import { GitBranch, FolderGit2, CheckCircle2, Lock } from 'lucide-react';

export const RepoPlaceholder: React.FC = () => {
  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Repository Connection</h2>
          <p className="text-xs text-slate-400">
            Source repository target and version control integration status.
          </p>
        </div>
        <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Local Repo Attached</span>
        </span>
      </div>

      <div className="p-4 rounded-lg bg-surface-elevated/60 border border-surface-border flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="p-2.5 rounded-lg bg-primary-600/15 border border-primary-500/30 text-primary-400">
            <FolderGit2 className="w-5 h-5" />
          </div>
          <div>
            <div className="font-mono text-sm font-semibold text-slate-200">
              workspace: miniprject (monorepo root)
            </div>
            <div className="flex items-center space-x-3 text-xs text-slate-400 mt-0.5">
              <span className="flex items-center space-x-1">
                <GitBranch className="w-3.5 h-3.5" />
                <span>Branch: main</span>
              </span>
              <span>•</span>
              <span>Local Git workspace active</span>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs text-slate-400 bg-surface px-3 py-1.5 rounded border border-surface-border">
          <Lock className="w-3.5 h-3.5 text-slate-500" />
          <span>GitHub App &amp; Webhooks: Phase 2</span>
        </div>
      </div>
    </div>
  );
};
