import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './app/session';
import { ThemeProvider } from './app/theme';
import { AppShell } from './layout/AppShell';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { VerificationsPage } from './pages/VerificationsPage';
import { NewVerificationPage } from './pages/NewVerificationPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { NewTaskPage } from './pages/NewTaskPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { AcceptInvitationPage, ForgotPasswordPage, ResetPasswordPage } from './pages/AccountRecoveryPages';
import { Spinner } from './ui/primitives';

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

/** Pages that need a session (and a workspace); signed-out visitors go to /login. */
function RequireSession({ children }: { children: ReactNode }) {
  const { status, workspace } = useSession();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signed-out') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!workspace) return <FullPageSpinner />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signed-in') return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route element={<RequireSession><AppShell /></RequireSession>}>
        <Route index element={<DashboardPage />} />
        <Route path="runs" element={<VerificationsPage />} />
        <Route path="runs/new" element={<NewVerificationPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/new" element={<NewTaskPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="repositories" element={<RepositoriesPage />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </ThemeProvider>
  );
}
