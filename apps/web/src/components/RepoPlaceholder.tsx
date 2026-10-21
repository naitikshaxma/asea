import React, { useState, useEffect, useCallback } from 'react';
import { GitBranch, FolderGit2, CheckCircle2, Plus, RefreshCw, AlertCircle, Shield } from 'lucide-react';
import type { WorkspaceResponse, RepositoryResponse, CreateRepositoryRequest } from '@autonomous-engineer/contracts';
import { fetchRepositories, createRepository } from '../api/client';

interface RepoPlaceholderProps {
  activeWorkspace?: WorkspaceResponse | null;
  onRepoSelected?: (repoId: string) => void;
}

export const RepoPlaceholder: React.FC<RepoPlaceholderProps> = ({
  activeWorkspace,
  onRepoSelected,
}) => {
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Form State
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [provider, setProvider] = useState<'LOCAL' | 'GITHUB'>('LOCAL');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    if (!activeWorkspace) {
      setRepositories([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRepositories(activeWorkspace.id);
      setRepositories(data.repositories);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch repositories');
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkspace) return;
    if (!repoName.trim() || !repoUrl.trim()) {
      setFormError('Repository name and URL/path are required');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const payload: CreateRepositoryRequest = {
        name: repoName.trim(),
        repositoryUrl: repoUrl.trim(),
        provider,
        defaultBranch: defaultBranch.trim() || 'main',
      };
      await createRepository(activeWorkspace.id, payload);
      setRepoName('');
      setRepoUrl('');
      setShowAddForm(false);
      await loadRepos();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Could not add repository record');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 rounded-xl bg-surface border border-surface-border">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Repository Management</h2>
          <p className="text-xs text-slate-400">
            {activeWorkspace
              ? `Attached repositories for workspace "${activeWorkspace.name}"`
              : 'Local repository target and version control integration status.'}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {activeWorkspace && (
            <>
              <button
                onClick={loadRepos}
                disabled={loading}
                className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-surface-elevated rounded-lg transition-colors border border-surface-border"
                title="Refresh Repositories"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-primary-600/20 hover:bg-primary-600/30 text-primary-400 border border-primary-500/30 text-xs font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Repository</span>
              </button>
            </>
          )}
          {!activeWorkspace && (
            <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Local Repo Attached</span>
            </span>
          )}
        </div>
      </div>

      {/* Add Repository Inline Form */}
      {showAddForm && activeWorkspace && (
        <form onSubmit={handleAddRepo} className="mb-4 p-4 rounded-lg bg-surface-elevated border border-surface-border space-y-3">
          <div className="text-xs font-semibold text-slate-200">Register New Repository Record</div>
          {formError && (
            <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 mb-1">Repository Name</label>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="e.g. autonomous-core"
                className="w-full px-3 py-1.5 bg-surface rounded border border-surface-border text-slate-200 placeholder-slate-500 focus:outline-none focus:border-primary-500"
                required
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as any)}
                className="w-full px-3 py-1.5 bg-surface rounded border border-surface-border text-slate-200 focus:outline-none focus:border-primary-500"
              >
                <option value="LOCAL">Local Filesystem</option>
                <option value="GITHUB">GitHub (Metadata Record)</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-slate-400 mb-1">Repository URL or Normalized Path</label>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="e.g. https://github.com/org/repo or /workspace/checkout"
                className="w-full px-3 py-1.5 bg-surface rounded border border-surface-border text-slate-200 placeholder-slate-500 focus:outline-none focus:border-primary-500"
                required
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Default Branch</label>
              <input
                type="text"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="main"
                className="w-full px-3 py-1.5 bg-surface rounded border border-surface-border text-slate-200 placeholder-slate-500 focus:outline-none focus:border-primary-500"
              />
            </div>
            <div className="flex items-end justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded text-xs font-medium disabled:opacity-50"
              >
                {submitting ? 'Registering...' : 'Save Record'}
              </button>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 flex items-center space-x-1.5">
            <Shield className="w-3.5 h-3.5" />
            <span>Repository records are stored without OAuth tokens to maintain strict credential isolation.</span>
          </div>
        </form>
      )}

      {/* Repositories List or Default View */}
      {activeWorkspace ? (
        <div className="space-y-3">
          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
              {error}
            </div>
          )}

          {repositories.length === 0 && !loading && (
            <div className="p-4 rounded-lg bg-surface-elevated/40 border border-surface-border text-center">
              <p className="text-xs text-slate-400">
                No repositories attached to this workspace yet. Add a repository record above to associate code repositories with your tasks.
              </p>
            </div>
          )}

          {repositories.map((repo) => (
            <div
              key={repo.id}
              onClick={() => onRepoSelected?.(repo.id)}
              className="p-4 rounded-lg bg-surface-elevated/60 border border-surface-border flex flex-col md:flex-row items-start md:items-center justify-between gap-4 cursor-pointer hover:border-primary-500/40 transition-colors"
            >
              <div className="flex items-center space-x-3.5">
                <div className="p-2.5 rounded-lg bg-primary-600/15 border border-primary-500/30 text-primary-400">
                  <FolderGit2 className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-mono text-sm font-semibold text-slate-200 flex items-center space-x-2">
                    <span>{repo.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-surface-border text-slate-400 font-normal">
                      {repo.provider}
                    </span>
                  </div>
                  <div className="flex items-center space-x-3 text-xs text-slate-400 mt-0.5">
                    <span className="flex items-center space-x-1">
                      <GitBranch className="w-3.5 h-3.5" />
                      <span>Branch: {repo.defaultBranch}</span>
                    </span>
                    <span>•</span>
                    <span className="truncate max-w-xs">{repo.repositoryUrl}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-2 text-xs font-mono">
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {repo.connectionStatus}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Fallback Phase 1 View for unauthenticated / default workspace */
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
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Sign in to manage persistent workspace repositories</span>
          </div>
        </div>
      )}
    </div>
  );
};
