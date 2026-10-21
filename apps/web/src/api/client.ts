import type {
  HealthResponse,
  ReadinessResponse,
  TaskResponse,
  TaskListResponse,
  TaskSubmissionRequest,
} from '@autonomous-engineer/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed with status: ${res.status}`);
  }
  return res.json();
}

export async function fetchReadiness(): Promise<ReadinessResponse> {
  const res = await fetch(`${API_BASE_URL}/ready`);
  // Even if 503, the response JSON contains structured dependency status
  return res.json();
}

export async function fetchTasks(): Promise<TaskListResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/tasks`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tasks: ${res.status}`);
  }
  return res.json();
}

export async function submitTask(payload: TaskSubmissionRequest): Promise<TaskResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data?.error?.message || 'Failed to submit task';
    const errorDetails = data?.error?.details
      ? data.error.details.map((d: { field: string; message: string }) => `${d.field}: ${d.message}`).join(', ')
      : '';
    throw new Error(errorDetails ? `${errorMsg} (${errorDetails})` : errorMsg);
  }

  return data;
}
