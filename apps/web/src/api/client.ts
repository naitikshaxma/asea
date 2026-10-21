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
} from '@autonomous-engineer/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

let authToken: string | null = null;
try {
  authToken = sessionStorage.getItem('ae_auth_token');
} catch {
  // Ignore in SSR/testing environment
}

export function setAuthToken(token: string | null) {
  authToken = token;
  try {
    if (token) {
      sessionStorage.setItem('ae_auth_token', token);
    } else {
      sessionStorage.removeItem('ae_auth_token');
    }
  } catch {
    // Ignore in SSR/testing environment
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

function getHeaders(customHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return headers;
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

  const data = await handleResponse<AuthResponse>(res, 'Registration failed');
  if (data.token) {
    setAuthToken(data.token);
  }
  return data;
}

export async function loginUser(payload: LoginRequest): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await handleResponse<AuthResponse>(res, 'Login failed');
  if (data.token) {
    setAuthToken(data.token);
  }
  return data;
}

export async function logoutUser(): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
    });
  } finally {
    setAuthToken(null);
  }
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

// -----------------------------------------------------------------------------
// Backward-Compatibility Helpers
// -----------------------------------------------------------------------------

export async function fetchTasks(): Promise<TaskListResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/tasks`, {
    headers: getHeaders(),
    credentials: 'include',
  });
  return handleResponse<TaskListResponse>(res, 'Failed to fetch tasks');
}

export async function submitTask(payload: TaskSubmissionRequest): Promise<TaskResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/tasks`, {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  return handleResponse<TaskResponse>(res, 'Failed to submit task');
}
