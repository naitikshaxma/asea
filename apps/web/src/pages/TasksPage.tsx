import { Link } from 'react-router-dom';
import { Code2, Plus } from 'lucide-react';
import { api } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { isActive, titleCase } from '../format';
import { Button, Card, Badge } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';

function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'COMPLETED' || status === 'APPROVED') return 'ok';
  if (status === 'NEEDS_ATTENTION' || status === 'RUNNING' || status === 'QUEUED') return 'warn';
  if (status === 'FAILED' || status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function TasksPage() {
  const workspaceId = useWorkspaceId();
  const query = useQuery(`tasks:${workspaceId}`, () => api.tasks(workspaceId), {
    pollMs: (data) => data?.tasks.some((task) => isActive(task.status)) ? 2500 : null,
  });

  return (
    <>
      <PageHeader
        title="Engineering tasks"
        description="Create a code change proposal, follow its workflow, and review the exact patch before publication."
        actions={<Link to="/tasks/new"><Button variant="primary" icon={<Plus className="h-4 w-4" />}>New task</Button></Link>}
      />
      <Card>
        {query.error && !query.data ? <ErrorState error={query.error} onRetry={() => void query.refetch()} title="Could not load tasks" /> :
          !query.data ? <SkeletonRows rows={6} /> : query.data.tasks.length === 0 ? (
            <EmptyState icon={<Code2 className="h-5 w-5" />} title="No engineering tasks yet"
              description="Start a provider backed code patch proposal from a registered local repository."
              action={<Link to="/tasks/new"><Button variant="primary">Create a task</Button></Link>} />
          ) : (
            <div className="divide-y divide-border">
              {query.data.tasks.map((task) => (
                <Link key={task.id} to={`/tasks/${task.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{task.title}</p>
                    <p className="mt-0.5 text-xs text-muted">{titleCase(task.taskType)} · {new Date(task.createdAt).toLocaleString()}</p>
                  </div>
                  <Badge tone={statusTone(task.status)}>{titleCase(task.status)}</Badge>
                </Link>
              ))}
            </div>
          )}
      </Card>
    </>
  );
}
