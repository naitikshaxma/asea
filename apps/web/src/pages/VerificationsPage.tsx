import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ListChecks, Plus } from 'lucide-react';
import type { VerificationRunResponse } from '@autonomous-engineer/contracts';
import { api, errorMessage } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { VERDICT_LABEL, isActive, titleCase } from '../format';
import { Button, Card, Select } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';
import { RunsTable } from './RunsTable';

const STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];

export function VerificationsPage() {
  const workspaceId = useWorkspaceId();
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState('');
  const [params] = useSearchParams();
  const [repositoryId, setRepositoryId] = useState(params.get('repository') ?? '');
  const [more, setMore] = useState<VerificationRunResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const filters = { status: status || undefined, verdict: verdict || undefined, repositoryId: repositoryId || undefined };

  const repos = useQuery(`repos:${workspaceId}`, () => api.repositories(workspaceId));
  // The first page refreshes every few seconds while any run on it is still going
  const first = useQuery(`runs:${workspaceId}:${status}:${verdict}:${repositoryId}`, () => api.runs(workspaceId, filters), {
    pollMs: (data) => (data?.verificationRuns.some((r) => isActive(r.status)) ? 2500 : null),
  });

  useEffect(() => {
    setMore([]);
    setCursor(null);
    setMoreError(null);
  }, [status, verdict, repositoryId]);
  const nextCursor = more.length ? cursor : first.data?.nextCursor ?? null;
  const runs = [...(first.data?.verificationRuns ?? []), ...more.filter((m) => !first.data?.verificationRuns.some((r) => r.id === m.id))];
  const filtered = Boolean(status || verdict || repositoryId);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.runs(workspaceId, { ...filters, cursor: nextCursor });
      setMore((prev) => [...prev, ...page.verificationRuns]);
      setCursor(page.nextCursor);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Verifications"
        description="Every change verified in this workspace, newest first."
        actions={
          <Link to="/runs/new">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
              New verification
            </Button>
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[9rem]">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by verdict" value={verdict} onChange={(e) => setVerdict(e.target.value)} className="w-auto min-w-[9rem]">
          <option value="">All verdicts</option>
          {Object.entries(VERDICT_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by repository" value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)} className="w-auto min-w-[11rem]">
          <option value="">All repositories</option>
          {repos.data?.repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button variant="ghost" onClick={() => (setStatus(''), setVerdict(''), setRepositoryId(''))}>
            Clear filters
          </Button>
        )}
      </div>
      <Card>
        {first.error && !first.data ? (
          <ErrorState error={first.error} onRetry={() => void first.refetch()} title="Could not load verifications" />
        ) : !first.data ? (
          <SkeletonRows rows={6} />
        ) : runs.length === 0 ? (
          filtered ? (
            <EmptyState title="No verifications match these filters" action={<Button onClick={() => (setStatus(''), setVerdict(''), setRepositoryId(''))}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon={<ListChecks className="h-5 w-5" />}
              title="No verifications yet"
              description="Start one from a repository's branches, or connect a GitHub repository so pull requests are verified automatically."
              action={
                <Link to="/runs/new">
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
                    New verification
                  </Button>
                </Link>
              }
            />
          )
        ) : (
          <>
            <RunsTable runs={runs} />
            {(nextCursor || moreError) && (
              <div className="flex items-center justify-center gap-3 border-t border-border p-3">
                {moreError && <span className="text-xs text-danger">{moreError}</span>}
                {nextCursor && (
                  <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
