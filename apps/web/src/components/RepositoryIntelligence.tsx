import React, { useState, useEffect, useCallback } from 'react';
import {
  BrainCircuit,
  Search,
  RefreshCw,
  FolderTree,
  Code2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  FileCode,
  Shield,
  FileCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Target,
  FileQuestion,
  Database,
  Cpu,
} from 'lucide-react';
import type {
  WorkspaceResponse,
  RepositoryResponse,
  RepositoryAnalysisResponse,
  RelevantFileResult,
  FileInventoryItem,
} from '@autonomous-engineer/contracts';
import {
  fetchRepositories,
  triggerRepositoryAnalysis,
  fetchLatestAnalysis,
  fetchAnalysisFiles,
  fetchRelevantFiles,
} from '../api/client';

interface RepositoryIntelligenceProps {
  activeWorkspace: WorkspaceResponse | null;
  selectedRepoId?: string;
}

export const RepositoryIntelligence: React.FC<RepositoryIntelligenceProps> = ({
  activeWorkspace,
  selectedRepoId,
}) => {
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepositoryResponse | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);

  // Analysis State
  const [analysis, setAnalysis] = useState<RepositoryAnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Task-Focused Retrieval State
  const [taskQuery, setTaskQuery] = useState('');
  const [relevantFiles, setRelevantFiles] = useState<RelevantFileResult[]>([]);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingError, setRankingError] = useState<string | null>(null);

  // File Inventory Drawer / Table State
  const [showInventory, setShowInventory] = useState(false);
  const [inventoryFiles, setInventoryFiles] = useState<FileInventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryCategory, setInventoryCategory] = useState<string>('ALL');

  // Load repositories for active workspace
  const loadRepositories = useCallback(async () => {
    if (!activeWorkspace) {
      setRepositories([]);
      setSelectedRepo(null);
      return;
    }

    setLoadingRepos(true);
    try {
      const data = await fetchRepositories(activeWorkspace.id);
      setRepositories(data.repositories);
      if (data.repositories.length > 0) {
        if (selectedRepoId) {
          const match = data.repositories.find((r) => r.id === selectedRepoId);
          setSelectedRepo(match || data.repositories[0] || null);
        } else {
          setSelectedRepo(data.repositories[0] || null);
        }
      } else {
        setSelectedRepo(null);
      }
    } catch {
      setRepositories([]);
    } finally {
      setLoadingRepos(false);
    }
  }, [activeWorkspace, selectedRepoId]);

  useEffect(() => {
    loadRepositories();
  }, [loadRepositories]);

  // Load latest analysis when repository is selected
  const loadAnalysis = useCallback(async () => {
    if (!activeWorkspace || !selectedRepo) {
      setAnalysis(null);
      return;
    }

    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await fetchLatestAnalysis(activeWorkspace.id, selectedRepo.id);
      setAnalysis(result);
    } catch {
      // If no analysis exists yet, set null
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  }, [activeWorkspace, selectedRepo]);

  useEffect(() => {
    loadAnalysis();
    setRelevantFiles([]);
    setTaskQuery('');
  }, [loadAnalysis]);

  // Trigger new analysis
  const handleRunAnalysis = async () => {
    if (!activeWorkspace || !selectedRepo) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await triggerRepositoryAnalysis(activeWorkspace.id, selectedRepo.id);
      setAnalysis(result);
    } catch (err: unknown) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed to start');
    } finally {
      setAnalysisLoading(false);
    }
  };

  // Run Task-Focused File Retrieval
  const handleFindRelevantFiles = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkspace || !selectedRepo || !taskQuery.trim()) return;

    setRankingLoading(true);
    setRankingError(null);
    try {
      const response = await fetchRelevantFiles(activeWorkspace.id, selectedRepo.id, {
        taskDescription: taskQuery.trim(),
        limit: 10,
      });
      setRelevantFiles(response.results);
    } catch (err: unknown) {
      setRankingError(err instanceof Error ? err.message : 'Failed to retrieve relevant files');
    } finally {
      setRankingLoading(false);
    }
  };

  // Load Inventory Files
  const loadInventoryFiles = async () => {
    if (!activeWorkspace || !selectedRepo || !analysis) return;
    setInventoryLoading(true);
    try {
      const data = await fetchAnalysisFiles(activeWorkspace.id, selectedRepo.id, analysis.id, {
        page: 1,
        pageSize: 100,
        category: inventoryCategory !== 'ALL' ? inventoryCategory : undefined,
      });
      setInventoryFiles(data.files);
    } catch {
      setInventoryFiles([]);
    } finally {
      setInventoryLoading(false);
    }
  };

  useEffect(() => {
    if (showInventory) {
      loadInventoryFiles();
    }
  }, [showInventory, inventoryCategory]);

  return (
    <div className="space-y-6">
      {/* Top Header Card: Repo Picker & Actions */}
      <div className="p-6 rounded-xl bg-surface border border-surface-border">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-lg bg-primary-600/20 text-primary-400 border border-primary-500/30">
                <BrainCircuit className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center space-x-2">
                  <span>Repository Intelligence Engine</span>
                  <span className="text-[10px] font-mono uppercase bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20">
                    Phase 3
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  AST structure mapping, evidence-backed technology detection &amp; task-focused file ranking.
                </p>
              </div>
            </div>
          </div>

          {/* Repo Selector & Analyze Action */}
          <div className="flex items-center space-x-3">
            {activeWorkspace && repositories.length > 0 && (
              <select
                value={selectedRepo?.id || ''}
                onChange={(e) => {
                  const r = repositories.find((x) => x.id === e.target.value);
                  if (r) setSelectedRepo(r);
                }}
                className="px-3 py-1.5 rounded-lg bg-surface-elevated border border-surface-border text-xs text-slate-200 focus:outline-none focus:border-primary-500"
              >
                {repositories.map((r) => (
                  <option key={r.id} value={r.id} className="bg-surface text-slate-100">
                    {r.name} ({r.provider})
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={handleRunAnalysis}
              disabled={analysisLoading || !selectedRepo}
              className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-xs font-medium transition-colors disabled:opacity-50 shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${analysisLoading ? 'animate-spin' : ''}`} />
              <span>{analysisLoading ? 'Analyzing Snapshot...' : 'Analyze Repository'}</span>
            </button>
          </div>
        </div>

        {analysisError && (
          <div className="mt-4 p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 flex items-center space-x-2 text-xs text-rose-300">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{analysisError}</span>
          </div>
        )}
      </div>

      {/* Unauthenticated or No Repositories Banner */}
      {!activeWorkspace && (
        <div className="p-6 rounded-xl bg-surface-elevated/40 border border-surface-border text-center">
          <p className="text-xs text-slate-400">
            Sign in and select an authorized workspace to run repository intelligence on attached codebases.
          </p>
        </div>
      )}

      {activeWorkspace && repositories.length === 0 && !loadingRepos && (
        <div className="p-6 rounded-xl bg-surface-elevated/40 border border-surface-border text-center">
          <p className="text-xs text-slate-400">
            No repositories attached to workspace "{activeWorkspace.name}". Register a repository in the Repositories tab to analyze its architecture.
          </p>
        </div>
      )}

      {/* Main Analysis Display (When Analysis Available) */}
      {selectedRepo && analysis && (
        <>
          {/* Analysis Metrics & Overview Card */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-surface border border-surface-border space-y-1">
              <div className="text-[11px] font-mono text-slate-400 uppercase">Analysis Status</div>
              <div className="flex items-center space-x-2">
                <span
                  className={`inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium ${
                    analysis.status === 'COMPLETED'
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : analysis.status === 'FAILED'
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}
                >
                  {analysis.status === 'COMPLETED' && <CheckCircle2 className="w-3.5 h-3.5" />}
                  {analysis.status === 'FAILED' && <AlertTriangle className="w-3.5 h-3.5" />}
                  {analysis.status === 'RUNNING' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{analysis.status}</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">v{analysis.analyzerVersion}</span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-surface border border-surface-border space-y-1">
              <div className="text-[11px] font-mono text-slate-400 uppercase">Scanned Inventory</div>
              <div className="text-xl font-bold font-mono text-slate-100">
                {analysis.statistics?.eligibleFiles || 0}{' '}
                <span className="text-xs font-normal text-slate-400">
                  / {analysis.statistics?.totalFiles || 0} files
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-surface border border-surface-border space-y-1">
              <div className="text-[11px] font-mono text-slate-400 uppercase">Excluded / Skipped</div>
              <div className="text-xl font-bold font-mono text-slate-300">
                {analysis.statistics?.skippedFiles || 0}{' '}
                <span className="text-xs font-normal text-slate-500">
                  ({analysis.statistics?.secretFilesExcluded || 0} secrets,{' '}
                  {analysis.statistics?.binaryFilesSkipped || 0} binaries)
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-surface border border-surface-border space-y-1">
              <div className="text-[11px] font-mono text-slate-400 uppercase">Scan Execution Time</div>
              <div className="text-xl font-bold font-mono text-slate-100">
                {analysis.statistics?.durationMs || 0}
                <span className="text-xs font-normal text-slate-400">ms</span>
              </div>
            </div>
          </div>

          {/* Detected Technologies Section */}
          <div className="p-6 rounded-xl bg-surface border border-surface-border">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Detected Technologies &amp; Tooling</h3>
                <p className="text-xs text-slate-400">Evidence-backed framework and ecosystem discovery</p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {analysis.technologies.length} technologies found
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {analysis.technologies.map((tech, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-lg bg-surface-elevated/70 border border-surface-border text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200 flex items-center space-x-1.5">
                      <Cpu className="w-3.5 h-3.5 text-primary-400" />
                      <span>{tech.name}</span>
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface border border-surface-border text-slate-400">
                      {tech.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{tech.rationale}</p>
                  <div className="pt-1 text-[10px] font-mono text-slate-500 truncate">
                    Evidence: {tech.evidenceFiles.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Architecture Structure Map */}
          {analysis.summary && (
            <div className="p-6 rounded-xl bg-surface border border-surface-border space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Architecture Structure Map</h3>
                <p className="text-xs text-slate-400 mt-0.5">{analysis.summary.repositoryOverview}</p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Entry Points & Core Modules */}
                <div className="space-y-4">
                  <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border space-y-2">
                    <div className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
                      <ExternalLink className="w-3.5 h-3.5 text-primary-400" />
                      <span>Application Entry Points</span>
                    </div>
                    {(analysis.summary.entryPoints || []).length === 0 ? (
                      <p className="text-xs text-slate-500">No standard entry points detected.</p>
                    ) : (
                      <div className="space-y-1">
                        {(analysis.summary.entryPoints || []).map((ep, idx) => (
                          <div
                            key={idx}
                            className="font-mono text-xs text-slate-300 bg-surface px-2.5 py-1 rounded border border-surface-border/60 flex items-center space-x-2"
                          >
                            <Code2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>{ep}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border space-y-2">
                    <div className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
                      <FolderTree className="w-3.5 h-3.5 text-primary-400" />
                      <span>Primary Functional Modules</span>
                    </div>
                    <div className="space-y-1.5 max-h-56 overflow-y-auto">
                      {(analysis.summary.keyModules || []).map((km, idx) => (
                        <div
                          key={idx}
                          className="p-2 rounded bg-surface border border-surface-border/60 text-xs flex items-start justify-between gap-2"
                        >
                          <div>
                            <div className="font-mono text-[11px] font-semibold text-slate-200">
                              {km.path}
                            </div>
                            <div className="text-[11px] text-slate-400">{km.description}</div>
                          </div>
                          <span className="text-[10px] font-mono text-slate-500 shrink-0">
                            {km.fileCount} files
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* API Routes & Test Frameworks */}
                <div className="space-y-4">
                  <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border space-y-2">
                    <div className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
                      <Layers className="w-3.5 h-3.5 text-primary-400" />
                      <span>API Route Handlers</span>
                    </div>
                    {(analysis.summary.apiRoutes || []).length === 0 ? (
                      <p className="text-xs text-slate-500">No static API route definitions discovered.</p>
                    ) : (
                      <div className="space-y-1 max-h-44 overflow-y-auto">
                        {(analysis.summary.apiRoutes || []).map((route, idx) => (
                          <div
                            key={idx}
                            className="font-mono text-xs text-slate-300 bg-surface px-2.5 py-1 rounded border border-surface-border/60 flex items-center justify-between"
                          >
                            <span>{route.path}</span>
                            <span className="text-[10px] text-slate-500">{route.framework}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border space-y-2">
                    <div className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
                      <FileCheck className="w-3.5 h-3.5 text-primary-400" />
                      <span>Test Coverage Locations</span>
                    </div>
                    <div className="text-xs text-slate-400">
                      Frameworks: {(analysis.summary.testFrameworks || []).join(', ') || 'None detected'}
                    </div>
                    <div className="font-mono text-xs text-slate-300 max-h-36 overflow-y-auto space-y-1">
                      {(analysis.summary.testLocations || []).slice(0, 10).map((tl, idx) => (
                        <div
                          key={idx}
                          className="bg-surface px-2.5 py-1 rounded border border-surface-border/60 truncate"
                        >
                          {tl}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Interactive Task-Focused File Retrieval */}
          <div className="p-6 rounded-xl bg-surface border border-surface-border space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center space-x-2">
                <Target className="w-4 h-4 text-primary-400" />
                <span>Task-Focused Relevant File Retrieval</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Input an engineering problem statement to score and rank relevant files before attempting changes.
              </p>
            </div>

            <form onSubmit={handleFindRelevantFiles} className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  required
                  value={taskQuery}
                  onChange={(e) => setTaskQuery(e.target.value)}
                  placeholder="e.g., Investigate memory leak in authMiddleware during token verification"
                  className="w-full px-4 py-2.5 rounded-lg bg-surface-elevated border border-surface-border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-primary-500 pr-24"
                />
                <button
                  type="submit"
                  disabled={rankingLoading || !taskQuery.trim()}
                  className="absolute right-1.5 top-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {rankingLoading ? 'Ranking...' : 'Rank Files'}
                </button>
              </div>
            </form>

            {rankingError && (
              <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs">
                {rankingError}
              </div>
            )}

            {relevantFiles.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <div className="text-xs font-semibold text-slate-300">
                  Top Ranked Files for Task Query:
                </div>
                <div className="space-y-2">
                  {relevantFiles.map((file, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-surface-elevated border border-surface-border flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="font-mono text-slate-200 font-semibold flex items-center space-x-2">
                          <span className="text-primary-400">#{idx + 1}</span>
                          <span>{file.path}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-surface-border text-slate-400">
                            {file.category}
                          </span>
                        </div>
                        <p className="text-slate-400 text-[11px]">{file.reason}</p>
                        {file.suggestedAction && (
                          <div className="text-[11px] text-emerald-400 font-mono">
                            ↳ Recommendation: {file.suggestedAction}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center space-x-3 shrink-0">
                        <span className="font-mono text-xs px-2.5 py-1 rounded bg-primary-600/15 border border-primary-500/30 text-primary-300 font-semibold">
                          Score: {file.score}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Toggle File Inventory Browser */}
          <div className="p-6 rounded-xl bg-surface border border-surface-border">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Repository File Inventory</h3>
                <p className="text-xs text-slate-400">
                  Inspect canonical file metadata, detected languages, and exclusion reasons.
                </p>
              </div>
              <button
                onClick={() => setShowInventory(!showInventory)}
                className="px-3 py-1.5 rounded-lg bg-surface-elevated border border-surface-border hover:border-slate-500 text-xs font-medium text-slate-300 transition-colors"
              >
                {showInventory ? 'Hide Inventory' : 'Browse Inventory'}
              </button>
            </div>

            {showInventory && (
              <div className="mt-4 space-y-3 pt-3 border-t border-surface-border">
                {/* Category Filter */}
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-slate-400">Filter:</span>
                  {['ALL', 'SOURCE', 'TEST', 'CONFIG', 'DOCUMENTATION', 'INFRASTRUCTURE'].map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setInventoryCategory(cat)}
                      className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                        inventoryCategory === cat
                          ? 'bg-primary-600 text-white'
                          : 'bg-surface-elevated text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {inventoryLoading ? (
                  <div className="py-8 text-center text-xs text-slate-400 font-mono">
                    Loading inventory...
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto space-y-1">
                    {inventoryFiles.map((f, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded bg-surface-elevated text-xs font-mono flex items-center justify-between border border-surface-border/40"
                      >
                        <span className="text-slate-300 truncate max-w-lg">{f.path}</span>
                        <div className="flex items-center space-x-3 text-slate-500 text-[11px]">
                          <span>{f.category}</span>
                          {f.language && <span className="text-slate-400">{f.language}</span>}
                          {f.skippedReason && (
                            <span className="text-amber-400">Skipped: {f.skippedReason}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Empty State when no analysis has been run */}
      {selectedRepo && !analysis && !analysisLoading && (
        <div className="p-12 border border-dashed border-surface-border rounded-xl flex flex-col items-center justify-center text-center space-y-3">
          <div className="p-3 rounded-full bg-surface-elevated text-slate-400">
            <BrainCircuit className="w-8 h-8 text-primary-400" />
          </div>
          <h3 className="text-sm font-semibold text-slate-200">
            No intelligence snapshot for "{selectedRepo.name}"
          </h3>
          <p className="text-xs text-slate-400 max-w-md">
            Click "Analyze Repository" above to scan the repository structure, detect technologies, and map entry points and modules.
          </p>
        </div>
      )}
    </div>
  );
};
