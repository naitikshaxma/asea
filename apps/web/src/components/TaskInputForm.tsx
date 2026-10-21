import React, { useState } from 'react';
import { Send, AlertCircle, CheckCircle2, Loader2, Info } from 'lucide-react';
import type { TaskSubmissionRequest, TaskType, TaskPriority } from '@autonomous-engineer/contracts';
import { submitTask, submitWorkspaceTask } from '../api/client';

interface TaskInputFormProps {
  onTaskCreated: () => void;
  activeWorkspaceId?: string;
}

export const TaskInputForm: React.FC<TaskInputFormProps> = ({ onTaskCreated, activeWorkspaceId }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('BUG_INVESTIGATION');
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [targetBranch, setTargetBranch] = useState('main');

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setLoading(true);

    try {
      const payload: TaskSubmissionRequest = {
        title,
        description,
        taskType,
        priority,
        repositoryUrl: repositoryUrl ? repositoryUrl : undefined,
        targetBranch,
        workspaceId: activeWorkspaceId,
      };

      const result = activeWorkspaceId
        ? await submitWorkspaceTask(activeWorkspaceId, payload)
        : await submitTask(payload);

      setSuccessMessage(
        `Task '${result.id}' successfully persisted in PostgreSQL and queued in BullMQ.`
      );
      setTitle('');
      setDescription('');
      setRepositoryUrl('');
      onTaskCreated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit task';
      setErrorMessage(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Submit Engineering Task</h2>
          <p className="text-xs text-slate-400">
            Durable task management backed by PostgreSQL and BullMQ queues.
          </p>
        </div>
      </div>

      {/* Honest Boundary Notice */}
      <div className="mb-5 p-3.5 rounded-lg bg-blue-950/30 border border-blue-500/20 flex items-start space-x-3 text-xs text-blue-300 leading-relaxed">
        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-blue-200">Phase 2 Asynchronous Pipeline:</span> Submitting
          this task creates a transactional outbox record, persists the task and run in PostgreSQL,
          and enqueues background processing via Redis. Real autonomous code editing takes place in
          Phase 3.
        </div>
      </div>

      {errorMessage && (
        <div className="mb-4 p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 flex items-start space-x-2 text-xs text-rose-300">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/30 flex items-start space-x-2 text-xs text-emerald-300">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{successMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="task-title" className="block text-xs font-medium text-slate-300 mb-1.5">
            Task Title <span className="text-rose-400">*</span>
          </label>
          <input
            id="task-title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Investigate memory growth in batch indexing worker"
            className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="task-type" className="block text-xs font-medium text-slate-300 mb-1.5">
              Task Type
            </label>
            <select
              id="task-type"
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-200 focus:outline-none focus:border-primary-500"
            >
              <option value="BUG_INVESTIGATION">Bug Investigation</option>
              <option value="CODE_PATCH">Code Patch Generation</option>
              <option value="TEST_GENERATION">Regression Test Suite</option>
              <option value="CODE_REVIEW">Automated Code Review</option>
              <option value="CI_DIAGNOSIS">CI/CD Pipeline Diagnosis</option>
            </select>
          </div>

          <div>
            <label htmlFor="task-priority" className="block text-xs font-medium text-slate-300 mb-1.5">
              Priority
            </label>
            <select
              id="task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-200 focus:outline-none focus:border-primary-500"
            >
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="repo-url" className="block text-xs font-medium text-slate-300 mb-1.5">
              Target Repository URL <span className="text-slate-500">(Optional)</span>
            </label>
            <input
              id="repo-url"
              type="url"
              value={repositoryUrl}
              onChange={(e) => setRepositoryUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-primary-500"
            />
          </div>

          <div>
            <label htmlFor="target-branch" className="block text-xs font-medium text-slate-300 mb-1.5">
              Target Branch
            </label>
            <input
              id="target-branch"
              type="text"
              value={targetBranch}
              onChange={(e) => setTargetBranch(e.target.value)}
              placeholder="main"
              className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-primary-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor="task-description" className="block text-xs font-medium text-slate-300 mb-1.5">
            Detailed Problem Statement <span className="text-rose-400">*</span>
          </label>
          <textarea
            id="task-description"
            rows={4}
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the defect symptoms, reproduction steps, expected versus actual behavior, or relevant logs..."
            className="w-full px-3.5 py-2 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-primary-500 resize-none font-mono text-xs"
          />
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Persisting &amp; Enqueueing...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Submit &amp; Enqueue Task</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
