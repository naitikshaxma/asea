import { Link } from 'react-router-dom';
import { Activity, ArrowRight, FolderGit2, ListChecks, Plus } from 'lucide-react';
import type { WorkspaceStatsResponse } from '@autonomous-engineer/contracts';
import { api } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { SEVERITY_ORDER, VERDICT_LABEL, isActive } from '../format';
import { Button, Card, CardBody, CardHeader, Skeleton, cx } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';
import { SEVERITY_TONE, VERDICT_TONE } from '../ui/verdict';
import { RunsTable } from './RunsTable';

const BAR_TONE: Record<string, string> = { ok: 'bg-ok', warn: 'bg-warn', high: 'bg-high', danger: 'bg-danger', info: 'bg-info', neutral: 'bg-subtle' };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-fg">{value}</div>
      {hint && <div className="mt-1 text-xs text-subtle">{hint}</div>}
    </Card>
  );
}

function VerdictMix({ stats }: { stats: WorkspaceStatsResponse }) {
  const entries = Object.keys(VERDICT_LABEL).map((v) => [v, stats.byVerdict[v] ?? 0] as const);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  return (
    <Card>
      <CardHeader title="Verdicts" description="Completed verifications by verdict" />
      <CardBody className="space-y-4">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Verdict distribution">
          {total > 0 &&
            entries.map(([verdict, n]) =>
              n > 0 ? <div key={verdict} className={BAR_TONE[VERDICT_TONE[verdict] ?? 'neutral']} style={{ width: `${(n / total) * 100}%` }} /> : null
            )}
        </div>
        <dl className="grid grid-cols-2 gap-3">
          {entries.map(([verdict, n]) => (
            <div key={verdict} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <dt className="flex items-center gap-2 text-xs text-muted">
                <span className={cx('h-2 w-2 rounded-full', BAR_TONE[VERDICT_TONE[verdict] ?? 'neutral'])} />
                {VERDICT_LABEL[verdict]}
              </dt>
              <dd className="text-sm font-semibold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

function ActivityChart({ stats }: { stats: WorkspaceStatsResponse }) {
  const max = Math.max(1, ...stats.activity.map((d) => d.runs));
  return (
    <Card>
      <CardHeader title="Activity" description="Verifications started per day, last 14 days" />
      <CardBody>
        <div className="flex h-28 items-end gap-1.5" role="img" aria-label="Verifications per day">
          {stats.activity.map((d) => (
            <div key={d.date} className="group relative flex h-full flex-1 flex-col items-center justify-end" title={`${d.date}: ${d.runs}`}>
              <div className={cx('w-full rounded-sm', d.runs ? 'bg-accent/80 group-hover:bg-accent' : 'bg-surface-2')} style={{ height: `${Math.max(4, (d.runs / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-2xs text-subtle">
          <span>{stats.activity[0]?.date}</span>
          <span>{stats.activity.at(-1)?.date}</span>
        </div>
      </CardBody>
    </Card>
  );
}

function FindingMix({ stats }: { stats: WorkspaceStatsResponse }) {
  const total = SEVERITY_ORDER.reduce((a, s) => a + (stats.findingsBySeverity[s] ?? 0), 0);
  return (
    <Card>
      <CardHeader title="Findings" description="All findings by severity" />
      <CardBody className="space-y-2.5">
        {SEVERITY_ORDER.map((s) => {
          const n = stats.findingsBySeverity[s] ?? 0;
          return (
            <div key={s} className="flex items-center gap-3 text-xs">
              <span className="w-16 capitalize text-muted">{s.toLowerCase()}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className={cx('h-full rounded-full', BAR_TONE[SEVERITY_TONE[s] ?? 'neutral'])} style={{ width: total ? `${(n / total) * 100}%` : 0 }} />
              </div>
              <span className="w-8 text-right font-medium tabular-nums">{n}</span>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

export function DashboardPage() {
  const workspaceId = useWorkspaceId();
  // Refresh while something is queued or running
  const stats = useQuery(`stats:${workspaceId}`, () => api.stats(workspaceId), {
    pollMs: (data) => (data && ((data.byStatus['RUNNING'] ?? 0) + (data.byStatus['QUEUED'] ?? 0) > 0 || data.recentRuns.some((r) => isActive(r.status))) ? 3000 : 20000),
  });
  const data = stats.data;
  const completed = data?.byStatus['COMPLETED'] ?? 0;
  const active = (data?.byStatus['RUNNING'] ?? 0) + (data?.byStatus['QUEUED'] ?? 0);
  const risky = (data?.byVerdict['HIGH_RISK'] ?? 0) + (data?.byVerdict['BLOCK'] ?? 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="How the changes verified in this workspace are doing."
        actions={
          <Link to="/runs/new">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
              New verification
            </Button>
          </Link>
        }
      />
      {stats.error && !data ? (
        <Card>
          <ErrorState error={stats.error} onRetry={() => void stats.refetch()} title="Could not load the dashboard" />
        </Card>
      ) : !data ? (
        <div className="space-y-6" aria-busy="true">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="space-y-3 p-4">
                <Skeleton className="w-24" />
                <Skeleton className="h-7 w-16" />
              </Card>
            ))}
          </div>
          <Card>
            <SkeletonRows rows={4} />
          </Card>
        </div>
      ) : data.totalRuns === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks className="h-5 w-5" />}
            title="No verifications yet"
            description="Register a local git repository, then verify a change (base..head) against its requirement."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link to="/repositories">
                  <Button icon={<FolderGit2 className="h-4 w-4" />}>Add a repository</Button>
                </Link>
                <Link to="/runs/new">
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
                    New verification
                  </Button>
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Verifications" value={String(data.totalRuns)} hint={`${completed} completed`} />
            <Stat label="Average score" value={data.averageScore === null ? '—' : String(data.averageScore)} hint="Across scored runs" />
            <Stat label="High risk or blocked" value={String(risky)} hint={data.totalRuns ? `${Math.round((risky / Math.max(1, completed)) * 100)}% of completed` : undefined} />
            <Stat label="In progress" value={String(active)} hint={active ? 'Updating live' : 'Nothing running'} />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <VerdictMix stats={data} />
            <ActivityChart stats={data} />
            <FindingMix stats={data} />
          </div>
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-muted" /> Recent verifications
                </span>
              }
              actions={
                <Link to="/runs" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <RunsTable runs={data.recentRuns} compact />
          </Card>
        </div>
      )}
    </>
  );
}
