import React, { useState, useEffect, useCallback } from 'react';
import type { TaskResponse, ReadinessResponse } from '@autonomous-engineer/contracts';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { MetricsOverview } from './components/MetricsOverview';
import { TaskInputForm } from './components/TaskInputForm';
import { ExecutionPanel } from './components/ExecutionPanel';
import { RecentTasks } from './components/RecentTasks';
import { RepoPlaceholder } from './components/RepoPlaceholder';
import { fetchHealth, fetchReadiness, fetchTasks } from './api/client';
import { ShieldAlert, BookOpen, Terminal } from 'lucide-react';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileOpen, setMobileOpen] = useState(false);

  // API State
  const [apiStatus, setApiStatus] = useState<'checking' | 'connected' | 'disconnected' | 'degraded'>('checking');
  const [readinessData, setReadinessData] = useState<ReadinessResponse | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  // Tasks State
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const checkConnectivity = useCallback(async () => {
    setApiStatus('checking');
    const start = Date.now();
    try {
      await fetchHealth();
      const elapsed = Date.now() - start;
      setLatency(elapsed);

      // Probe readiness
      try {
        const ready = await fetchReadiness();
        setReadinessData(ready);
        if (ready.status === 'ready') {
          setApiStatus('connected');
        } else {
          setApiStatus('degraded');
        }
      } catch {
        setApiStatus('connected');
      }
    } catch {
      setApiStatus('disconnected');
      setReadinessData(null);
      setLatency(null);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const data = await fetchTasks();
      setTasks(data.tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not retrieve tasks from API';
      setTasksError(msg);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    checkConnectivity();
    loadTasks();
  }, [checkConnectivity, loadTasks]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  return (
    <div className="min-h-screen bg-background flex flex-col lg:flex-row">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        {/* Header */}
        <Header
          onToggleMobile={() => setMobileOpen(true)}
          apiStatus={apiStatus}
          readinessData={readinessData}
          onRefresh={refreshAll}
          latency={latency}
        />

        {/* View Router */}
        <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
          {activeTab === 'overview' && (
            <>
              {/* Top Overview Cards */}
              <MetricsOverview taskCount={tasks.length} apiConnected={apiStatus !== 'disconnected'} />

              {/* Repository Attachment Status */}
              <RepoPlaceholder />

              {/* Grid: Task Intake Form & Worker Sandbox */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <TaskInputForm onTaskCreated={loadTasks} />
                <ExecutionPanel />
              </div>

              {/* Activity & Tasks Table */}
              <RecentTasks
                tasks={tasks}
                loading={tasksLoading}
                error={tasksError}
                onRefresh={loadTasks}
              />
            </>
          )}

          {activeTab === 'tasks' && (
            <div className="space-y-6">
              <TaskInputForm onTaskCreated={loadTasks} />
              <RecentTasks
                tasks={tasks}
                loading={tasksLoading}
                error={tasksError}
                onRefresh={loadTasks}
              />
            </div>
          )}

          {activeTab === 'repositories' && (
            <div className="space-y-6">
              <RepoPlaceholder />
              <div className="p-6 rounded-xl bg-surface border border-surface-border text-xs text-slate-400 space-y-3">
                <h3 className="text-sm font-semibold text-slate-200">Repository Capabilities Roadmap</h3>
                <p>
                  In Phase 1, repository operations are performed against local checkouts within verified boundaries.
                </p>
                <div className="p-4 rounded bg-surface-elevated font-mono text-[11px] text-slate-300 space-y-1">
                  <div>Phase 1: Local Monorepo Workspace Validation [ACTIVE]</div>
                  <div>Phase 2: GitHub App App-Level Token Authentication &amp; Webhook Intake [PLANNED]</div>
                  <div>Phase 3: Automated Branch Isolation, Verified Patching &amp; PR Generation [PLANNED]</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'execution' && (
            <div className="space-y-6">
              <ExecutionPanel />
              <div className="p-6 rounded-xl bg-surface border border-surface-border space-y-3">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-primary-400" />
                  <span>Execution Sandbox Worker Specification</span>
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  For safety reasons, no arbitrary shell code runs in Phase 1. All future execution takes place inside disposable microVM or rootless container environments with bounded CPU, memory, and blocked network access.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-6">
              <div className="p-6 rounded-xl bg-surface border border-surface-border">
                <div className="flex items-center space-x-3 mb-4">
                  <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <ShieldAlert className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">Zero-Trust Security Controls</h2>
                    <p className="text-xs text-slate-400">Enforced boundaries and safe isolation practices</p>
                  </div>
                </div>

                <div className="space-y-3 text-xs text-slate-300">
                  <div className="p-3.5 rounded-lg bg-surface-elevated border border-surface-border">
                    <div className="font-semibold text-slate-200 mb-1">Credential Protection</div>
                    <p className="text-slate-400">
                      The frontend contains zero database credentials or private keys. All sensitive secrets are managed via strictly scoped environment variables, validated at startup and masked in logs.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-lg bg-surface-elevated border border-surface-border">
                    <div className="font-semibold text-slate-200 mb-1">Bounded Code Execution</div>
                    <p className="text-slate-400">
                      Phase 1 does not permit arbitrary shell command execution. Phase 2 introduces disposable gVisor/Firecracker micro-sandboxes with dropped capabilities.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'docs' && (
            <div className="p-6 rounded-xl bg-surface border border-surface-border space-y-4">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 rounded-lg bg-primary-600/15 text-primary-400 border border-primary-500/30">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-100">Architecture &amp; Documentation</h2>
                  <p className="text-xs text-slate-400">Technical references and operational guides</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border">
                  <div className="font-semibold text-slate-200">Architecture Guide</div>
                  <p className="text-slate-400 mt-1">docs/architecture.md</p>
                </div>
                <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border">
                  <div className="font-semibold text-slate-200">Development Guide</div>
                  <p className="text-slate-400 mt-1">docs/development.md</p>
                </div>
                <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border">
                  <div className="font-semibold text-slate-200">Security Model</div>
                  <p className="text-slate-400 mt-1">docs/security.md</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="p-6 rounded-xl bg-surface border border-surface-border space-y-4">
              <h2 className="text-base font-semibold text-slate-100">System Environment &amp; Ports</h2>
              <div className="p-4 rounded-lg bg-surface-elevated border border-surface-border font-mono text-xs text-slate-300 space-y-2">
                <div>Frontend Web: http://localhost:5173</div>
                <div>Express API: http://localhost:4000</div>
                <div>FastAPI Agent Service: http://localhost:8000</div>
                <div>PostgreSQL: 127.0.0.1:5432</div>
                <div>Redis: 127.0.0.1:6379</div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
