import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useSession } from '../app/session';
import { Button, Card, CardBody, CardHeader, Field, Input } from '../ui/primitives';

const RESET_TOKEN_KEY = 'asea-password-reset-token';
const INVITE_TOKEN_KEY = 'asea-workspace-invite-token';
const INVITE_WORKSPACE_KEY = 'asea-workspace-invite-workspace';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api.requestPasswordReset(email); setSent(true); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <AccountCard title="Reset password">
    {sent ? <p role="status" className="text-sm text-muted">If the account can receive a reset link, one has been sent.</p> : <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <Field label="Email" htmlFor="reset-email"><Input id="reset-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" loading={busy} className="w-full">Send reset link</Button>
    </form>}
    <p className="mt-4 text-sm text-muted"><Link to="/login" className="text-accent hover:underline">Return to sign in</Link></p>
  </AccountCard>;
}

export function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = params.get('token');
    if (fragmentToken) {
      sessionStorage.setItem(RESET_TOKEN_KEY, fragmentToken);
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
    }
    setToken(fragmentToken ?? sessionStorage.getItem(RESET_TOKEN_KEY) ?? '');
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api.completePasswordReset(token, password);
      sessionStorage.removeItem(RESET_TOKEN_KEY);
      setDone(true);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <AccountCard title="Choose a new password">
    {done ? <><p role="status" className="text-sm text-ok">Password reset complete.</p><Link to="/login" className="mt-4 inline-block text-sm text-accent hover:underline">Sign in</Link></> : !token ? <p role="alert" className="text-sm text-danger">This reset link is missing or expired. Request a new one.</p> : <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <Field label="New password" htmlFor="reset-new-password" hint="At least 8 characters."><Input id="reset-new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" loading={busy} className="w-full">Reset password</Button>
    </form>}
  </AccountCard>;
}

export function AcceptInvitationPage() {
  const { status, refresh, selectWorkspace } = useSession();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = params.get('token');
    const fragmentWorkspace = params.get('workspaceId');
    if (fragmentToken) {
      sessionStorage.setItem(INVITE_TOKEN_KEY, fragmentToken);
      if (fragmentWorkspace) sessionStorage.setItem(INVITE_WORKSPACE_KEY, fragmentWorkspace);
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
    }
    setToken(fragmentToken ?? sessionStorage.getItem(INVITE_TOKEN_KEY) ?? '');
    setWorkspaceId(fragmentWorkspace ?? sessionStorage.getItem(INVITE_WORKSPACE_KEY) ?? '');
  }, []);
  const accept = async () => {
    if (!token || !workspaceId) return;
    setBusy(true); setMessage(null);
    try {
      await api.acceptWorkspaceInvitation(workspaceId, token);
      sessionStorage.removeItem(INVITE_TOKEN_KEY);
      sessionStorage.removeItem(INVITE_WORKSPACE_KEY);
      await refresh();
      selectWorkspace(workspaceId);
      navigate('/', { replace: true });
    } catch (err) { setMessage(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <AccountCard title="Accept workspace invitation">
    {!token || !workspaceId ? <p role="alert" className="text-sm text-danger">This invitation link is missing or invalid.</p> : status === 'loading' ? <p className="text-sm text-muted">Checking your session…</p> : status === 'signed-out' ? <div className="space-y-3 text-sm text-muted"><p>Sign in or create an account using the invited email address to accept this invitation.</p><Link to="/login" state={{ from: '/accept-invitation' }} className="block text-accent hover:underline">Sign in</Link><Link to="/register" state={{ from: '/accept-invitation' }} className="block text-accent hover:underline">Create an account</Link></div> : <div className="space-y-3"><p className="text-sm text-muted">Accept this invitation with your signed-in account.</p><Button variant="primary" loading={busy} onClick={() => void accept()}>Accept invitation</Button></div>}
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </AccountCard>;
}

function AccountCard({ title, children }: { title: string; children: ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-4"><Card className="w-full max-w-md"><CardHeader title={title} /><CardBody>{children}</CardBody></Card></div>;
}
