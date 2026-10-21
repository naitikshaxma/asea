import React from 'react';
import { Lock } from 'lucide-react';

// Sandboxed execution is not implemented yet: the worker records placeholder
// workflow steps and never runs repository code.
export const ExecutionPanel: React.FC = () => {
  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Execution Worker &amp; Sandbox Boundary
          </h2>
          <p className="text-xs text-slate-400">
            Isolated execution for autonomous AI code verification.
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
          Coming soon
        </span>
      </div>

      <div className="p-4 rounded-lg bg-surface-elevated/60 border border-surface-border/80 flex items-start space-x-3">
        <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-400 leading-relaxed">
          No sandbox exists yet. The background worker does not execute repository code; it only
          records placeholder workflow steps. Container isolation, resource limits, network
          restrictions and execution audit logs are planned but not implemented.
        </p>
      </div>
    </div>
  );
};
