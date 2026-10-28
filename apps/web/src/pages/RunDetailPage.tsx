import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleSlash,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  Link2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  User,
  XCircle,
} from 'lucide-react';
import type {
  AgentTimelineEntry,
  AuditChainVerificationResponse,
  VerificationFindingResponse,
  VerificationRunDetailResponse,
} from '@autonomous-engineer/contracts';
import { ApiError, api, errorMessage } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { AGENT_LABEL, CATEGORY_LABEL, SEVERITY_ORDER, VERDICT_HELP, duration, isActive, relativeTime, runDuration, shortSha, titleCase } from '../format';
import { Badge, Button, Card, CardBody, CardHeader, Mono, Skeleton, cx } from '../ui/primitives';
import { EmptyState, ErrorState } from '../ui/states';
import { ScoreRing, SeverityBadge, SeverityDot, StatusBadge, VerdictBadge } from '../ui/verdict';

const AGENTS = ['ingest', 'static', 'negative_space', 'architecture', 'score', 'report'] as const;

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const workspaceId = useWorkspaceId();
  // Live: refetch every 1.5 s while the run is queued or running
  const run = useQuery(`run:${runId}`, () => api.run(workspaceId, runId), {
    pollMs: (data) => (data && isActive(data.status) ? 1500 : null),
  });
  const status = run.data?.status;
  const findings = useQuery(status && !isActive(status) ? `findings:${runId}:${status}` : null, () => api.findings(workspaceId, runId));

  if (run.error && !run.data) {
    const notFound = run.error instanceof ApiError && run.error.status === 404;
    return (
      <Card>
        {notFound ? (
          <EmptyState title="Verification not found" description="It may belong to another workspace." action={<Link to="/runs"><Button>Back to verifications</Button></Link>} />
        ) : (
          <ErrorState error={run.error} onRetry={() => void run.refetch()} />
        )}
      </Card>
    );
  }
  if (!run.data) return <RunSkeleton />;
  const data = run.data;

  return (
    <div className="space-y-6">
      <RunHeader run={data} onChanged={() => void run.refetch()} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <ScoreSummary run={data} />
          {data.report && (
            <Card>
              <CardHeader
                title="Summary"
                description={
                  data.report.generatedBy === 'fallback'
                    ? 'Built from the findings (the reporter did not run)'
                    : data.engine?.llmProvider === 'fake'
                      ? 'Written by the reporter (deterministic stand-in, no model)'
                      : `Written by the reporter (${data.engine?.llmModel ?? 'LLM'})`
                }
              />
              <CardBody>
                <p className="whitespace-pre-line text-sm leading-relaxed text-fg">{data.report.summary}</p>
              </CardBody>
            </Card>
          )}
          {data.scoreBreakdown && <WhyThisScore run={data} />}
          <FindingsSection run={data} findings={findings.data?.findings} loading={findings.loading} error={findings.error} onRetry={() => void findings.refetch()} />
        </div>
        <div className="space-y-6">
          <AgentTimeline run={data} />
          <AuditChain run={data} workspaceId={workspaceId} />
          <RunDetails run={data} />
        </div>
      </div>
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading verification">
      <Skeleton className="h-6 w-1/3" />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="flex items-center gap-6 p-6">
          <Skeleton className="h-28 w-28 rounded-full" />
          <div className="flex-1 space-y-3">
            <Skeleton className="w-1/3" />
            <Skeleton className="w-2/3" />
          </div>
        </Card>
        <Card className="space-y-3 p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} />
          ))}
        </Card>
      </div>
    </div>
  );
}

