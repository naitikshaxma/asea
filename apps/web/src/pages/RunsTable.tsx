import { Link } from 'react-router-dom';
import { GitPullRequest } from 'lucide-react';
import type { VerificationRunResponse } from '@autonomous-engineer/contracts';
import { relativeTime, runDuration, shortSha } from '../format';
import { StatusBadge, VerdictBadge } from '../ui/verdict';
import { Mono, cx } from '../ui/primitives';

/** One row per verification run; used by the dashboard and the verifications list. */
export function RunsTable({ runs, compact = false }: { runs: VerificationRunResponse[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-border text-2xs uppercase tracking-wider text-subtle">
          <tr>
            <th className="px-4 py-2 font-medium">Change</th>
            <th className="px-4 py-2 font-medium">Verdict</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            {!compact && <th className="px-4 py-2 text-right font-medium">Findings</th>}
            <th className="px-4 py-2 font-medium">Status</th>
            {!compact && <th className="px-4 py-2 font-medium">Duration</th>}
            <th className="px-4 py-2 text-right font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id} className="group hover:bg-surface-2/60">
              <td className="max-w-[22rem] px-4 py-2.5">
                <Link to={`/runs/${run.id}`} className="block min-w-0">
                  <div className="flex items-center gap-1.5 truncate font-medium text-fg group-hover:text-accent">
                    {run.github && <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Pull request" />}
                    <span className="truncate">{run.title ?? run.requirement}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                    <span className="truncate">{run.repositoryName}</span>
                    <span aria-hidden>·</span>
                    <Mono className="text-2xs">
                      {shortSha(run.baseSha)}..{shortSha(run.headSha)}
                    </Mono>
                  </div>
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <VerdictBadge verdict={run.verdict} />
              </td>
              <td className={cx('px-4 py-2.5 text-right font-medium tabular-nums', run.score === null && 'text-subtle')}>
                {run.score === null ? '—' : Math.round(run.score)}
              </td>
              {!compact && <td className="px-4 py-2.5 text-right tabular-nums text-muted">{run.findingCount}</td>}
              <td className="px-4 py-2.5">
                <StatusBadge status={run.status} />
              </td>
              {!compact && <td className="px-4 py-2.5 tabular-nums text-muted">{runDuration(run)}</td>}
              <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted" title={new Date(run.createdAt).toLocaleString()}>
                {relativeTime(run.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
