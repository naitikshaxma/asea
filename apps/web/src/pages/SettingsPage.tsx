import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Github, Monitor, Moon, Sun } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useSession } from '../app/session';
import { useTheme, type ThemePreference } from '../app/theme';
import { useQuery } from '../hooks/useQuery';
import { Badge, Button, Card, CardBody, CardHeader, CopyButton, Field, Input, Mono, Select, Skeleton, cx } from '../ui/primitives';
import { ErrorState, PageHeader } from '../ui/states';

const THEMES: Array<[ThemePreference, string, typeof Sun]> = [
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
  ['system', 'System', Monitor],
];

export function SettingsPage() {
  const { user, workspace, refresh } = useSession();
  const { preference, setPreference } = useTheme();
  const isAdmin = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const [name, setName] = useState(workspace?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const githubApp = useQuery(workspace ? `github-app:${workspace.id}` : null, () => api.githubApp(workspace!.id));
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [githubInstallSelection, setGithubInstallSelection] = useState<{ token: string; installations: Array<{ installationId: string; accountLogin: string; accountType: string }> } | null>(null);
  const [selectedGithubInstallationId, setSelectedGithubInstallationId] = useState('');
  const callbackHandled = useRef(false);
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get('installation_id');
    const state = params.get('state');
    const code = params.get('code');
    const setupAction = params.get('setup_action');
    if (setupAction === 'request') {
      setGithubMessage('GitHub sent an installation request for approval. Link the installation after a GitHub organization owner completes the request.');
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('state');
      cleanUrl.searchParams.delete('setup_action');
      window.history.replaceState({}, '', cleanUrl);
      callbackHandled.current = true;
      return;
    }
    if (state && !code && !callbackHandled.current) {
      callbackHandled.current = true;
      setGithubMessage('GitHub did not return the user authorization code. Enable user authorization during installation and try again.');
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('installation_id');
      cleanUrl.searchParams.delete('state');
      cleanUrl.searchParams.delete('setup_action');
      window.history.replaceState({}, '', cleanUrl);
      return;
    }
    if (!workspace || !state || !code || callbackHandled.current) return;
    callbackHandled.current = true;
    setGithubBusy(true);
    setGithubMessage(null);
    void api.completeGithubAppInstallation(workspace.id, installationId ?? undefined, state, code)
      .then((result) => {
        if (result.selectionRequired) {
          setGithubInstallSelection({ token: result.selectionToken, installations: result.installations });
          setSelectedGithubInstallationId(result.installations[0]?.installationId ?? '');
          setGithubMessage('Choose the GitHub installation to connect to this workspace.');
        } else {
          setGithubInstallSelection(null);
          setGithubMessage('GitHub App installation connected to this workspace.');
          void githubApp.refetch();
        }
      })
      .catch((error) => setGithubMessage(errorMessage(error)))
      .finally(() => {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('installation_id');
        cleanUrl.searchParams.delete('state');
        cleanUrl.searchParams.delete('setup_action');
        cleanUrl.searchParams.delete('code');
        window.history.replaceState({}, '', cleanUrl);
        setGithubBusy(false);
      });
  }, [workspace?.id]);

  const installGithubApp = async () => {
    if (!workspace) return;
    setGithubBusy(true);
    setGithubMessage(null);
    try {
      const result = await api.githubAppInstallUrl(workspace.id);
      window.location.assign(result.url);
    } catch (error) {
      setGithubMessage(errorMessage(error));
      setGithubBusy(false);
    }
  };

  const selectGithubInstallation = async () => {
    if (!workspace || !githubInstallSelection || !selectedGithubInstallationId) return;
    setGithubBusy(true);
    setGithubMessage(null);
    try {
      await api.selectGithubAppInstallation(workspace.id, githubInstallSelection.token, selectedGithubInstallationId);
      setGithubInstallSelection(null);
      setGithubMessage('GitHub App installation connected to this workspace.');
      await githubApp.refetch();
    } catch (error) { setGithubMessage(errorMessage(error)); }
    finally { setGithubBusy(false); }
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.renameWorkspace(workspace.id, name);
      await refresh();
      setMessage({ ok: true, text: 'Workspace renamed.' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Your account, this workspace, and how the server is wired." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <CardBody className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted">Name</span>
              <span>{user?.displayName}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted">Email</span>
              <span>{user?.email}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted">Role in this workspace</span>
              <Badge>{workspace?.role?.toLowerCase() ?? '—'}</Badge>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Workspace" description={isAdmin ? undefined : 'Only owners and admins can rename the workspace.'} />
          <CardBody>
            <form onSubmit={rename} className="space-y-3">
              <Field label="Workspace name" htmlFor="workspace-name">
                <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} required minLength={2} maxLength={100} />
              </Field>
              {message && (
                <p role="status" className={cx('text-xs', message.ok ? 'text-ok' : 'text-danger')}>
                  {message.text}
                </p>
              )}
              {isAdmin && (
                <Button type="submit" size="sm" loading={saving} disabled={!name.trim() || name === workspace?.name}>
                  Rename
                </Button>
              )}
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Appearance" />
          <CardBody>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
              {THEMES.map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={preference === value}
                  onClick={() => setPreference(value)}
                  className={cx(
                    'flex flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-xs transition-colors',
                    preference === value ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:bg-surface-2'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </CardBody>
        </Card>

        {workspace && <WorkspaceMembersCard workspaceId={workspace.id} role={workspace.role ?? 'MEMBER'} />}
        <PasswordSecurityCard />

        <Card>
          <CardHeader title="GitHub App" description="Connect a least-privilege installation to choose repositories and publish approved patches." />
          {githubApp.error && !githubApp.data ? <ErrorState error={githubApp.error} onRetry={() => void githubApp.refetch()} title="Could not load GitHub App status" /> :
            !githubApp.data ? <CardBody className="text-sm text-muted">Loading GitHub App configuration…</CardBody> : (
              <CardBody className="space-y-3">
                {!githubApp.data.configured ? <p className="text-sm text-muted">The server has not configured a GitHub App. Set GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET, then restart the API.</p> : <>
                  <div className="space-y-2">
                    {githubApp.data.installations.length === 0 ? <p className="text-sm text-muted">No installation is linked to this workspace.</p> : githubApp.data.installations.map((installation) => (
                      <div key={installation.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2"><Github className="h-4 w-4 shrink-0 text-muted" /><span className="truncate">{installation.accountLogin}</span></span>
                        <Badge>{installation.accountType.toLowerCase()}</Badge>
                      </div>
                    ))}
                  </div>
                  {githubInstallSelection && <div className="space-y-2 rounded-md border border-border p-3">
                    <Field label="Installation to connect" htmlFor="github-installation-choice">
                      <Select id="github-installation-choice" value={selectedGithubInstallationId} onChange={(event) => setSelectedGithubInstallationId(event.target.value)}>
                        {githubInstallSelection.installations.map((installation) => <option key={installation.installationId} value={installation.installationId}>{installation.accountLogin} ({installation.accountType})</option>)}
                      </Select>
                    </Field>
                    <Button size="sm" variant="primary" loading={githubBusy} disabled={!selectedGithubInstallationId} onClick={() => void selectGithubInstallation()}>Connect selected installation</Button>
                  </div>}
                  {isAdmin && <Button size="sm" variant="primary" icon={<Github className="h-3.5 w-3.5" />} loading={githubBusy} onClick={() => void installGithubApp()}>
                    {githubApp.data.installations.length ? 'Add GitHub installation' : 'Install GitHub App'}
                  </Button>}
                </>}
                {githubBusy && new URLSearchParams(window.location.search).has('installation_id') && <p className="text-xs text-muted">Confirming the GitHub installation…</p>}
                {githubMessage && <p role="status" className="text-xs text-muted">{githubMessage}</p>}
              </CardBody>
            )}
        </Card>

        <SystemCard />
      </div>
    </>
  );
}

function WorkspaceMembersCard({ workspaceId, role }: { workspaceId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }) {
  const isOwner = role === 'OWNER';
  const canAdminister = isOwner || role === 'ADMIN';
  const members = useQuery(`members:${workspaceId}`, () => api.workspaceMembers(workspaceId));
  const invitations = useQuery(canAdminister ? `invitations:${workspaceId}` : null, () => api.workspaceInvitations(workspaceId));
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('invite');
    setNotice(null);
    try {
      await api.inviteWorkspaceMember(workspaceId, email, isOwner ? inviteRole : 'MEMBER');
      setEmail('');
      setNotice({ ok: true, text: 'Invitation created. The development mailbox is available only when configured on the API.' });
      await invitations.refetch();
    } catch (error) { setNotice({ ok: false, text: errorMessage(error) }); }
    finally { setBusy(null); }
  };

  const changeRole = async (membershipId: string, nextRole: 'ADMIN' | 'MEMBER') => {
    setBusy(membershipId);
    setNotice(null);
    try {
      await api.updateWorkspaceMemberRole(workspaceId, membershipId, nextRole);
      await members.refetch();
      setNotice({ ok: true, text: 'Member role updated.' });
    } catch (error) { setNotice({ ok: false, text: errorMessage(error) }); }
    finally { setBusy(null); }
  };

  const removeMember = async (membershipId: string) => {
    setBusy(membershipId);
    setNotice(null);
    try {
      await api.removeWorkspaceMember(workspaceId, membershipId);
      await members.refetch();
      setNotice({ ok: true, text: 'Member removed.' });
    } catch (error) { setNotice({ ok: false, text: errorMessage(error) }); }
    finally { setBusy(null); }
  };

  const revokeInvitation = async (invitationId: string) => {
    setBusy(invitationId);
    setNotice(null);
    try {
      await api.revokeWorkspaceInvitation(workspaceId, invitationId);
      await invitations.refetch();
      setNotice({ ok: true, text: 'Invitation revoked.' });
    } catch (error) { setNotice({ ok: false, text: errorMessage(error) }); }
    finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader title="Workspace members" description={canAdminister ? 'Manage access and pending invitations.' : 'Members in this workspace.'} />
      <CardBody className="space-y-4">
        {members.error ? <ErrorState error={members.error} onRetry={() => void members.refetch()} title="Could not load members" /> : !members.data ? <p className="text-sm text-muted">Loading members…</p> : (
          <div className="space-y-2">
            {members.data.members.map((member) => (
              <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <div className="min-w-0"><p className="truncate font-medium">{member.displayName}</p><p className="truncate text-xs text-muted">{member.email}</p></div>
                <div className="flex items-center gap-2">
                  {isOwner && member.role !== 'OWNER' ? (
                    <Select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy === member.id} onChange={(event) => void changeRole(member.id, event.target.value as 'ADMIN' | 'MEMBER')}>
                      <option value="MEMBER">Member</option><option value="ADMIN">Admin</option>
                    </Select>
                  ) : <Badge>{member.role.toLowerCase()}</Badge>}
                  {canAdminister && member.role !== 'OWNER' && (isOwner || member.role === 'MEMBER') && (
                    <Button size="sm" variant="danger" loading={busy === member.id} onClick={() => void removeMember(member.id)}>Remove</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {canAdminister && <>
          <form onSubmit={(event) => void invite(event)} className="space-y-2 border-t border-border pt-4">
            <Field label="Invite by email" htmlFor="member-invite-email">
              <Input id="member-invite-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            {isOwner && <Field label="Workspace role" htmlFor="member-invite-role"><Select id="member-invite-role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'ADMIN' | 'MEMBER')}><option value="MEMBER">Member</option><option value="ADMIN">Admin</option></Select></Field>}
            <Button size="sm" variant="primary" type="submit" loading={busy === 'invite'} disabled={!email.trim()}>Create invitation</Button>
          </form>
          {invitations.data && <div className="space-y-2 border-t border-border pt-4">
            <h3 className="text-xs font-semibold">Invitations</h3>
            {invitations.data.invitations.length === 0 ? <p className="text-xs text-muted">No invitations yet.</p> : invitations.data.invitations.map((invitation) => (
              <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>{invitation.email} · {invitation.role.toLowerCase()} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</span>
                {!invitation.acceptedAt && !invitation.revokedAt && <Button size="sm" variant="ghost" loading={busy === invitation.id} onClick={() => void revokeInvitation(invitation.id)}>Revoke</Button>}
              </div>
            ))}
          </div>}
        </>}
        {notice && <p role="status" className={cx('text-xs', notice.ok ? 'text-ok' : 'text-danger')}>{notice.text}</p>}
      </CardBody>
    </Card>
  );
}

function PasswordSecurityCard() {
  const { signOut } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setNotice({ ok: true, text: result.message });
      await signOut();
    } catch (error) { setNotice({ ok: false, text: errorMessage(error) }); }
    finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Password" description="Changing your password revokes existing sessions." />
      <CardBody>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <Field label="Current password" htmlFor="current-password"><Input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Field>
          <Field label="New password" htmlFor="new-password" hint="At least 8 characters."><Input id="new-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field>
          <Button size="sm" type="submit" loading={busy}>Change password</Button>
          {notice && <p role="status" className={cx('text-xs', notice.ok ? 'text-ok' : 'text-danger')}>{notice.text}</p>}
        </form>
      </CardBody>
    </Card>
  );
}

function SystemCard() {
  const status = useQuery('system-status', () => api.systemStatus());
  const data = status.data;
  return (
    <Card>
      <CardHeader title="System" description="Read from the server's configuration and the engine's readiness probe." />
      {status.error ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : !data ? (
        <CardBody className="space-y-2">
          <Skeleton />
          <Skeleton className="w-2/3" />
        </CardBody>
      ) : (
        <CardBody className="space-y-3 text-sm">
          <Item label="Verification engine">
            <Badge tone={data.engine.status === 'up' ? 'ok' : 'danger'}>{data.engine.status === 'up' ? 'online' : 'unreachable'}</Badge>
          </Item>
          {data.engine.llm && (
            <Item label="LLM provider">
              <span className="text-right text-xs">{data.engine.llm.message ?? data.engine.llm.status}</span>
            </Item>
          )}
          {data.engine.codeIndex && (
            <Item label="Code index">
              <span className="text-right text-xs">{data.engine.codeIndex.message ?? data.engine.codeIndex.status}</span>
            </Item>
          )}
          <Item label="Sandbox execution">
            <span className="text-right text-xs" title={data.sandbox.message}>
              {data.sandbox.provider} · {data.sandbox.status.replace(/_/g, ' ').toLowerCase()}
              {data.sandbox.image ? ` · ${data.sandbox.image}` : ''}
            </span>
          </Item>
          <Item label="GitHub PR comments">
            <Badge tone={data.github.commentsEnabled ? 'ok' : 'neutral'}>{data.github.commentsEnabled ? 'enabled' : 'off (no GITHUB_TOKEN)'}</Badge>
          </Item>
          <Item label="Webhook URL">
            <span className="flex min-w-0 items-center gap-1">
              <Mono className="truncate text-2xs">{data.webhookUrl}</Mono>
              <CopyButton value={data.webhookUrl} label="Copy webhook URL" />
            </span>
          </Item>
        </CardBody>
      )}
    </Card>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="shrink-0 text-muted">{label}</span>
      {children}
    </div>
  );
}