function RunHeader({ run, onChanged }: { run: VerificationRunDetailResponse; onChanged: () => void }) {
  const workspaceId = useWorkspaceId();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    if (!run.taskId) return;
    setCancelling(true);
    setError(null);
    try {
      await api.cancelTask(workspaceId, run.taskId);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div>
      <Link to="/runs" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="h-3 w-3" /> Verifications
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{run.title ?? run.requirement.split('\n')[0]}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-medium text-fg">{run.repositoryName}</span>
            <Mono>
              {shortSha(run.baseSha)}..{shortSha(run.headSha)}
            </Mono>
            <span className="inline-flex items-center gap-1">
              {run.authorType === 'AI' ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
              {run.authorType === 'AI' ? 'AI-authored' : run.authorType === 'HUMAN' ? 'Human-authored' : 'Author unknown'}
            </span>
            <span title={new Date(run.createdAt).toLocaleString()}>Started {relativeTime(run.createdAt)}</span>
            {run.github && (
              <a href={run.github.pullUrl ?? undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                <GitPullRequest className="h-3.5 w-3.5" />
                {run.github.repository}#{run.github.pullNumber}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          {isActive(run.status) && run.taskId && (
            <Button size="sm" variant="secondary" loading={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function ScoreSummary({ run }: { run: VerificationRunDetailResponse }) {
  const counts = SEVERITY_ORDER.map((s) => [s, run.scoreBreakdown?.items.filter((i) => i.severity === s).length ?? 0] as const);
  return (
    <Card className="flex flex-col items-center gap-6 p-6 sm:flex-row sm:items-center">
      <ScoreRing score={run.score} verdict={run.verdict} />
      <div className="min-w-0 flex-1 space-y-3 text-center sm:text-left">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          <VerdictBadge verdict={run.verdict} className="px-2 py-1 text-xs" />
          {run.engine && !run.engine.complete && <Badge tone="warn">Incomplete: not every agent ran</Badge>}
        </div>
        <p className="text-sm text-muted">
          {run.verdict
            ? VERDICT_HELP[run.verdict]
            : run.status === 'FAILED'
              ? 'The verification failed before it could be scored.'
              : run.status === 'CANCELLED'
                ? 'The verification was cancelled.'
                : 'Scoring happens when the agents finish.'}
        </p>
        {run.scoreBreakdown && (
          <div className="flex flex-wrap justify-center gap-3 text-xs text-muted sm:justify-start">
            <span>{run.findingCount} finding{run.findingCount === 1 ? '' : 's'}</span>
            {counts
              .filter(([, n]) => n > 0)
              .map(([s, n]) => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <SeverityDot severity={s} /> {n} {s.toLowerCase()}
                </span>
              ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function WhyThisScore({ run }: { run: VerificationRunDetailResponse }) {
  const b = run.scoreBreakdown!;
  const bands = run.policySnapshot?.verdict_bands;
  return (
    <Card>
      <CardHeader
        title="Why this score"
        description={
          <>
            Each finding deducts severity weight × category multiplier × source multiplier from 100. Policy hash <Mono className="text-2xs">{b.policyHash.slice(0, 12)}</Mono>
          </>
        }
      />
      {b.items.length === 0 ? (
        <CardBody className="text-sm text-muted">No findings, so nothing was deducted.</CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-border text-2xs uppercase tracking-wider text-subtle">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Finding</th>
                <th className="px-2 py-2 text-right font-medium">Weight</th>
                <th className="px-2 py-2 text-right font-medium">Category</th>
                <th className="px-2 py-2 text-right font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Deduction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.items.map((item) => (
                <tr key={item.findingId}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <SeverityDot severity={item.severity} />
                      <span className="truncate">{item.title}</span>
                    </div>
                    <div className="mt-0.5 pl-4 text-2xs text-subtle">
                      {item.ruleId} · {CATEGORY_LABEL[item.category]} · {item.source === 'LLM' ? 'agent' : 'deterministic'}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">{item.severityWeight}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">×{item.categoryMultiplier}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">×{item.sourceMultiplier}</td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-danger">−{item.deduction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CardBody className="space-y-2 border-t border-border text-sm">
        <Row label="Start" value="100" />
        <Row label="Total deduction" value={`−${b.totalDeduction}`} />
        <Row label="Raw score" value={String(b.rawScore)} />
        {b.capsApplied.map((cap) => (
          <Row
            key={cap.id}
            label={`Cap “${cap.id}” (${cap.count} ${cap.severity.toLowerCase()} ≥ ${cap.minCount})`}
            value={cap.loweredScore ? `capped at ${cap.maxScore}` : `≤ ${cap.maxScore}, already below`}
          />
        ))}
        <Row label="Score" value={String(b.score)} strong />
        {bands && (
          <p className="pt-1 text-xs text-muted">
            Bands: allow ≥ {bands.allow}, review ≥ {bands.review}, high risk ≥ {bands.high_risk}, block below.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={cx('text-muted', strong && 'font-medium text-fg')}>{label}</span>
      <span className={cx('tabular-nums', strong ? 'text-base font-semibold' : 'text-fg')}>{value}</span>
    </div>
  );
}

function FindingsSection({ run, findings, loading, error, onRetry }: {
  run: VerificationRunDetailResponse;
  findings: VerificationFindingResponse[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [severity, setSeverity] = useState<string>('ALL');
  const explanations = useMemo(() => new Map(run.report?.explanations.map((e) => [e.findingId, e]) ?? []), [run.report]);
  const visible = (findings ?? []).filter((f) => severity === 'ALL' || f.severity === severity);
  const groups = Object.keys(CATEGORY_LABEL)
    .map((category) => [category, visible.filter((f) => f.category === category).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <Card>
      <CardHeader
        title={`Findings${findings ? ` (${findings.length})` : ''}`}
        description="Grouped by category; deterministic checks and AI agents."
        actions={
          findings && findings.length > 0 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by severity">
              {['ALL', ...SEVERITY_ORDER].map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={severity === s}
                  onClick={() => setSeverity(s)}
                  className={cx(
                    'rounded px-2 py-1 text-2xs font-medium capitalize',
                    severity === s ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-2'
                  )}
                >
                  {s === 'ALL' ? 'all' : s.toLowerCase()}
                  {s !== 'ALL' && ` ${findings.filter((f) => f.severity === s).length}`}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      {isActive(run.status) ? (
        <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} title="Verifying" description="Findings appear when the pipeline finishes." />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} title="Could not load findings" />
      ) : loading || !findings ? (
        <div className="space-y-3 p-4">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-2/3" />
        </div>
      ) : findings.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="h-5 w-5 text-ok" />} title="No findings" description={run.status === 'COMPLETED' ? 'Nothing in this change contradicts the requirement, the checks or the codebase conventions.' : 'The run did not produce findings.'} />
      ) : (
        <div className="divide-y divide-border">
          {groups.map(([category, list]) => (
            <section key={category} className="px-4 py-3" aria-label={CATEGORY_LABEL[category]}>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-subtle">
                {CATEGORY_LABEL[category]} · {list.length}
              </h3>
              <div className="space-y-2">
                {list.map((f) => (
                  <FindingCard key={f.id} finding={f} explanation={explanations.get(f.findingId)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function FindingCard({ finding, explanation }: { finding: VerificationFindingResponse; explanation?: { explanation: string; suggestedFix: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded-md border border-border bg-bg/40" data-testid="finding">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
        <SeverityBadge severity={finding.severity} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-fg">{finding.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1 font-mono">
              <FileCode2 className="h-3 w-3" />
              {finding.file}:{finding.line}
            </span>
            <span>{finding.ruleId}</span>
            {finding.source === 'LLM' && <Badge tone="accent">agent</Badge>}
          </div>
        </div>
        <ChevronDown className={cx('mt-1 h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
          {explanation?.explanation && <p className="text-fg">{explanation.explanation}</p>}
          {finding.evidence.length > 0 && (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Evidence</div>
              <ul className="space-y-1">
                {finding.evidence.map((e, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words rounded bg-surface-2 px-2 py-1 font-mono text-xs text-fg">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">How to fix</div>
            <p className="text-fg">{explanation?.suggestedFix || finding.remediation}</p>
          </div>
        </div>
      )}
    </article>
  );
}

const STATUS_ICON: Record<string, ReactNode> = {
  running: <Loader2 className="h-4 w-4 animate-spin text-accent" />,
  completed: <CheckCircle2 className="h-4 w-4 text-ok" />,
  failed: <XCircle className="h-4 w-4 text-danger" />,
  skipped: <CircleSlash className="h-4 w-4 text-warn" />,
  pending: <Circle className="h-4 w-4 text-subtle" />,
};

function AgentTimeline({ run }: { run: VerificationRunDetailResponse }) {
  const byName = new Map(run.agentTimeline.map((a) => [a.name, a]));
  const finished = !isActive(run.status);
  return (
    <Card>
      <CardHeader
        title="Agent timeline"
        description={run.engine ? `LLM: ${run.engine.llmProvider === 'fake' ? 'deterministic stand-in (no model)' : `${run.engine.llmProvider} · ${run.engine.llmModel}`}` : isActive(run.status) ? 'Live' : undefined}
      />
      <ol className="px-4 py-3">
        {AGENTS.map((name, i) => {
          const entry: AgentTimelineEntry | undefined = byName.get(name);
          return (
            <li key={name} className="relative flex gap-3 pb-4 last:pb-0" data-testid={`agent-${name}`}>
              {i < AGENTS.length - 1 && <span aria-hidden className="absolute left-2 top-5 h-full w-px bg-border" />}
              <span className="relative z-10 bg-surface">{STATUS_ICON[entry ? entry.status : 'pending']}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg">{AGENT_LABEL[name]}</span>
                  <span className="text-2xs tabular-nums text-subtle">{entry?.durationMs != null ? duration(entry.durationMs) : entry ? '…' : ''}</span>
                </div>
                <div className="text-xs text-muted">
                  {entry ? (
                    <>
                      {titleCase(entry.status)}
                      {entry.attempts > 1 && ` · ${entry.attempts} attempts`}
                      {entry.findingCount > 0 && ` · ${entry.findingCount} finding${entry.findingCount === 1 ? '' : 's'}`}
                    </>
                  ) : finished ? (
                    'Did not run'
                  ) : (
                    'Waiting'
                  )}
                </div>
                {entry?.detail && <div className="mt-0.5 text-2xs text-subtle">{entry.detail}</div>}
                {entry?.error && <div className="mt-0.5 break-words text-2xs text-danger">{entry.error}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function AuditChain({ run, workspaceId }: { run: VerificationRunDetailResponse; workspaceId: string }) {
  const events = useQuery(`audit:${run.id}:${run.status}`, () => api.auditEvents(workspaceId, run.id));
  const [result, setResult] = useState<AuditChainVerificationResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verify = async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.verifyAudit(workspaceId, run.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Audit chain"
        description="Hash-chained record of this run"
        actions={
          <Button size="sm" variant="secondary" loading={checking} icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => void verify()}>
            Verify
          </Button>
        }
      />
      {result && <AuditResult result={result} />}
      {error && <p className="px-4 pt-3 text-xs text-danger">{error}</p>}
      {events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : !events.data ? (
        <div className="space-y-2 p-4">
          <Skeleton />
          <Skeleton className="w-2/3" />
        </div>
      ) : (
        <ol className="max-h-80 space-y-0 overflow-y-auto px-4 py-3">
          {events.data.events.map((e) => (
            <li key={e.id} className="flex items-start gap-2 py-1.5 text-xs">
              <Link2 className="mt-0.5 h-3 w-3 shrink-0 text-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <span className="truncate font-medium text-fg">{e.eventType}</span>
                  <span className="shrink-0 text-subtle" title={new Date(e.timestamp).toLocaleString()}>
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="truncate font-mono text-2xs text-subtle" title={e.hash ?? ''}>
                  {e.hash?.slice(0, 16)}…
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function AuditResult({ result }: { result: AuditChainVerificationResponse }) {
  const checks: Array<[string, boolean | null, string | undefined]> = [
    ['Hash chain', result.chain.valid, result.chain.reason],
    ['Seal', result.seal.valid, result.seal.reason],
    ['Findings', result.findingsDigestValid, undefined],
    ['Score', result.scoreValid, undefined],
    ['Report', result.reportValid, undefined],
  ];
  return (
    <div role="status" className={cx('mx-4 mt-3 rounded-md border px-3 py-2.5 text-xs', result.valid ? 'border-ok/30 bg-ok/10' : 'border-danger/30 bg-danger/10')}>
      <div className={cx('flex items-center gap-1.5 font-semibold', result.valid ? 'text-ok' : 'text-danger')}>
        {result.valid ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        {result.valid ? `Valid: ${result.length} events, nothing altered` : 'Invalid: the record was altered'}
      </div>
      <ul className="mt-2 space-y-1">
        {checks.map(([label, valid, reason]) => (
          <li key={label} className="flex items-start justify-between gap-2">
            <span className="text-muted">{label}</span>
            <span className={cx('text-right', valid === false ? 'text-danger' : valid ? 'text-ok' : 'text-subtle')}>
              {valid === null ? 'not yet' : valid ? 'intact' : reason ?? 'altered'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunDetails({ run }: { run: VerificationRunDetailResponse }) {
  return (
    <Card>
      <CardHeader title="Details" />
      <dl className="space-y-2.5 px-4 py-3 text-xs">
        <Detail label="Base">
          <Mono title={run.baseSha}>{shortSha(run.baseSha)}</Mono>
        </Detail>
        <Detail label="Head">
          <Mono title={run.headSha}>{shortSha(run.headSha)}</Mono>
        </Detail>
        <Detail label="Duration">{runDuration(run)}</Detail>
        <Detail label="Policy">{run.policyHash ? <Mono title={run.policyHash}>{run.policyHash.slice(0, 12)}</Mono> : '—'}</Detail>
        {run.engine && (
          <>
            <Detail label="Static tools">{run.engine.toolsRun.join(', ') || '—'}</Detail>
            {run.engine.toolsUnavailable.length > 0 && <Detail label="Unavailable">{run.engine.toolsUnavailable.join(', ')}</Detail>}
          </>
        )}
        {run.github && (
          <Detail label="PR comment">
            {run.github.comment ? (
              run.github.comment.url ? (
                <a className="inline-flex items-center gap-1 text-accent hover:underline" href={run.github.comment.url} target="_blank" rel="noreferrer">
                  Posted <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span title={run.github.comment.error ?? ''}>{titleCase(run.github.comment.status)}</span>
              )
            ) : (
              'Pending'
            )}
          </Detail>
        )}
      </dl>
      <div className="border-t border-border px-4 py-3">
        <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Requirement</div>
        <p className="whitespace-pre-line text-xs leading-relaxed text-fg">{run.requirement}</p>
      </div>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg">{children}</dd>
    </div>
  );
}
