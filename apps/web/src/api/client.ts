import type {
  HealthResponse,
  ReadinessResponse,
  TaskResponse,
  TaskListResponse,
  TaskSubmissionRequest,
  UserProfile,
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  WorkspaceResponse,
  WorkspaceListResponse,
  RepositoryResponse,
  RepositoryListResponse,
  CreateRepositoryRequest,
  CancelTaskResponse,
  WorkflowRunResponse,
  RepositoryAnalysisResponse,
  AnalysisFileListResponse,
  TaskRelevantFilesRequest,
  TaskRelevantFilesResponse,
} from '@autonomous-engineer/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Authentication relies solely on the HttpOnly session cookie set by the API
// (sent via `credentials: 'include'`); the token is never readable from JS.
function getHeaders(customHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
}

async function handleResponse<T>(res: Response, fallbackError: string): Promise<T> {
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${fallbackError} (${res.status} ${res.statusText})`);
  }

  if (!res.ok) {
    const errorMsg = data?.error?.message || fallbackError;
    const errorDetails = data?.error?.details
      ? data.error.details.map((d: { field: string; message: string }) => `${d.field}: ${d.message}`).join(', ')
      : '';
    throw new Error(errorDetails ? `${errorMsg} (${errorDetails})` : errorMsg);
  }

  return data as T;
}

// -----------------------------------------------------------------------------
// Health Probes
// -----------------------------------------------------------------------------

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed with status: ${res.status}`);
  }
  return res.json();
}

export async function fetchReadiness(): Promise<ReadinessResponse> {
  const res = await fetch(`${API_BASE_URL}/ready`);
  return res.json();
}

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------

export async function registerUser(payload: RegisterRequest): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  return handleResponse<AuthResponse>(res, 'Registration failed');
}

export async function loginUser(payload: LoginRequest): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  return handleResponse<AuthResponse>(res, 'Login failed');
}

export async function logoutUser(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
  });
}

export async function fetchCurrentUser(): Promise<{ user: UserProfile; workspaces: WorkspaceResponse[] }> {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/me`, {
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<{ user: UserProfile; workspaces: WorkspaceResponse[] }>(
    res,
    'Failed to fetch user session'
  );
}

// -----------------------------------------------------------------------------
// Workspaces
// -----------------------------------------------------------------------------

export async function fetchWorkspaces(): Promise<WorkspaceListResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces`, {
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<WorkspaceListResponse>(res, 'Failed to fetch workspaces');
}

export async function createWorkspace(name: string): Promise<WorkspaceResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify({ name }),
  });

  return handleResponse<WorkspaceResponse>(res, 'Failed to create workspace');
}

// -----------------------------------------------------------------------------
// Repositories
// -----------------------------------------------------------------------------

export async function fetchRepositories(workspaceId: string): Promise<RepositoryListResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories`, {
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<RepositoryListResponse>(res, 'Failed to fetch repositories');
}

export async function createRepository(
  workspaceId: string,
  payload: CreateRepositoryRequest
): Promise<RepositoryResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  return handleResponse<RepositoryResponse>(res, 'Failed to add repository record');
}

// -----------------------------------------------------------------------------
// Repository Intelligence Engine (Phase 3)
// -----------------------------------------------------------------------------

export async function triggerRepositoryAnalysis(
  workspaceId: string,
  repositoryId: string
): Promise<RepositoryAnalysisResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories/${repositoryId}/analyze`,
    {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
    }
  );

  return handleResponse<RepositoryAnalysisResponse>(res, 'Failed to trigger repository analysis');
}

export async function fetchLatestAnalysis(
  workspaceId: string,
  repositoryId: string
): Promise<RepositoryAnalysisResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories/${repositoryId}/analysis/latest`,
    {
      headers: getHeaders(),
      credentials: 'include',
    }
  );

  return handleResponse<RepositoryAnalysisResponse>(res, 'Failed to fetch latest analysis');
}

export async function fetchAnalysisFiles(
  workspaceId: string,
  repositoryId: string,
  analysisId: string,
  options?: { page?: number; pageSize?: number; category?: string }
): Promise<AnalysisFileListResponse> {
  const params = new URLSearchParams();
  if (options?.page) params.set('page', String(options.page));
  if (options?.pageSize) params.set('pageSize', String(options.pageSize));
  if (options?.category) params.set('category', options.category);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(
    `${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories/${repositoryId}/analysis/${analysisId}/files${query}`,
    {
      headers: getHeaders(),
      credentials: 'include',
    }
  );

  return handleResponse<AnalysisFileListResponse>(res, 'Failed to fetch analysis file inventory');
}

export async function fetchRelevantFiles(
  workspaceId: string,
  repositoryId: string,
  payload: TaskRelevantFilesRequest
): Promise<TaskRelevantFilesResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/workspaces/${workspaceId}/repositories/${repositoryId}/relevant-files`,
    {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(payload),
    }
  );

  return handleResponse<TaskRelevantFilesResponse>(res, 'Failed to rank relevant files');
}

// -----------------------------------------------------------------------------
// Workspace Tasks
// -----------------------------------------------------------------------------

export async function fetchWorkspaceTasks(
  workspaceId: string,
  filters?: { status?: string; taskType?: string }
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.taskType) params.set('taskType', filters.taskType);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/tasks${query}`, {
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<TaskListResponse>(res, 'Failed to fetch workspace tasks');
}

export async function submitWorkspaceTask(
  workspaceId: string,
  payload: TaskSubmissionRequest
): Promise<TaskResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/tasks`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  return handleResponse<TaskResponse>(res, 'Failed to submit task to workspace');
}

export async function cancelWorkspaceTask(
  workspaceId: string,
  taskId: string
): Promise<CancelTaskResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<CancelTaskResponse>(res, 'Failed to cancel task');
}

export async function fetchTaskRuns(
  workspaceId: string,
  taskId: string
): Promise<{ runs: WorkflowRunResponse[]; total: number }> {
  const res = await fetch(`${API_BASE_URL}/api/v1/workspaces/${workspaceId}/tasks/${taskId}/runs`, {
    headers: getHeaders(),
    credentials: 'include',
  });

  return handleResponse<{ runs: WorkflowRunResponse[]; total: number }>(
    res,
    'Failed to fetch workflow runs'
  );
}
