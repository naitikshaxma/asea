import type {
  AnalysisFileListResponse,
  AuditChainVerificationResponse,
  AuditEventListResponse,
  AuthResponse,
  ConnectGithubResponse,
  CreatePolicyProfileRequest,
  CreateRepositoryRequest,
  HealthResponse,
  LoginRequest,
  PolicyProfileListResponse,
  PolicyProfileResponse,
  ReadinessResponse,
  RegisterRequest,
  RepositoryAnalysisResponse,
  RepositoryListResponse,
  RepositoryRefsResponse,
  RepositoryResponse,
  SystemStatusResponse,
  TaskRelevantFilesResponse,
  TaskResponse,
  TaskSubmissionRequest,
  UpdatePolicyProfileRequest,
  UserProfile,
  VerificationFindingListResponse,
  VerificationRunDetailResponse,
  VerificationRunListResponse,
  WorkspaceResponse,
  WorkspaceStatsResponse,
  WorkspaceMember,
  WorkspaceInvitationResponse,
} from '@autonomous-engineer/contracts';

// Authentication is the HttpOnly session cookie set by the API (sent with
// credentials: 'include'); JavaScript never sees the token.
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Array<{ field: string; message: string }> = []
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TaskPatchResponse {
  id: string;
  taskId: string;
  workflowRunId: string;
  snapshotHash: string;
  patchHash: string;
  summary: string;
  plan: string[];
  evidence: string[];
  contextFiles: string[];
  changedFiles: string[];
  unifiedDiff: string;
  testStatus: string;
  testResults: unknown;
  securityStatus: string;
  securityResults: unknown;
  reviewStatus: string;
  reviewResults: unknown;
  sandboxDiagnostics: { provider: string; status: string; image: string | null; reasonCode: string | null; message: string } | null;
  workspaceCleanupStatus: string;
  publicationStatus: 'NOT_PUBLISHED' | 'PUBLISHING' | 'PR_OPEN' | 'FAILED';
  publicationError: string | null;
  publishedBranch: string | null;
  githubCommitSha: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  publishedAt: string | null;
  ciStatus: 'NOT_CONFIGURED' | 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ERROR';
  ciChecks: Array<{
    name: string; status: string; conclusion: string | null; detailsUrl: string | null;
    failureSummary?: string | null;
    annotations?: Array<{ path: string | null; startLine: number | null; endLine: number | null; level: string; title: string | null; message: string }>;
  }> | null;
  ciDiagnosis: {
    status: 'PENDING' | 'NO_FAILURES' | 'FILES_IDENTIFIED' | 'NO_FILE_REFERENCES' | 'DETAILS_UNAVAILABLE';
    summary: string;
    affectedFiles: string[];
    failedChecks: Array<{
      name: string; conclusion: string; detailsUrl: string | null; summary: string | null;
      annotations: Array<{ path: string | null; startLine: number | null; endLine: number | null; level: string; title: string | null; message: string }>;
    }>;
  } | null;
  ciSyncedAt: string | null;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'INVALIDATED';
  createdAt: string;
  updatedAt: string;
}

export interface GithubAppInstallation {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  createdAt: string;
}

export interface GithubAppSelectableInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  patchHash: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedById: string;
  decidedById: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  patchIsCurrent?: boolean;
  task?: Pick<TaskResponse, 'id' | 'title' | 'description' | 'taskType' | 'status' | 'creatorId' | 'executionMetadata'>;
  requester?: { id: string; displayName: string; email: string };
  decider?: { id: string; displayName: string; email: string } | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the ASEA API. Check that the server is running.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = data?.error;
    throw new ApiError(res.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `Request failed (${res.status})`, error?.details ?? []);
  }
  return data as T;
}

