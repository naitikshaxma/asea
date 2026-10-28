import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FolderGit2, GitCompareArrows } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { relativeTime, shortSha } from '../format';
import { Button, Card, CardBody, CardHeader, Field, Input, Select, Skeleton, Textarea } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader } from '../ui/states';

export function NewVerificationPage() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const repos = useQuery(`repos:${workspaceId}`, () => api.repositories(workspaceId));
  const policies = useQuery(`policies:${workspaceId}`, () => api.policies(workspaceId));
  const [repositoryId, setRepositoryId] = useState('');
  const refs = useQuery(repositoryId ? `refs:${repositoryId}` : null, () => api.refs(workspaceId, repositoryId));
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [authorType, setAuthorType] = useState<'AI' | 'HUMAN' | 'UNKNOWN'>('AI');
  const [policyId, setPolicyId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!repositoryId && repos.data?.repositories[0]) setRepositoryId(repos.data.repositories[0].id);
  }, [repos.data, repositoryId]);

  // Default the base to the repository's default branch and the head to the newest other branch
  useEffect(() => {
    const data = refs.data;
    if (!data) return;
    const defaultBranch = data.branches.find((b) => b.name === data.defaultBranch) ?? data.branches[0];
    setBase(defaultBranch?.sha ?? '');
    setHead(data.branches.find((b) => b.sha !== defaultBranch?.sha)?.sha ?? defaultBranch?.sha ?? '');
  }, [refs.data]);

  const headBranch = useMemo(() => refs.data?.branches.find((b) => b.sha === head), [refs.data, head]);
  useEffect(() => {
    if (headBranch && !title) setTitle(headBranch.subject);
    // only when the head changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headBranch]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const task = await api.submitTask(workspaceId, {
        title: title.trim() || 'Verification',
        description: requirement,
        taskType: 'VERIFICATION',
        priority: 'NORMAL',
        targetBranch: 'main',
        repositoryId,
        verification: { baseSha: base, headSha: head, authorType, ...(policyId ? { policyProfileId: policyId } : {}) },
      });
      // The verification run is created with the task; open it
      const [run] = (await api.runs(workspaceId, { taskId: task.id, limit: 1 })).verificationRuns;
      navigate(run ? `/runs/${run.id}` : '/runs');
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  if (repos.error && !repos.data) {
    return (
      <>
        <PageHeader title="New verification" />
        <Card>
          <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
        </Card>
      </>
    );
  }
  if (repos.data && repos.data.repositories.length === 0) {
    return (
      <>
        <PageHeader title="New verification" />
        <Card>
          <EmptyState
            icon={<FolderGit2 className="h-5 w-5" />}
            title="Add a repository first"
            description="A verification compares two commits of a registered local git repository."
            action={
              <Link to="/repositories">
                <Button variant="primary">Add a repository</Button>
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const branches = refs.data?.branches ?? [];
  const sameCommit = Boolean(base && head && base === head);

  return (
    <>
      <PageHeader title="New verification" description="Check a change (base..head) against the requirement it should implement." />
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader title="Change" description="Pick the repository and the two commits to compare." />
          <CardBody className="space-y-4">
            {!repos.data ? (
              <Skeleton className="h-9" />
            ) : (
              <Field label="Repository" htmlFor="repository">
                <Select id="repository" value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
                  {repos.data.repositories.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {refs.error ? (
              <p role="alert" className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
                {errorMessage(refs.error)}
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
                <Field label="Base" htmlFor="base" hint="What the change is applied to">
                  <Select id="base" value={base} onChange={(e) => setBase(e.target.value)} disabled={!refs.data}>
                    {branches.map((b) => (
                      <option key={`base-${b.name}`} value={b.sha}>
                        {b.name} · {shortSha(b.sha)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <GitCompareArrows className="mx-auto mb-8 hidden h-4 w-4 text-subtle sm:block" aria-hidden />
                <Field label="Head" htmlFor="head" hint={headBranch ? `${headBranch.subject} · ${relativeTime(headBranch.committedAt)}` : 'The change to verify'}>
                  <Select id="head" value={head} onChange={(e) => setHead(e.target.value)} disabled={!refs.data}>
                    {branches.map((b) => (
                      <option key={`head-${b.name}`} value={b.sha}>
                        {b.name} · {shortSha(b.sha)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {sameCommit && <p className="text-xs text-warn">Base and head are the same commit; there is nothing to verify.</p>}
            <Field label="Title" htmlFor="title">
              <Input id="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Add export endpoint" />
            </Field>
            <Field label="Requirement" htmlFor="requirement" hint="What the change must do. The agents check the change against this text.">
              <Textarea
                id="requirement"
                required
                minLength={10}
                maxLength={5000}
                rows={5}
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                placeholder="Only signed-in users may export their own projects as JSON. Cover the new service function with a test."
              />
            </Field>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Options" />
            <CardBody className="space-y-4">
              <Field label="Author" htmlFor="authorType" hint="Who wrote the change">
                <Select id="authorType" value={authorType} onChange={(e) => setAuthorType(e.target.value as typeof authorType)}>
                  <option value="AI">AI agent</option>
                  <option value="HUMAN">Human</option>
                  <option value="UNKNOWN">Unknown</option>
                </Select>
              </Field>
              <Field label="Policy" htmlFor="policy" hint="How findings turn into a score and verdict">
                <Select id="policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                  <option value="">Workspace default</option>
                  {policies.data?.policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </CardBody>
          </Card>
          {error && (
            <p role="alert" className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={submitting} disabled={!repositoryId || !base || !head || sameCommit}>
            Start verification
          </Button>
        </div>
      </form>
    </>
  );
}
