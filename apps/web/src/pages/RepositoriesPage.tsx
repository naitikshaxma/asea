import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FolderGit2, GitBranch, Github, Microscope, Plus, Search, Unplug } from 'lucide-react';
import type { ConnectGithubResponse, RepositoryAnalysisResponse, RepositoryResponse, TaskRelevantFilesResponse } from '@autonomous-engineer/contracts';
import { ApiError, api, errorMessage } from '../api/client';
import type { GithubAppInstallation } from '../api/client';
import { useSession, useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { relativeTime, shortSha } from '../format';
import { Dialog } from '../ui/Dialog';
import { Badge, Button, Card, CardBody, CopyButton, Field, Input, Mono, Skeleton } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui/states';

export function RepositoriesPage() {
  const workspaceId = useWorkspaceId();
  const repos = useQuery(`repos:${workspaceId}`, () => api.repositories(workspaceId));
  const githubApp = useQuery(`github-app:${workspaceId}`, () => api.githubApp(workspaceId));
  const [adding, setAdding] = useState(false);
  const refresh = () => { void repos.refetch(); void githubApp.refetch(); };

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Local git checkouts the server can read (inside ALLOWED_REPO_ROOTS). Connect one to GitHub to verify its pull requests automatically."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add repository
          </Button>
        }
      />
      {repos.error && !repos.data ? (
        <Card>
          <ErrorState error={repos.error} onRetry={() => void repos.refetch()} title="Could not load repositories" />
        </Card>
      ) : !repos.data ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : repos.data.repositories.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderGit2 className="h-5 w-5" />}
            title="No repositories yet"
            description="Register a local git checkout by its absolute path on the server."
            action={
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                Add repository
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
            {repos.data.repositories.map((repo) => (
            <RepositoryCard key={repo.id} repo={repo} installations={githubApp.data?.installations ?? []} onChanged={refresh} />
          ))}
        </div>
      )}
      <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), void repos.refetch())} />
    </>
  );
}

function AddRepositoryDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const workspaceId = useWorkspaceId();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createRepository(workspaceId, { name, provider: 'LOCAL', repositoryUrl: path, defaultBranch });
      setName('');
      setPath('');
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add repository" description="The path must be an absolute path to a git checkout inside the server's ALLOWED_REPO_ROOTS.">
      <form id="add-repository" onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="repo-name">
          <Input id="repo-name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="payments-service" />
        </Field>
        <Field label="Path on the server" htmlFor="repo-path">
          <Input id="repo-path" required value={path} onChange={(e) => setPath(e.target.value)} placeholder="/repos/payments-service" className="font-mono text-xs" />
        </Field>
        <Field label="Default branch" htmlFor="repo-branch">
          <Input id="repo-branch" required value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>
            Add repository
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RepositoryCard({ repo, installations, onChanged }: { repo: RepositoryResponse; installations: GithubAppInstallation[]; onChanged: () => void }) {
  const workspaceId = useWorkspaceId();
  const { workspace } = useSession();
  const isAdmin = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const refs = useQuery(`refs:${repo.id}`, () => api.refs(workspaceId, repo.id));
  const [connecting, setConnecting] = useState(false);
  const [panel, setPanel] = useState<'none' | 'analysis'>('none');
  const [appConnecting, setAppConnecting] = useState(false);

  const disconnect = async () => {
    await api.disconnectGithub(workspaceId, repo.id);
    onChanged();
  };

  const disconnectApp = async () => {
    await api.disconnectGithubAppRepository(workspaceId, repo.id);
    onChanged();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-muted" />
            <h2 className="truncate text-sm font-semibold">{repo.name}</h2>
            {repo.githubFullName && (
              <Badge tone="accent">
                <Github className="h-3 w-3" />
                {repo.githubFullName}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
            <Mono className="text-2xs">{repo.repositoryUrl}</Mono>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {repo.defaultBranch}
            </span>
            <span>Added {relativeTime(repo.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/runs?repository=${repo.id}`}>
            <Button size="sm">Verifications</Button>
          </Link>
          <Button size="sm" icon={<Microscope className="h-3.5 w-3.5" />} aria-pressed={panel === 'analysis'} onClick={() => setPanel(panel === 'analysis' ? 'none' : 'analysis')}>
            Analysis
          </Button>
          {isAdmin && (repo.githubAppConnected ? (
            <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => void disconnectApp()}>Disconnect App</Button>
          ) : installations.length ? (
            <Button size="sm" icon={<Github className="h-3.5 w-3.5" />} onClick={() => setAppConnecting(true)}>Connect App repository</Button>
          ) : (
            <Link to="/settings"><Button size="sm" icon={<Github className="h-3.5 w-3.5" />}>Install GitHub App</Button></Link>
          ))}
          {isAdmin && (repo.githubWebhookConfigured ? (
            <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => void disconnect()}>Disconnect webhook</Button>
          ) : (
            <Button size="sm" onClick={() => setConnecting(true)}>{repo.githubFullName ? 'Configure PR webhook' : 'Configure GitHub webhook'}</Button>
          ))}
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-subtle">Branches</div>
        {refs.error ? (
          <p className="text-xs text-danger">{errorMessage(refs.error)}</p>
        ) : !refs.data ? (
          <Skeleton className="w-1/2" />
        ) : refs.data.branches.length === 0 ? (
          <p className="text-xs text-muted">No branches.</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {refs.data.branches.slice(0, 8).map((b) => (
              <li key={b.name} className="flex min-w-0 items-center gap-2 text-xs">
                <Mono className="text-2xs">{shortSha(b.sha)}</Mono>
                <span className="truncate font-medium">{b.name}</span>
                <span className="truncate text-muted">{b.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {panel === 'analysis' && <AnalysisPanel repo={repo} />}
      <ConnectGithubDialog repo={repo} open={connecting} onClose={() => setConnecting(false)} onConnected={onChanged} />
      <ConnectGithubAppDialog repo={repo} installations={installations} open={appConnecting} onClose={() => setAppConnecting(false)} onConnected={onChanged} />
    </Card>
  );
}

function ConnectGithubAppDialog({ repo, installations, open, onClose, onConnected }: {
  repo: RepositoryResponse; installations: GithubAppInstallation[]; open: boolean; onClose: () => void; onConnected: () => void;
}) {
  const workspaceId = useWorkspaceId();
  const [installationRecordId, setInstallationRecordId] = useState(installations[0]?.id ?? '');
  const [remoteRepos, setRemoteRepos] = useState<Array<{ id: number; fullName: string; private: boolean; defaultBranch: string }>>([]);
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInstallationRecordId((current) => installations.some((row) => row.id === current) ? current : installations[0]?.id ?? '');
  }, [open, installations]);
  useEffect(() => {
    if (!open || !installationRecordId) return;
    let active = true;
    setBusy(true);
    setError(null);
    void api.githubAppRepositories(workspaceId, installationRecordId)
      .then((result) => { if (active) { setRemoteRepos(result.repositories); setFullName((current) => result.repositories.some((row) => row.fullName === current) ? current : ''); } })
      .catch((err) => { if (active) setError(errorMessage(err)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [open, installationRecordId, workspaceId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!fullName || !installationRecordId) return;
    setBusy(true);
    setError(null);
    try {
      await api.connectGithubAppRepository(workspaceId, repo.id, installationRecordId, fullName);
      onConnected();
      onClose();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return <Dialog open={open} onClose={onClose} title={`Connect ${repo.name} to a GitHub App`} description="Select a repository available to an installation in this workspace.">
    <form onSubmit={submit} className="space-y-4">
      <Field label="GitHub App installation" htmlFor={`app-installation-${repo.id}`}>
        <select id={`app-installation-${repo.id}`} value={installationRecordId} onChange={(event) => { setInstallationRecordId(event.target.value); setRemoteRepos([]); setFullName(''); }} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg">
          {installations.map((installation) => <option key={installation.id} value={installation.id}>{installation.accountLogin} ({installation.accountType})</option>)}
        </select>
      </Field>
      <Field label="Repository" htmlFor={`app-repository-${repo.id}`}>
        <select id={`app-repository-${repo.id}`} value={fullName} onChange={(event) => setFullName(event.target.value)} disabled={busy || remoteRepos.length === 0} required className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg">
          <option value="">{busy ? 'Loading repositories…' : remoteRepos.length ? 'Choose a repository' : 'No repositories available'}</option>
          {remoteRepos.map((remote) => <option key={remote.id} value={remote.fullName}>{remote.fullName}{remote.private ? ' · private' : ''}</option>)}
        </select>
      </Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!fullName}>Connect repository</Button></div>
    </form>
  </Dialog>;
}

function ConnectGithubDialog({ repo, open, onClose, onConnected }: { repo: RepositoryResponse; open: boolean; onClose: () => void; onConnected: () => void }) {
  const workspaceId = useWorkspaceId();
  const [fullName, setFullName] = useState('');
  const [result, setResult] = useState<ConnectGithubResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => {
    setResult(null);
    setFullName('');
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setResult(await api.connectGithub(workspaceId, repo.id, fullName));
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onClose={close} title={`Connect ${repo.name} to GitHub`} description="Pull requests on the GitHub repository will be verified against this checkout, and the result posted on the PR.">
      {result ? (
        <div className="space-y-4">
          <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-fg">
            Copy the secret now; it is not shown again. In GitHub open <strong>Settings → Webhooks → Add webhook</strong> and enter:
          </p>
          <SecretRow label="Payload URL" value={result.webhookUrl} />
          <SecretRow label="Content type" value={result.contentType} />
          <SecretRow label="Secret" value={result.webhookSecret} testId="webhook-secret" />
          <SecretRow label="Events" value="Pull requests" />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="GitHub repository" htmlFor="github-name" hint="owner/name, e.g. acme/payments-service">
            <Input id="github-name" required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="owner/name" />
          </Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving}>
              Generate webhook secret
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function SecretRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 truncate rounded border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function AnalysisPanel({ repo }: { repo: RepositoryResponse }) {
  const workspaceId = useWorkspaceId();
  const latest = useQuery(`analysis:${repo.id}`, () =>
    api.latestAnalysis(workspaceId, repo.id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    })
  );
  const [running, setRunning] = useState(false);
  const [analysis, setAnalysis] = useState<RepositoryAnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryText, setQueryText] = useState('');
  const [relevant, setRelevant] = useState<TaskRelevantFilesResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const current = analysis ?? latest.data ?? null;

  const analyze = async () => {
    setRunning(true);
    setError(null);
    try {
      setAnalysis(await api.analyze(workspaceId, repo.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };
  const search = async (e: FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setError(null);
    try {
      setRelevant(await api.relevantFiles(workspaceId, repo.id, queryText));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <CardBody className="space-y-4 border-t border-border bg-bg/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted">
          {current ? `Last analysed ${relativeTime(current.completedAt ?? current.createdAt)} · ${current.status.toLowerCase()}` : latest.loading ? 'Loading…' : 'Not analysed yet.'}
        </div>
        <Button size="sm" loading={running} onClick={() => void analyze()}>
          {current ? 'Analyse again' : 'Analyse repository'}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {latest.error ? <p className="text-xs text-danger">{errorMessage(latest.error)}</p> : null}
      {current?.statistics && (
        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          {[
            ['Files', current.statistics.totalFiles],
            ['Analysed', current.statistics.eligibleFiles],
            ['Skipped', current.statistics.skippedFiles],
            ['Secrets excluded', current.statistics.secretFilesExcluded],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-border bg-surface px-3 py-2">
              <dt className="text-muted">{label}</dt>
              <dd className="text-sm font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {current && current.technologies.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Technologies">
          {current.technologies.map((t) => (
            <Badge key={t.name} title={t.rationale}>
              {t.name}
              {t.version ? ` ${t.version}` : ''}
            </Badge>
          ))}
        </div>
      )}
      {current?.status === 'COMPLETED' && (
        <form onSubmit={search} className="flex gap-2">
          <Input aria-label="Find files relevant to a requirement" value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="Find files relevant to… (e.g. project export)" minLength={3} required />
          <Button type="submit" icon={<Search className="h-4 w-4" />} loading={searching}>
            Find
          </Button>
        </form>
      )}
      {relevant && (
        <ul className="space-y-1 text-xs" aria-label="Relevant files">
          {relevant.results.length === 0 && <li className="text-muted">No file matches.</li>}
          {relevant.results.map((r) => (
            <li key={r.path} className="flex items-center gap-2">
              <span className="w-8 text-right font-medium tabular-nums">{Math.round(r.score)}</span>
              <Mono className="text-2xs">{r.path}</Mono>
              <span className="truncate text-muted">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </CardBody>
  );
}
