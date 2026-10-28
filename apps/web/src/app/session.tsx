import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserProfile, WorkspaceResponse } from '@autonomous-engineer/contracts';
import { ApiError, api } from '../api/client';

const WORKSPACE_KEY = 'asea-workspace';

interface SessionContextValue {
  status: 'loading' | 'signed-out' | 'signed-in';
  user: UserProfile | null;
  workspaces: WorkspaceResponse[];
  workspace: WorkspaceResponse | null;
  selectWorkspace: (workspaceId: string) => void;
  /** Reloads the user and workspaces from /auth/me (after login, rename, ...). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function savedWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionContextValue['status']>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(savedWorkspaceId);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setWorkspaces(me.workspaces);
      setStatus('signed-in');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        setUser(null);
        setWorkspaces([]);
        setStatus('signed-out');
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setStatus('signed-out'));
  }, [refresh]);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    try {
      localStorage.setItem(WORKSPACE_KEY, id);
    } catch {
      // not persisted; fine for this tab
    }
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setWorkspaces([]);
    setStatus('signed-out');
  }, []);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null,
    [workspaces, workspaceId]
  );

  return (
    <SessionContext.Provider value={{ status, user, workspaces, workspace, selectWorkspace, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/** The active workspace's id; pages under the signed-in layout always have one. */
export function useWorkspaceId(): string {
  const { workspace } = useSession();
  if (!workspace) throw new Error('No active workspace');
  return workspace.id;
}
