import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, Clock3, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { api } from '../api/client';
import { useSession, useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { isActive, titleCase } from '../format';
import { Badge, Button, Card, CardBody, CardHeader, Mono, Skeleton, Textarea } from '../ui/primitives';
import { ErrorState, PageHeader, SkeletonRows } from '../ui/states';

function tone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (['COMPLETED', 'APPROVED', 'SUCCESS', 'PASSED', 'PR_OPEN'].includes(status)) return 'ok';
  if (['FAILED', 'REJECTED', 'CANCELLED', 'FAILURE', 'ERROR'].includes(status)) return 'danger';
  if (status === 'NEEDS_ATTENTION' || status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING') return 'warn';
  return 'neutral';
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const workspaceId = useWorkspaceId();
  const { user, workspace } = useSession();
  const taskQuery = useQuery(`task:${workspaceId}:${taskId}`, () => api.task(workspaceId, taskId), {
    pollMs: (task) => task && isActive(task.status) ? 2000 : null,
  });
  const patchHash = taskQuery.data?.executionMetadata?.patchHash;
  const patchQuery = useQuery(patchHash ? `patch:${workspaceId}:${taskId}` : null, () => api.taskPatch(workspaceId, taskId));
  const approvalsQuery = useQuery(patchQuery.data ? `approvals:${workspaceId}:${taskId}` : null, () => api.approvals(workspaceId));
  const approval = approvalsQuery.data?.approvals.find((row) => row.taskId === taskId && row.patchHash === patchHash);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [ciBusy, setCiBusy] = useState(false);

  const cancel = async () => {
    if (!taskQuery.data) return;
    setBusy(true);
    setActionError(null);
    try { await api.cancelTask(workspaceId, taskId); await taskQuery.refetch(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    if (!approval) return;
    if (decision === 'REJECTED' && !reason.trim()) { setActionError('Enter a reason before rejecting this patch.'); return; }
    setBusy(true);
    setActionError(null);
    try {
      await api.decideApproval(workspaceId, approval.id, decision, reason.trim() || undefined);
      await Promise.all([taskQuery.refetch(), patchQuery.refetch(), approvalsQuery.refetch()]);
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    setPublishBusy(true);
    setActionError(null);
    try {
      await api.publishTaskPatch(workspaceId, taskId);
      await patchQuery.refetch();
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setPublishBusy(false); }
  };

  const syncCi = async () => {
    setCiBusy(true);
    setActionError(null);
    try {
      await api.syncTaskCi(workspaceId, taskId);
      await patchQuery.refetch();
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setCiBusy(false); }
  };

  if (taskQuery.error && !taskQuery.data) return <><PageHeader title="Engineering task" /><Card><ErrorState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} title="Could not load task" /></Card></>;
  if (!taskQuery.data) return <><PageHeader title="Engineering task" /><Card><CardBody><Skeleton className="mb-3 h-5 w-1/3" /><SkeletonRows rows={4} /></CardBody></Card></>;

  const task = taskQuery.data;
  const canCancel = ['QUEUED', 'RUNNING', 'NEEDS_ATTENTION'].includes(task.status);
  const canReview = Boolean(approval?.status === 'PENDING' && approval.patchIsCurrent && approval.requestedById !== user?.id && ['ADMIN', 'OWNER'].includes(workspace?.role ?? ''));
  const isAdmin = ['ADMIN', 'OWNER'].includes(workspace?.role ?? '');
  const patch = patchQuery.data;

  return <>
    <PageHeader title={task.title} description={`${titleCase(task.taskType)} · created ${new Date(task.createdAt).toLocaleString()}`}
      actions={<><Link to="/tasks"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>Tasks</Button></Link>{canCancel && <Button variant="danger" icon={<Ban className="h-3.5 w-3.5" />} loading={busy} onClick={() => void cancel()}>Cancel task</Button>}</>} />
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="space-y-5">
        <Card>
          <CardHeader title="Request" actions={<Badge tone={tone(task.status)}>{titleCase(task.status)}</Badge>} />
          <CardBody><p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{task.description}</p>
            {task.failureReason && <p className="mt-4 rounded-md border border-warn/25 bg-warn/10 p-3 text-sm text-fg">{task.failureReason}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Workflow history" description="Worker recorded steps and their actual outcomes." />
          {!task.runs?.some((run) => run.steps?.length) ? <CardBody className="text-sm text-muted">No workflow steps have been recorded yet.</CardBody> : (
            <div className="divide-y divide-border">
              {task.runs?.flatMap((run) => run.steps ?? []).sort((a, b) => a.stepOrder - b.stepOrder).map((step) => (
                <div key={step.id} className="flex items-start gap-3 px-4 py-3">
                  <Clock3 className="mt-0.5 h-4 w-4 text-muted" />
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-fg">{titleCase(step.stepType)}</span><Badge tone={tone(step.stepStatus)}>{titleCase(step.stepStatus)}</Badge></div>
                    {step.failureSummary && <p className="mt-1 text-xs text-muted">{step.failureSummary}</p>}
                    {step.resultMetadata && <pre className="mt-2 overflow-auto rounded bg-surface-2 p-2 text-2xs text-muted">{JSON.stringify(step.resultMetadata, null, 2)}</pre>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {task.taskType === 'CODE_PATCH' && (
          <Card>
            <CardHeader title="Proposed patch" description="Review the diff generated against the isolated source snapshot." />
            {patchQuery.error && !patchQuery.data ? <ErrorState error={patchQuery.error} onRetry={() => void patchQuery.refetch()} title="Patch is not available" /> :
              !patchQuery.data ? <CardBody className="text-sm text-muted">{task.status === 'RUNNING' || task.status === 'QUEUED' ? 'Waiting for the worker to generate a patch…' : 'No patch artifact was produced for this task.'}</CardBody> : (
                <>
                  <CardBody className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(patchQuery.data.status)}>{titleCase(patchQuery.data.status)}</Badge><span className="text-sm font-medium text-fg">{patchQuery.data.summary}</span></div>
                    <p className="text-xs text-muted">Snapshot <Mono>{patchQuery.data.snapshotHash.slice(0, 12)}</Mono> · Patch <Mono>{patchQuery.data.patchHash.slice(0, 12)}</Mono></p>
                    <div><h3 className="mb-2 text-xs font-semibold text-fg">Plan</h3><ol className="list-decimal space-y-1 pl-5 text-sm text-muted">{patchQuery.data.plan.map((line, index) => <li key={index}>{line}</li>)}</ol></div>
                    <div><h3 className="mb-2 text-xs font-semibold text-fg">Proposal evidence</h3><ul className="list-disc space-y-1 pl-5 text-sm text-muted">{patchQuery.data.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
                    <div><h3 className="mb-2 text-xs font-semibold text-fg">Changed files</h3><ul className="space-y-1 text-sm text-muted">{patchQuery.data.changedFiles.map((file) => <li key={file}><Mono>{file}</Mono></li>)}</ul></div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <div><p className="text-2xs text-muted">Sandbox</p><Badge tone={tone(patchQuery.data.sandboxDiagnostics?.status ?? 'UNAVAILABLE')}>{titleCase(patchQuery.data.sandboxDiagnostics?.status ?? 'UNAVAILABLE')}</Badge></div>
                      <div><p className="text-2xs text-muted">Tests</p><Badge tone={tone(patchQuery.data.testStatus)}>{titleCase(patchQuery.data.testStatus)}</Badge></div>
                      <div><p className="text-2xs text-muted">Security scan</p><Badge tone={tone(patchQuery.data.securityStatus)}>{titleCase(patchQuery.data.securityStatus)}</Badge></div>
                      <div><p className="text-2xs text-muted">Independent review</p><Badge tone={tone(patchQuery.data.reviewStatus)}>{titleCase(patchQuery.data.reviewStatus)}</Badge></div>
                    </div>
                    {patchQuery.data.sandboxDiagnostics && <p className="text-xs text-muted">{patchQuery.data.sandboxDiagnostics.message}</p>}
                    <div className="space-y-2 text-xs">
                      {Boolean(patchQuery.data.testResults) && <details><summary className="cursor-pointer font-medium text-fg">Test command output and summaries</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-2xs text-muted">{JSON.stringify(patchQuery.data.testResults, null, 2)}</pre></details>}
                      {Boolean(patchQuery.data.securityResults) && <details><summary className="cursor-pointer font-medium text-fg">Security scanner results and findings</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-2xs text-muted">{JSON.stringify(patchQuery.data.securityResults, null, 2)}</pre></details>}
                      {Boolean(patchQuery.data.reviewResults) && <details><summary className="cursor-pointer font-medium text-fg">Independent review findings</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-2xs text-muted">{JSON.stringify(patchQuery.data.reviewResults, null, 2)}</pre></details>}
                    </div>
                    <div><p className="text-2xs text-muted">Workspace cleanup</p><Badge tone={patchQuery.data.workspaceCleanupStatus === 'CLEANED' ? 'ok' : 'warn'}>{titleCase(patchQuery.data.workspaceCleanupStatus)}</Badge></div>
                    <div><h3 className="mb-2 text-xs font-semibold text-fg">Unified diff</h3><pre className="max-h-[32rem] overflow-auto rounded-md border border-border bg-surface-2 p-3 text-xs leading-relaxed text-fg">{patchQuery.data.unifiedDiff}</pre></div>
                  </CardBody>
                </>
              )}
          </Card>
        )}
      </div>

      <aside className="space-y-5">
        <Card><CardHeader title="Review" /><CardBody className="space-y-3">
          {Boolean(approvalsQuery.error) && <p role="alert" className="text-xs text-danger">Approval status could not be loaded.</p>}
          {!patchQuery.data ? <p className="text-sm text-muted">Approval is available after a patch proposal is saved.</p> : approvalsQuery.loading ? <p className="text-sm text-muted">Loading approval status…</p> : !approval ? <p className="text-sm text-muted">No approval request is associated with this patch.</p> : <>
            <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-muted" /><Badge tone={tone(approval.status)}>{titleCase(approval.status)}</Badge></div>
            <p className="text-xs text-muted">Requested by {approval.requester?.displayName ?? 'workspace member'}. A different workspace administrator or owner must review it.</p>
            {approval.status !== 'PENDING' && <p className="text-xs text-muted">Decision by {approval.decider?.displayName ?? 'reviewer'}{approval.reason ? `: ${approval.reason}` : ''}</p>}
            {canReview && <>
              <Textarea aria-label="Rejection reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason, required to reject" />
              <div className="grid grid-cols-2 gap-2"><Button variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={() => void decide('APPROVED')}>Approve</Button><Button variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy} onClick={() => void decide('REJECTED')} disabled={!reason.trim()}>Reject</Button></div>
            </>}
            {approval.status === 'PENDING' && !approval.patchIsCurrent && <p className="text-xs text-warn">This approval is stale because the task is no longer awaiting review.</p>}
            {approval.status === 'PENDING' && approval.patchIsCurrent && !canReview && <p className="text-xs text-muted">This session cannot decide this approval. The requester cannot approve their own patch.</p>}
          </>}
          {actionError && <p role="alert" className="rounded border border-danger/25 bg-danger/10 p-2 text-xs text-danger">{actionError}</p>}
        </CardBody></Card>
        <Card><CardHeader title="Publication and CI" />
          <CardBody className="space-y-3 text-sm text-muted">
            {actionError && <p role="alert" className="rounded border border-danger/25 bg-danger/10 p-2 text-xs text-danger">{actionError}</p>}
            {!patch ? <p>A pull request can be published after a patch is saved and its required checks pass.</p> : <>
              <div className="flex flex-wrap items-center gap-2"><span>Publication</span><Badge tone={tone(patch.publicationStatus)}>{titleCase(patch.publicationStatus.replace(/_/g, ' '))}</Badge></div>
              {patch.publicationError && <p role="alert" className="text-xs text-danger">{patch.publicationError}</p>}
              {patch.pullRequestUrl && <a href={patch.pullRequestUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
                Pull request #{patch.pullRequestNumber} <ExternalLink className="h-3 w-3" />
              </a>}
              {patch.publicationStatus !== 'PR_OPEN' && <>
                <p className="text-xs">Publishing requires second-person approval, passing sandbox tests, a passing security scan, and a passing independent review. Current results: tests {patch.testStatus}, security {patch.securityStatus}, review {patch.reviewStatus}.</p>
                {isAdmin && <Button size="sm" variant="primary" loading={publishBusy} disabled={patch.status !== 'APPROVED' || patch.testStatus !== 'PASSED' || patch.securityStatus !== 'PASSED' || patch.reviewStatus !== 'PASSED' || patch.publicationStatus === 'PUBLISHING'} onClick={() => void publish()}>
                  {patch.publicationStatus === 'FAILED' ? 'Retry publication' : 'Publish approved patch'}
                </Button>}
              </>}
              {patch.publicationStatus === 'PR_OPEN' && <>
                <div className="flex flex-wrap items-center gap-2"><span>CI status</span><Badge tone={tone(patch.ciStatus)}>{titleCase(patch.ciStatus.replace(/_/g, ' '))}</Badge></div>
                {patch.ciChecks?.length ? <ul className="space-y-1 text-xs">{patch.ciChecks.map((check, index) => <li key={`${check.name}-${index}`} className="flex items-center justify-between gap-2">
                  {check.detailsUrl ? <a className="truncate text-accent hover:underline" href={check.detailsUrl} target="_blank" rel="noreferrer noopener">{check.name}</a> : <span className="truncate">{check.name}</span>}
                  <Badge tone={tone(check.conclusion ?? check.status)}>{titleCase(check.conclusion ?? check.status)}</Badge>
                </li>)}</ul> : <p className="text-xs">No CI checks have been reported for this commit yet.</p>}
                {patch.ciDiagnosis && patch.ciStatus === 'FAILURE' && <section aria-label="CI failure diagnosis" className="space-y-2 rounded border border-danger/20 bg-danger/5 p-3">
                  <h3 className="text-xs font-semibold text-ink">CI failure diagnosis</h3>
                  <p className="text-xs">{patch.ciDiagnosis.summary}</p>
                  {patch.ciDiagnosis.failedChecks.map((check, index) => <div key={`${check.name}-${index}`} className="space-y-1 text-xs">
                    <p className="font-medium">{check.name}: {titleCase(check.conclusion)}</p>
                    {check.summary && <p className="whitespace-pre-wrap break-words">{check.summary}</p>}
                    {check.annotations.map((annotation, annotationIndex) => <p key={`${annotation.path}-${annotation.startLine}-${annotationIndex}`} className="break-words">
                      {annotation.path && <><code className="text-ink">{annotation.path}{annotation.startLine ? `:${annotation.startLine}` : ''}</code>{' — '}</>}
                      {annotation.title && <strong>{annotation.title}: </strong>}{annotation.message}
                    </p>)}
                    {check.detailsUrl && <a className="text-accent hover:underline" href={check.detailsUrl} target="_blank" rel="noreferrer noopener">Open check details</a>}
                  </div>)}
                  <p className="text-2xs">File references come from GitHub check annotations. Automatic repair is unavailable until an isolated test and security scan provider is configured.</p>
                </section>}
                <Button size="sm" loading={ciBusy} onClick={() => void syncCi()}>Sync CI status</Button>
                {patch.ciSyncedAt && <p className="text-2xs">Last synchronized {new Date(patch.ciSyncedAt).toLocaleString()}.</p>}
              </>}
            </>}
          </CardBody>
        </Card>
      </aside>
    </div>
  </>;
}
