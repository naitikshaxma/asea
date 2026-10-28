import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, FolderGit2 } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useWorkspaceId } from '../app/session';
import { useQuery } from '../hooks/useQuery';
import { Button, Card, CardBody, CardHeader, Field, Input, Select, Skeleton, Textarea } from '../ui/primitives';
import { EmptyState, ErrorState, PageHeader } from '../ui/states';

export function NewTaskPage() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const repositories = useQuery(`repos:${workspaceId}`, () => api.repositories(workspaceId));
  const [repositoryId, setRepositoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!repositoryId && repositories.data?.repositories[0]) setRepositoryId(repositories.data.repositories[0].id);
  }, [repositoryId, repositories.data]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const task = await api.submitTask(workspaceId, {
        title: title.trim(), description: description.trim(), taskType: 'CODE_PATCH', priority: 'NORMAL', repositoryId, targetBranch: 'main',
      });
      navigate(`/tasks/${task.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  if (repositories.error && !repositories.data) return <><PageHeader title="New engineering task" /><Card><ErrorState error={repositories.error} onRetry={() => void repositories.refetch()} title="Could not load repositories" /></Card></>;
  if (repositories.data && repositories.data.repositories.length === 0) return <>
    <PageHeader title="New engineering task" />
    <Card><EmptyState icon={<FolderGit2 className="h-5 w-5" />} title="Add a repository first"
      description="Patch proposals need a registered local repository and an authorized repository root on the API worker."
      action={<Link to="/repositories"><Button variant="primary">Add a repository</Button></Link>} /></Card>
  </>;

  return <>
    <PageHeader title="New engineering task" description="The worker will create an isolated snapshot and request a patch proposal. It will not modify your registered checkout." />
    <form onSubmit={submit} className="max-w-3xl space-y-5">
      <Card>
        <CardHeader title="Task details" description="Be specific about the behavior and acceptance criteria." />
        <CardBody className="space-y-4">
          {!repositories.data ? <Skeleton className="h-9" /> : <Field label="Repository" htmlFor="task-repository">
            <Select id="task-repository" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
              {repositories.data.repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
            </Select>
          </Field>}
          <Field label="Title" htmlFor="task-title">
            <Input id="task-title" required minLength={3} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add validation to the export endpoint" />
          </Field>
          <Field label="Request" htmlFor="task-description" hint="Provider generated output is validated as a patch. Tests remain marked not run unless an isolated sandbox is configured.">
            <Textarea id="task-description" required minLength={10} maxLength={5000} rows={7} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the change, expected behavior, and relevant constraints." />
          </Field>
          {error && <p role="alert" className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Link to="/tasks"><Button type="button" icon={<ArrowLeft className="h-3.5 w-3.5" />}>Cancel</Button></Link>
            <Button type="submit" variant="primary" loading={saving} disabled={!repositoryId}>Create patch task</Button>
          </div>
        </CardBody>
      </Card>
    </form>
  </>;
}
