import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { titleCase } from '../format';
import { Badge, Card } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';

export function ApprovalsPage() {
  const workspaceId = useWorkspaceId();
  const query = useQuery(`approvals:${workspaceId}`, () => api.approvals(workspaceId, 'PENDING'));
  return <>
    <PageHeader title="Patch approvals" description="Pending decisions for exact, hash-bound patch proposals in this workspace." />
    <Card>
      {query.error && !query.data ? <ErrorState error={query.error} onRetry={() => void query.refetch()} title="Could not load approvals" /> :
        !query.data ? <SkeletonRows rows={4} /> : query.data.approvals.length === 0 ? <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No pending approvals" description="A review request appears here when a patch proposal is ready." /> : (
          <div className="divide-y divide-border">
            {query.data.approvals.map((approval) => <Link key={approval.id} to={`/tasks/${approval.taskId}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-fg">{approval.task?.title ?? `Task ${approval.taskId}`}</p><p className="mt-0.5 text-xs text-muted">Requested by {approval.requester?.displayName ?? 'workspace member'} · {new Date(approval.createdAt).toLocaleString()}</p></div>
              <Badge tone={approval.patchIsCurrent ? 'warn' : 'danger'}>{approval.patchIsCurrent ? titleCase(approval.status) : 'Stale patch'}</Badge>
            </Link>)}
          </div>
        )}
    </Card>
  </>;
}
