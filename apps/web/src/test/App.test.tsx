import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { apiError, mockApi, renderApp, type ApiCall } from './mockApi';
import { auditEvents, finding, makeRun, makeRunDetail, makeStats, policy, refs, repo, signedIn, user, workspace, WS, NOW } from './fixtures';

afterEach(() => vi.restoreAllMocks());

describe('application workflows', () => {
  it('loads a persisted patch and records an authorized approval decision', async () => {
    const taskId = 'task-patch-1';
    const patchHash = 'd'.repeat(64);
    const task = {
      id: taskId, workspaceId: WS, creatorId: 'usr-2', title: 'Add safe validation',
      description: 'Reject an invalid request before writing data.', taskType: 'CODE_PATCH', priority: 'NORMAL',
      status: 'NEEDS_ATTENTION', createdAt: NOW, updatedAt: NOW,
      executionMetadata: { patchHash, patchStatus: 'PROPOSED', testStatus: 'NOT_RUN' }, runs: [],
    };
    const patchArtifact = {
      id: 'patch-1', taskId, workflowRunId: 'run-patch-1', snapshotHash: 'a'.repeat(64), patchHash,
      summary: 'Add request validation', plan: ['Check the input', 'Return a validation error'],
      evidence: ['src/handler.ts:1 accepts the request value without validation'],
      contextFiles: ['src/handler.ts'], changedFiles: ['src/handler.ts'],
      unifiedDiff: '--- a/src/handler.ts\n+++ b/src/handler.ts\n@@ -1 +1 @@\n-old\n+new',
      testStatus: 'NOT_RUN', testResults: { status: 'NOT_RUN', reason: 'No sandbox configured.' },
      securityStatus: 'UNAVAILABLE', securityResults: { status: 'UNAVAILABLE', reason: 'No sandbox configured.' },
      reviewStatus: 'UNAVAILABLE', reviewResults: { status: 'UNAVAILABLE', summary: 'Reviewer unavailable.', findings: [] },
      sandboxDiagnostics: { provider: 'unavailable', status: 'UNAVAILABLE', image: null, reasonCode: 'NOT_CONFIGURED', message: 'No isolated execution provider is configured.' },
      workspaceCleanupStatus: 'CLEANED',
      publicationStatus: 'NOT_PUBLISHED', publicationError: null, publishedBranch: null, githubCommitSha: null,
      pullRequestNumber: null, pullRequestUrl: null, publishedAt: null,
      ciStatus: 'NOT_CONFIGURED', ciChecks: [], ciDiagnosis: null, ciSyncedAt: null,
      status: 'PROPOSED', createdAt: NOW, updatedAt: NOW,
    };
    const approval = {
      id: 'approval-1', taskId, patchHash, status: 'PENDING', requestedById: 'usr-2', decidedById: null,
      reason: null, createdAt: NOW, updatedAt: NOW, patchIsCurrent: true,
      requester: { id: 'usr-2', displayName: 'Patch author', email: 'author@example.com' },
    };
    let decisionRecorded = false;
    const calls = mockApi(signedIn({
      [`GET /api/v1/workspaces/${WS}/tasks/${taskId}`]: task,
      [`GET /api/v1/workspaces/${WS}/tasks/${taskId}/patch`]: patchArtifact,
      [`GET /api/v1/workspaces/${WS}/approvals`]: () => ({ approvals: [decisionRecorded ? {
        ...approval, status: 'APPROVED', decidedById: user.id,
        decider: { id: user.id, displayName: user.displayName, email: user.email },
      } : approval], total: 1 }),
      [`POST /api/v1/workspaces/${WS}/approvals/${approval.id}/decision`]: () => {
        decisionRecorded = true;
        return {
        ...approval, status: 'APPROVED', decidedById: user.id,
        decider: { id: user.id, displayName: user.displayName, email: user.email },
        };
      },
    }));

    renderApp(`/tasks/${taskId}`);
    expect(await screen.findByText('Add request validation')).toBeInTheDocument();
    expect(screen.getByText(/Tests/)).toBeInTheDocument();
    expect(await screen.findByText('Not run')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/decision'))).toBe(true));
    const decision = calls.find((call) => call.method === 'POST' && call.path.endsWith('/decision'));
    expect(decision?.body).toEqual({ decision: 'APPROVED' });
    expect(await screen.findByText('Decision by Dana Reviewer')).toBeInTheDocument();
  });

  it('shows the actual failed GitHub check annotation and affected source file', async () => {
    const taskId = 'task-ci-1';
    const patchHash = 'f'.repeat(64);
    const checkUrl = 'https://github.com/acme/app/actions/runs/12';
    const task = {
      id: taskId, workspaceId: WS, creatorId: 'usr-2', title: 'Fix the typecheck failure',
      description: 'Fix the source reported by CI.', taskType: 'CODE_PATCH', priority: 'NORMAL',
      status: 'NEEDS_ATTENTION', createdAt: NOW, updatedAt: NOW,
      executionMetadata: { patchHash, patchStatus: 'APPROVED' }, runs: [],
    };
    const patchArtifact = {
      id: 'patch-ci-1', taskId, workflowRunId: 'run-ci-1', snapshotHash: 'a'.repeat(64), patchHash,
      summary: 'Repair a type error', plan: ['Correct the return type'], contextFiles: ['src/api.ts'], changedFiles: ['src/api.ts'],
      unifiedDiff: '', evidence: ['src/api.ts:18 has the incorrect return type'],
      testStatus: 'PASSED', testResults: { status: 'PASSED' }, securityStatus: 'PASSED', securityResults: { status: 'PASSED' },
      reviewStatus: 'PASSED', reviewResults: { status: 'PASSED', summary: 'Reviewed.' },
      sandboxDiagnostics: { provider: 'docker', status: 'READY', image: 'asea/sandbox:test', reasonCode: null, message: 'ready' }, workspaceCleanupStatus: 'CLEANED',
      publicationStatus: 'PR_OPEN', publicationError: null, publishedBranch: 'asea/task-ci-1', githubCommitSha: 'a'.repeat(40),
      pullRequestNumber: 12, pullRequestUrl: 'https://github.com/acme/app/pull/12', publishedAt: NOW,
      ciStatus: 'FAILURE', ciSyncedAt: NOW,
      ciChecks: [{ name: 'typecheck', status: 'completed', conclusion: 'failure', detailsUrl: checkUrl }],
      ciDiagnosis: {
        status: 'FILES_IDENTIFIED', summary: '1 failed check(s) reported annotations for 1 repository file(s).',
        affectedFiles: ['src/api.ts'], failedChecks: [{
          name: 'typecheck', conclusion: 'failure', detailsUrl: checkUrl, summary: 'TypeScript reported a compile error.',
          annotations: [{ path: 'src/api.ts', startLine: 18, endLine: 18, level: 'failure', title: 'Type error', message: 'Invalid type' }],
        }],
      },
      status: 'APPROVED', createdAt: NOW, updatedAt: NOW,
    };
    mockApi(signedIn({
      [`GET /api/v1/workspaces/${WS}/tasks/${taskId}`]: task,
      [`GET /api/v1/workspaces/${WS}/tasks/${taskId}/patch`]: patchArtifact,
      [`GET /api/v1/workspaces/${WS}/approvals`]: { approvals: [], total: 0 },
    }));

    renderApp(`/tasks/${taskId}`);
    expect(await screen.findByRole('heading', { name: 'CI failure diagnosis' })).toBeInTheDocument();
    expect(screen.getByText('src/api.ts:18')).toBeInTheDocument();
    expect(screen.getByText(/Automatic repair is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pull request #12' })).toHaveAttribute('href', patchArtifact.pullRequestUrl);
  });

  it('registers an account, restores the new session, and loads the dashboard', async () => {
    let sessionReads = 0;
    const calls = mockApi({
      'GET /api/v1/auth/me': () => {
        sessionReads += 1;
        return sessionReads === 1 ? apiError(401, 'UNAUTHORIZED', 'Authentication is required') : { user, workspaces: [workspace] };
      },
      'POST /api/v1/auth/register': { user },
      'GET /ready': { status: 'ready', service: 'api', timestamp: NOW, dependencies: {} },
      [`GET /api/v1/workspaces/${WS}/stats`]: makeStats(),
    });

    renderApp('/register');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Dana Reviewer' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const registerCall = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/auth/register');
    expect(registerCall?.body).toEqual({ email: user.email, password: 'correct-horse-22', displayName: 'Dana Reviewer' });
    expect(sessionReads).toBe(2);
  });

  it('shows an authentication error and then signs in successfully', async () => {
    let loginAttempts = 0;
    let sessionReads = 0;
    const routes = {
      'GET /api/v1/auth/me': () => {
        sessionReads += 1;
        return sessionReads === 1 ? apiError(401, 'UNAUTHORIZED', 'Authentication is required') : { user, workspaces: [workspace] };
      },
      'GET /ready': { status: 'ready', service: 'api', timestamp: NOW, dependencies: {} },
      'POST /api/v1/auth/login': () => {
        loginAttempts += 1;
        return loginAttempts === 1 ? apiError(401, 'UNAUTHORIZED', 'Invalid email or password') : { user };
      },
      [`GET /api/v1/workspaces/${WS}/stats`]: makeStats(),
    };
    mockApi(routes);

    renderApp('/login');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('lets a workspace owner invite a member and change an existing role', async () => {
    const member = { id: 'mem-2', userId: 'usr-2', email: 'member@example.com', displayName: 'Workspace Member', role: 'MEMBER', createdAt: NOW };
    const invitation = { id: 'inv-1', workspaceId: WS, email: 'invite@example.com', role: 'MEMBER', expiresAt: NOW, acceptedAt: null, revokedAt: null, createdAt: NOW };
    const calls = mockApi(signedIn({
      [`GET /api/v1/workspaces/${WS}/members`]: { members: [member] },
      [`GET /api/v1/workspaces/${WS}/invitations`]: { invitations: [invitation] },
      [`GET /api/v1/workspaces/${WS}/github-app`]: { configured: false, appSlug: null, installations: [] },
      [`POST /api/v1/workspaces/${WS}/invitations`]: { invitation: { ...invitation, email: 'new@example.com' } },
      [`PATCH /api/v1/workspaces/${WS}/members/${member.id}`]: { id: member.id, userId: member.userId, role: 'ADMIN' },
    }));
    renderApp('/settings');
    expect(await screen.findByText('member@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Role for member@example.com'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith(`/members/${member.id}`))).toBe(true));
    fireEvent.change(screen.getByLabelText('Invite by email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/invitations'))).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.path.endsWith('/invitations'))?.body).toEqual({ email: 'new@example.com', role: 'MEMBER' });
  });

  it('requests a password reset without exposing whether the email exists', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': apiError(401, 'UNAUTHORIZED', 'Authentication is required'),
      'POST /api/v1/auth/password-reset/request': { success: true, message: 'If the account can receive a reset link, one has been sent.' },
    });
    renderApp('/forgot-password');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'person@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If the account can receive');
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ email: 'person@example.com' });
  });

  it('redeems an invitation after sign-in and clears the one-time token', async () => {
    window.history.replaceState({}, '', '/accept-invitation#token=invite-secret-fixture-12345678901234567890&workspaceId=ws-join');
    const calls = mockApi(signedIn({
      'POST /api/v1/workspaces/ws-join/invitations/accept': { success: true, workspaceId: 'ws-join', role: 'MEMBER' },
    }));
    renderApp('/accept-invitation');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/invitations/accept'))).toBe(true));
    const accept = calls.find((call) => call.method === 'POST' && call.path.endsWith('/invitations/accept'));
    expect(accept?.body).toMatchObject({ token: 'invite-secret-fixture-12345678901234567890' });
    expect(sessionStorage.getItem('asea-workspace-invite-token')).toBeNull();
  });

  it('submits a repository verification and displays its persisted findings', async () => {
    const taskId = 'task-created-1';
    const verification = makeRun({ id: 'run-created-1', taskId, title: 'Add GET /projects/export' });
    const detail = makeRunDetail({ id: verification.id, taskId, title: verification.title });
    const calls = mockApi(
      signedIn({
        [`GET /api/v1/workspaces/${WS}/repositories`]: { repositories: [repo], total: 1 },
        [`GET /api/v1/workspaces/${WS}/policies`]: { policies: [policy], total: 1 },
        [`GET /api/v1/workspaces/${WS}/repositories/${repo.id}/refs`]: refs,
        [`POST /api/v1/workspaces/${WS}/tasks`]: {
          id: taskId,
          workspaceId: WS,
          title: verification.title,
          description: verification.requirement,
          taskType: 'VERIFICATION',
          priority: 'NORMAL',
          status: 'QUEUED',
          createdAt: NOW,
          updatedAt: NOW,
        },
        [`GET /api/v1/workspaces/${WS}/verification-runs`]: (call: ApiCall) =>
          call.query.get('taskId') === taskId ? { verificationRuns: [verification], nextCursor: null } : { verificationRuns: [], nextCursor: null },
        [`GET /api/v1/workspaces/${WS}/verification-runs/${verification.id}`]: detail,
        [`GET /api/v1/workspaces/${WS}/verification-runs/${verification.id}/findings`]: {
          verificationRunId: verification.id,
          findings: [finding],
          total: 1,
        },
        [`GET /api/v1/workspaces/${WS}/verification-runs/${verification.id}/audit/events`]: auditEvents,
      })
    );

    renderApp('/runs/new');
    fireEvent.change(await screen.findByLabelText('Requirement'), {
      target: { value: 'Only authenticated users may export their projects as JSON.' },
    });
    const startButton = screen.getByRole('button', { name: 'Start verification' });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    expect(await screen.findByRole('heading', { name: 'Add GET /projects/export' })).toBeInTheDocument();
    expect(await screen.findAllByText(finding.title)).not.toHaveLength(0);
    const submission = calls.find((call) => call.method === 'POST' && call.path === `/api/v1/workspaces/${WS}/tasks`);
    expect(submission?.body).toMatchObject({
      taskType: 'VERIFICATION',
      repositoryId: repo.id,
      verification: { baseSha: refs.branches[1]!.sha, headSha: refs.branches[0]!.sha, authorType: 'AI' },
      description: 'Only authenticated users may export their projects as JSON.',
    });
    await waitFor(() => expect(calls.some((call) => call.path.endsWith(`/${verification.id}/findings`))).toBe(true));
  });
});
