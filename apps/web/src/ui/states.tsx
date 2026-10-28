import type { ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { errorMessage } from '../api/client';
import { Button, Skeleton, cx } from './primitives';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 rounded-full border border-border bg-surface-2 p-3 text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      <div className="mb-3 rounded-full border border-danger/25 bg-danger/10 p-3 text-danger">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Placeholder rows shown while a list loads. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('divide-y divide-border', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}