const ws = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const api = {
  // Health
  health: () => request<HealthResponse>('GET', '/health'),
  ready: () => request<ReadinessResponse>('GET', '/ready'),
  systemStatus: () => request<SystemStatusResponse>('GET', '/api/v1/system/status'),

  // Auth
  register: (body: RegisterRequest) => request<AuthResponse>('POST', '/api/v1/auth/register', body),
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/api/v1/auth/login', body),
  logout: () => request<{ success: boolean }>('POST', '/api/v1/auth/logout'),
  me: () => request<{ user: UserProfile; workspaces: WorkspaceResponse[] }>('GET', '/api/v1/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean; message: string }>('POST', '/api/v1/auth/password/change', { currentPassword, newPassword }),
  requestPasswordReset: (email: string) =>
    request<{ success: boolean; message: string }>('POST', '/api/v1/auth/password-reset/request', { email }),
  completePasswordReset: (token: string, newPassword: string) =>
    request<{ success: boolean; message: string }>('POST', '/api/v1/auth/password-reset/complete', { token, newPassword }),

  // Workspaces
  createWorkspace: (name: string) => request<WorkspaceResponse>('POST', '/api/v1/workspaces', { name }),
  renameWorkspace: (workspaceId: string, name: string) => request<WorkspaceResponse>('PATCH', ws(workspaceId), { name }),
  workspaceMembers: (workspaceId: string) => request<{ members: WorkspaceMember[] }>('GET', `${ws(workspaceId)}/members`),
  workspaceInvitations: (workspaceId: string) => request<{ invitations: WorkspaceInvitationResponse[] }>('GET', `${ws(workspaceId)}/invitations`),
  inviteWorkspaceMember: (workspaceId: string, email: string, role: 'ADMIN' | 'MEMBER') =>
    request<{ invitation: WorkspaceInvitationResponse }>('POST', `${ws(workspaceId)}/invitations`, { email, role }),
  revokeWorkspaceInvitation: (workspaceId: string, invitationId: string) =>
    request<void>('DELETE', `${ws(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`),
  acceptWorkspaceInvitation: (workspaceId: string, token: string) =>
    request<{ success: boolean; workspaceId: string; role: string }>('POST', `${ws(workspaceId)}/invitations/accept`, { token }),
  updateWorkspaceMemberRole: (workspaceId: string, membershipId: string, role: 'ADMIN' | 'MEMBER') =>
    request<{ id: string; userId: string; role: string }>('PATCH', `${ws(workspaceId)}/members/${encodeURIComponent(membershipId)}`, { role }),
  removeWorkspaceMember: (workspaceId: string, membershipId: string) =>
    request<void>('DELETE', `${ws(workspaceId)}/members/${encodeURIComponent(membershipId)}`),
  stats: (workspaceId: string) => request<WorkspaceStatsResponse>('GET', `${ws(workspaceId)}/stats`),

  // Repositories
  repositories: (workspaceId: string) => request<RepositoryListResponse>('GET', `${ws(workspaceId)}/repositories`),
  createRepository: (workspaceId: string, body: CreateRepositoryRequest) =>
    request<RepositoryResponse>('POST', `${ws(workspaceId)}/repositories`, body),
  refs: (workspaceId: string, repositoryId: string) =>
    request<RepositoryRefsResponse>('GET', `${ws(workspaceId)}/repositories/${repositoryId}/refs`),
  connectGithub: (workspaceId: string, repositoryId: string, fullName: string) =>
    request<ConnectGithubResponse>('PUT', `${ws(workspaceId)}/repositories/${repositoryId}/github`, { fullName }),
  disconnectGithub: (workspaceId: string, repositoryId: string) =>
    request<RepositoryResponse>('DELETE', `${ws(workspaceId)}/repositories/${repositoryId}/github`),
  githubApp: (workspaceId: string) => request<{ configured: boolean; appSlug: string | null; installations: GithubAppInstallation[] }>('GET', `${ws(workspaceId)}/github-app`),
  githubAppInstallUrl: (workspaceId: string) => request<{ url: string; expiresInSeconds: number }>('GET', `${ws(workspaceId)}/github-app/install-url`),
  completeGithubAppInstallation: (workspaceId: string, installationId: string | undefined, state: string, code: string) =>
    request<{ installation: GithubAppInstallation; selectionRequired?: false } | { selectionRequired: true; selectionToken: string; installations: GithubAppSelectableInstallation[] }>(
      'POST', `${ws(workspaceId)}/github-app/installations/complete`, { ...(installationId ? { installationId } : {}), state, code }),
  selectGithubAppInstallation: (workspaceId: string, selectionToken: string, installationId: string) =>
    request<{ installation: GithubAppInstallation }>('POST', `${ws(workspaceId)}/github-app/installations/select`, { selectionToken, installationId }),
  githubAppRepositories: (workspaceId: string, installationRecordId: string) =>
    request<{ repositories: Array<{ id: number; fullName: string; private: boolean; defaultBranch: string }> }>('GET', `${ws(workspaceId)}/github-app/installations/${installationRecordId}/repositories`),
  connectGithubAppRepository: (workspaceId: string, repositoryId: string, installationRecordId: string, fullName: string) =>
    request<{ repositoryId: string; githubFullName: string; installationRecordId: string; defaultBranch: string }>('PUT', `${ws(workspaceId)}/repositories/${repositoryId}/github-app`, { installationRecordId, fullName }),
  disconnectGithubAppRepository: (workspaceId: string, repositoryId: string) =>
    request<void>('DELETE', `${ws(workspaceId)}/repositories/${repositoryId}/github-app`),
  analyze: (workspaceId: string, repositoryId: string) =>
    request<RepositoryAnalysisResponse>('POST', `${ws(workspaceId)}/repositories/${repositoryId}/analyze`),
  latestAnalysis: (workspaceId: string, repositoryId: string) =>
    request<RepositoryAnalysisResponse>('GET', `${ws(workspaceId)}/repositories/${repositoryId}/analysis/latest`),
  analysisFiles: (workspaceId: string, repositoryId: string, analysisId: string, page = 1) =>
    request<AnalysisFileListResponse>(
      'GET',
      `${ws(workspaceId)}/repositories/${repositoryId}/analysis/${analysisId}/files${query({ page, pageSize: 25 })}`
    ),
  relevantFiles: (workspaceId: string, repositoryId: string, taskDescription: string) =>
    request<TaskRelevantFilesResponse>('POST', `${ws(workspaceId)}/repositories/${repositoryId}/relevant-files`, {
      taskDescription,
      limit: 10,
    }),

  // Verifications
  submitTask: (workspaceId: string, body: TaskSubmissionRequest) => request<TaskResponse>('POST', `${ws(workspaceId)}/tasks`, body),
  tasks: (workspaceId: string) => request<{ tasks: TaskResponse[]; total: number }>('GET', `${ws(workspaceId)}/tasks`),
  task: (workspaceId: string, taskId: string) => request<TaskResponse>('GET', `${ws(workspaceId)}/tasks/${taskId}`),
  taskPatch: (workspaceId: string, taskId: string) => request<TaskPatchResponse>('GET', `${ws(workspaceId)}/tasks/${taskId}/patch`),
  publishTaskPatch: (workspaceId: string, taskId: string) =>
    request<{ publicationStatus: TaskPatchResponse['publicationStatus']; branch: string | null; commitSha: string | null; pullRequestNumber: number | null; pullRequestUrl: string | null; ciStatus: TaskPatchResponse['ciStatus'] }>('POST', `${ws(workspaceId)}/tasks/${taskId}/publish`, {}),
  syncTaskCi: (workspaceId: string, taskId: string) =>
    request<{ ciStatus: TaskPatchResponse['ciStatus']; checks: TaskPatchResponse['ciChecks']; diagnosis: TaskPatchResponse['ciDiagnosis']; syncedAt: string | null }>('POST', `${ws(workspaceId)}/tasks/${taskId}/ci/sync`, {}),
  approvals: (workspaceId: string, status?: ApprovalRecord['status']) =>
    request<{ approvals: ApprovalRecord[]; total: number }>('GET', `${ws(workspaceId)}/approvals${query({ status })}`),
  decideApproval: (workspaceId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) =>
    request<ApprovalRecord>('POST', `${ws(workspaceId)}/approvals/${approvalId}/decision`, { decision, ...(reason ? { reason } : {}) }),
  cancelTask: (workspaceId: string, taskId: string) =>
    request<{ status: string; message: string }>('POST', `${ws(workspaceId)}/tasks/${taskId}/cancel`),
  runs: (
    workspaceId: string,
    params: { status?: string; verdict?: string; repositoryId?: string; taskId?: string; cursor?: string; limit?: number } = {}
  ) => request<VerificationRunListResponse>('GET', `${ws(workspaceId)}/verification-runs${query(params)}`),
  run: (workspaceId: string, runId: string) =>
    request<VerificationRunDetailResponse>('GET', `${ws(workspaceId)}/verification-runs/${runId}`),
  findings: (workspaceId: string, runId: string) =>
    request<VerificationFindingListResponse>('GET', `${ws(workspaceId)}/verification-runs/${runId}/findings`),
  auditEvents: (workspaceId: string, runId: string) =>
    request<AuditEventListResponse>('GET', `${ws(workspaceId)}/verification-runs/${runId}/audit/events`),
  verifyAudit: (workspaceId: string, runId: string) =>
    request<AuditChainVerificationResponse>('GET', `${ws(workspaceId)}/verification-runs/${runId}/audit/verify`),

  // Policies
  policies: (workspaceId: string) => request<PolicyProfileListResponse>('GET', `${ws(workspaceId)}/policies`),
  createPolicy: (workspaceId: string, body: CreatePolicyProfileRequest) =>
    request<PolicyProfileResponse>('POST', `${ws(workspaceId)}/policies`, body),
  updatePolicy: (workspaceId: string, policyId: string, body: UpdatePolicyProfileRequest) =>
    request<PolicyProfileResponse>('PATCH', `${ws(workspaceId)}/policies/${policyId}`, body),
  deletePolicy: (workspaceId: string, policyId: string) => request<void>('DELETE', `${ws(workspaceId)}/policies/${policyId}`),
};

/** A readable message for any error thrown by the client. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.details.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join('; ');
    return details ? `${err.message} (${details})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
