import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as client from './api/client';

describe('Web Application Dashboard Shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    vi.spyOn(client, 'fetchTasks').mockResolvedValue({
      tasks: [],
      total: 0,
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

    vi.spyOn(client, 'fetchTasks').mockResolvedValue({
      tasks: [],
      total: 0,
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

    vi.spyOn(client, 'fetchTasks').mockResolvedValue({
      tasks: [],
      total: 0,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('No tasks registered in this session')).toBeInTheDocument();
    });
  });

  it('displays error state when task fetch fails', async () => {
    vi.spyOn(client, 'fetchHealth').mockRejectedValue(new Error('Network error'));
    vi.spyOn(client, 'fetchTasks').mockRejectedValue(new Error('API Connection Refused'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('API Offline')).toBeInTheDocument();
      expect(screen.getByText('API Connection Refused')).toBeInTheDocument();
    });
  });
});
