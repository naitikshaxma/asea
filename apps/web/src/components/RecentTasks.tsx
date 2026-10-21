import React from 'react';
import { RefreshCw, AlertCircle, Inbox, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { TaskResponse, TaskStatus } from '@autonomous-engineer/contracts';

interface RecentTasksProps {
  tasks: TaskResponse[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export const RecentTasks: React.FC<RecentTasksProps> = ({
  tasks,
  loading,
  error,
  onRefresh,
}) => {
  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'COMPLETED':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3" />
            <span>COMPLETED</span>
          </span>
        );
      case 'PENDING':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Clock className="w-3 h-3" />
            <span>INTAKE_PENDING</span>
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertCircle className="w-3 h-3" />
            <span>FAILED</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
            <span>{status}</span>
          </span>
        );
    }
  };

  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Task Intake &amp; Activity Log</h2>
          <p className="text-xs text-slate-400">
            Authentic API task session history. No fabricated execution logs.
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="text-xs text-slate-400 hover:text-slate-200 flex items-center space-x-1 px-2.5 py-1 rounded bg-surface-elevated border border-surface-border hover:border-slate-500 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          <span>Reload</span>
        </button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="py-12 flex flex-col items-center justify-center space-y-3 text-slate-400">
          <RefreshCw className="w-6 h-6 animate-spin text-primary-400" />
          <span className="text-xs font-mono">Querying task intake register...</span>
        </div>
      )}

      {/* Error State */}
      {!loading && error && (
        <div className="p-4 rounded-lg bg-rose-950/30 border border-rose-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-rose-300">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={onRefresh}
            className="px-3 py-1 rounded bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 border border-rose-500/30 transition-colors text-xs"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && tasks.length === 0 && (
        <div className="py-12 border border-dashed border-surface-border rounded-lg flex flex-col items-center justify-center text-center px-4">
          <div className="p-3 rounded-full bg-surface-elevated text-slate-500 mb-2">
            <Inbox className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-medium text-slate-200">No tasks registered in this session</h3>
          <p className="text-xs text-slate-400 max-w-sm mt-1">
            Submit an engineering task using the intake form above to verify payload handling.
          </p>
        </div>
      )}

      {/* Populated Table */}
      {!loading && !error && tasks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-surface-border text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-2.5 px-3">Task ID</th>
                <th className="py-2.5 px-3">Type</th>
                <th className="py-2.5 px-3">Title &amp; Note</th>
                <th className="py-2.5 px-3">Priority</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Registered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border/50 text-xs">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-surface-elevated/40 transition-colors">
                  <td className="py-3 px-3 font-mono text-slate-300 font-medium">
                    {task.id}
                  </td>
                  <td className="py-3 px-3">
                    <span className="font-mono text-[11px] text-slate-400 bg-surface-elevated px-2 py-0.5 rounded border border-surface-border">
                      {task.taskType}
                    </span>
                  </td>
                  <td className="py-3 px-3 max-w-md">
                    <div className="font-medium text-slate-200">{task.title}</div>
                    {task.executionMetadata?.note && (
                      <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1 italic">
                        ↳ {task.executionMetadata.note}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={`text-[11px] font-semibold ${
                        task.priority === 'HIGH' || task.priority === 'URGENT'
                          ? 'text-amber-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {task.priority}
                    </span>
                  </td>
                  <td className="py-3 px-3">{getStatusBadge(task.status)}</td>
                  <td className="py-3 px-3 text-right font-mono text-[11px] text-slate-400">
                    {new Date(task.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
