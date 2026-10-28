import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FileSearch, GitPullRequest, ShieldCheck, Scale } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useSession } from '../app/session';
import { Button, Field, Input } from '../ui/primitives';

const POINTS = [
  { icon: FileSearch, text: 'Static analysis and AI agents check each change against its requirement' },
  { icon: Scale, text: 'A deterministic score and verdict under your policy, with the reasons' },
  { icon: GitPullRequest, text: 'Results posted on GitHub pull requests' },
];

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const register = mode === 'register';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (register) await api.register({ email, password, displayName });
      else await api.login({ email, password });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r border-border bg-surface p-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">ASEA</span>
        </div>
        <div className="max-w-md space-y-6">
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Know whether a change is safe to merge, and why.</h2>
          <ul className="space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3 text-sm text-muted">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-subtle">Every verification is recorded in a hash-chained audit trail you can check.</p>
      </div>

      <div className="flex items-center justify-center px-4 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5" aria-label={register ? 'Create account' : 'Sign in'}>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{register ? 'Create your account' : 'Sign in to ASEA'}</h1>
            <p className="mt-1 text-sm text-muted">
              {register ? 'You get a workspace to verify your repositories in.' : 'Welcome back.'}
            </p>
          </div>
          {register && (
            <Field label="Name" htmlFor="displayName">
              <Input id="displayName" autoComplete="name" required minLength={2} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
          )}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password" hint={register ? 'At least 8 characters.' : undefined}>
            <Input
              id="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={register ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={submitting}>
            {register ? 'Create account' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-muted">
            {register ? 'Already have an account? ' : 'New to ASEA? '}
            <Link className="font-medium text-accent hover:underline" to={register ? '/login' : '/register'}>
              {register ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
          {!register && <p className="text-center text-sm"><Link className="text-accent hover:underline" to="/forgot-password">Forgot your password?</Link></p>}
        </form>
      </div>
    </div>
  );
}
