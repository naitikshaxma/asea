import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { App } from './App';
import * as client from './api/client';

function mockAuthenticatedSession() {
  vi.spyOn(client, 'fetchCurrentUser').mockResolvedValue({
    user: {
      id: 'usr-1',
      email: 'alice@autonomous.dev',
      displayName: 'Alice Architect',
      accountStatus: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
    workspaces: [
      {
        id: 'ws-100',
        name: 'Core Platform Team',
        ownerId: 'usr-1',
        role: 'OWNER',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
}

describe('Web Application Dashboard Shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to unauthenticated session for baseline tests
    vi.spyOn(client, 'fetchCurrentUser').mockRejectedValue(new Error('Unauthenticated'));
  });

  it('renders application brand, header, and main navigation links', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 120,
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchReadiness').mockResolvedValue({
      status: 'ready',
      service: '@autonomous-engineer/api',
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Autonomous')).toBeInTheDocument();
      expect(screen.getByText('Engineering Control Plane')).toBeInTheDocument();
      expect(screen.getByText('Workspace Overview')).toBeInTheDocument();
      expect(screen.getByText('Engineering Tasks')).toBeInTheDocument();
      expect(screen.getByText('Repositories')).toBeInTheDocument();
    });
  });

  it('displays API Online badge when health and readiness checks succeed', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchReadiness').mockResolvedValue({
      status: 'ready',
      service: '@autonomous-engineer/api',
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('API Online')).toBeInTheDocument();
    });
  });

  it('renders honest empty state when no tasks are present in register', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchReadiness').mockResolvedValue({
      status: 'ready',
      service: '@autonomous-engineer/api',
      timestamp: new Date().toISOString(),
      dependencies: {},
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('No tasks registered in this session')).toBeInTheDocument();
    });
  });

  it('displays error state when task fetch fails', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('Network error'));
    mockAuthenticatedSession();
    vi.spyOn(client, 'fetchWorkspaceTasks').mockRejectedValue(new Error('API Connection Refused'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('API Offline')).toBeInTheDocument();
      expect(screen.getByText('API Connection Refused')).toBeInTheDocument();
    });
  });

  it('shows honest coming-soon states instead of unimplemented sandbox and metric claims', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('Network error'));

    render(<App />);

    // One in MetricsOverview, one in ExecutionPanel
    expect(await screen.findAllByText('Coming soon')).toHaveLength(2);
    expect(screen.getByText(/No sandbox exists yet/)).toBeInTheDocument();
    for (const claim of [/OCI Container/, /cgroup/, /syscall/i, /^Secured$/, /Enforced Boundary/, /Pydantic synchrony/]) {
      expect(screen.queryByText(claim)).not.toBeInTheDocument();
    }
  });

  it('requires a signed-in workspace before tasks can be submitted', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('Network error'));
    const submitSpy = vi.spyOn(client, 'submitWorkspaceTask');

    render(<App />);

    const notices = await screen.findAllByText('Sign in and select a workspace to submit tasks.');
    expect(notices.length).toBeGreaterThanOrEqual(1);
    for (const button of screen.getAllByRole('button', { name: /Submit & Enqueue Task/i })) {
      expect(button).toBeDisabled();
    }
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('submits tasks through the workspace-scoped API', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('Network error'));
    mockAuthenticatedSession();
    vi.spyOn(client, 'fetchWorkspaceTasks').mockResolvedValue({ tasks: [], total: 0 });
    const submitSpy = vi.spyOn(client, 'submitWorkspaceTask').mockResolvedValue({
      id: 'task-new-1',
      title: 'Investigate worker crash',
      description: 'Worker exits during repository inspection step.',
      taskType: 'BUG_INVESTIGATION',
      priority: 'NORMAL',
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(<App />);
    await screen.findByText('Alice Architect');

    fireEvent.change(screen.getByLabelText(/Task Title/i), {
      target: { value: 'Investigate worker crash' },
    });
    fireEvent.change(screen.getByLabelText(/Detailed Problem Statement/i), {
      target: { value: 'Worker exits during repository inspection step.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit & Enqueue Task/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        'ws-100',
        expect.objectContaining({ title: 'Investigate worker crash' })
      );
    });
  });

  it('renders authenticated workspace session with user badge and workspace tasks', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchReadiness').mockResolvedValue({
      status: 'ready',
      service: '@autonomous-engineer/api',
      timestamp: new Date().toISOString(),
      dependencies: {},
    });

    vi.spyOn(client, 'fetchCurrentUser').mockResolvedValue({
      user: {
        id: 'usr-1',
        email: 'alice@autonomous.dev',
        displayName: 'Alice Architect',
        accountStatus: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      workspaces: [
        {
          id: 'ws-100',
          name: 'Core Platform Team',
          ownerId: 'usr-1',
          role: 'OWNER',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    vi.spyOn(client, 'fetchWorkspaceTasks').mockResolvedValue({
      tasks: [
        {
          id: 'task-persistent-1',
          title: 'Memory leak in worker pool',
          description: 'Investigating high memory utilization',
          taskType: 'BUG_INVESTIGATION',
          priority: 'HIGH',
          status: 'RUNNING',
          targetBranch: 'main',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Alice Architect')).toBeInTheDocument();
      expect(screen.getAllByText(/Core Platform Team/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Memory leak in worker pool')).toBeInTheDocument();
      expect(screen.getByText('RUNNING')).toBeInTheDocument();
    });
  });

  it('opens authentication modal when Sign In button is clicked', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    render(<App />);

    const signInBtn = await screen.findByRole('button', { name: /Sign In/i });
    fireEvent.click(signInBtn);

    expect(screen.getByText('Sign In to Workspace')).toBeInTheDocument();
  });

  it('navigates to Repository Intelligence tab and renders intelligence panel', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    render(<App />);

    const intelligenceNavBtn = await screen.findByRole('button', { name: /Repo Intelligence/i });
    fireEvent.click(intelligenceNavBtn);

    await waitFor(() => {
      expect(screen.getByText('Repository Intelligence Engine')).toBeInTheDocument();
      expect(screen.getByText('Phase 3')).toBeInTheDocument();
      expect(screen.getByText(/Import extraction \(regex\)/i)).toBeInTheDocument();
      expect(screen.queryByText(/\bAST\b/)).not.toBeInTheDocument();
    });
  });

  it('renders repository analysis and allows task-focused file retrieval in authenticated workspace', async () => {
    vi.spyOn(client, 'fetchHealth').mockResolvedValue({
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: 50,
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchCurrentUser').mockResolvedValue({
      user: {
        id: 'usr-1',
        email: 'alice@autonomous.dev',
        displayName: 'Alice Architect',
        accountStatus: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      workspaces: [
        {
          id: 'ws-100',
          name: 'Core Platform Team',
          ownerId: 'usr-1',
          role: 'OWNER',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    vi.spyOn(client, 'fetchWorkspaceTasks').mockResolvedValue({
      tasks: [],
      total: 0,
    });

    vi.spyOn(client, 'fetchRepositories').mockResolvedValue({
      repositories: [
        {
          id: 'repo-abc',
          workspaceId: 'ws-100',
          name: 'autonomous-core',
          repositoryUrl: 'c:/Users/sharm/OneDrive/Desktop/miniprject',
          provider: 'LOCAL',
          defaultBranch: 'main',
          connectionStatus: 'CONNECTED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
    });

    vi.spyOn(client, 'fetchLatestAnalysis').mockResolvedValue({
      id: 'analysis-123',
      workspaceId: 'ws-100',
      repositoryId: 'repo-abc',
      status: 'COMPLETED',
      analyzerVersion: '1.0.0',
      summary: {
        repositoryOverview: 'Monorepo for autonomous engineering platform',
        entryPoints: ['services/api/src/server.ts'],
        keyModules: [
          { name: 'API', path: 'services/api', description: 'Backend API service', fileCount: 25 },
        ],
        apiRoutes: [
          { path: '/api/v1/tasks', handlerFile: 'services/api/src/routes/tasks.ts', framework: 'Express' },
        ],
        serviceLocations: ['services/api/src/services/intelligence/relevanceRanker.ts'],
        modelLocations: ['packages/contracts/src/intelligence.ts'],
        testFrameworks: ['Vitest'],
        testLocations: ['services/api/tests/intelligence/relevanceRanker.test.ts'],
        configurationLocations: ['tsconfig.json'],
        relationships: [
          {
            sourceFile: 'services/api/src/server.ts',
            targetFile: 'services/api/src/app.ts',
            relationshipType: 'IMPORTS',
          },
        ],
        limitations: [],
        confidence: 0.95,
      },
      technologies: [
        {
          name: 'TypeScript',
          category: 'LANGUAGE',
          confidence: 1.0,
          evidenceFiles: ['tsconfig.json'],
          rationale: 'TypeScript compiler configuration detected',
        },
      ],
      statistics: {
        totalFiles: 42,
        eligibleFiles: 42,
        skippedFiles: 0,
        totalBytes: 150000,
        durationMs: 120,
        binaryFilesSkipped: 0,
        secretFilesExcluded: 0,
      },
      errorSummary: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    vi.spyOn(client, 'fetchRelevantFiles').mockResolvedValue({
      workspaceId: 'ws-100',
      repositoryId: 'repo-abc',
      query: 'Fix relevance ranker scoring bug',
      totalAnalyzed: 42,
      results: [
        {
          path: 'services/api/src/services/intelligence/relevanceRanker.ts',
          score: 85,
          category: 'SOURCE',
          reason: 'Filename exact match: relevanceRanker',
          evidence: ['services/api/tests/intelligence/relevanceRanker.test.ts'],
          suggestedAction: 'MODIFY',
        },
      ],
      limitations: [],
    });

    render(<App />);

    // Wait for user to be loaded
    await screen.findByText('Alice Architect');

    // Click Repo Intelligence navigation tab
    const intelligenceNavBtn = await screen.findByRole('button', { name: /Repo Intelligence/i });
    fireEvent.click(intelligenceNavBtn);

    // Verify Repository Intelligence is displayed with detected tech
    await waitFor(() => {
      expect(screen.getByText('Repository Intelligence Engine')).toBeInTheDocument();
      expect(screen.getByText('TypeScript')).toBeInTheDocument();
      expect(screen.getByText(/\/ 42 files/)).toBeInTheDocument();
      expect(screen.getByText('services/api/src/server.ts')).toBeInTheDocument();
    });

    // Test task-focused retrieval input
    const queryInput = screen.getByPlaceholderText(/Investigate memory leak in authMiddleware/i);
    fireEvent.change(queryInput, { target: { value: 'Fix relevance ranker scoring bug' } });

    const searchBtn = screen.getByRole('button', { name: /Rank Files/i });
    fireEvent.click(searchBtn);

    await waitFor(() => {
      expect(screen.getByText('services/api/src/services/intelligence/relevanceRanker.ts')).toBeInTheDocument();
      expect(screen.getByText('Score: 85')).toBeInTheDocument();
      expect(screen.getByText(/Recommendation: MODIFY/)).toBeInTheDocument();
    });
  });
});

