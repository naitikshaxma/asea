// Display helpers shared by the pages.

export const shortSha = (sha: string) => sha.slice(0, 7);

export function relativeTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function runDuration(run: { startedAt?: string; completedAt?: string }): string {
  if (!run.startedAt || !run.completedAt) return '—';
  return duration(new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime());
}

export const VERDICT_LABEL: Record<string, string> = {
  ALLOW: 'Allow',
  REVIEW: 'Review',
  HIGH_RISK: 'High risk',
  BLOCK: 'Block',
};

export const VERDICT_HELP: Record<string, string> = {
  ALLOW: 'Safe to merge under this policy.',
  REVIEW: 'Mergeable after a human looks at the findings.',
  HIGH_RISK: 'Significant problems; fix before merging.',
  BLOCK: 'Must not be merged.',
};

export const CATEGORY_LABEL: Record<string, string> = {
  STATIC: 'Static analysis',
  NEGATIVE_SPACE: 'Missing from the change',
  ARCHITECTURE: 'Architecture',
  TEST_GAP: 'Test gaps',
};

export const AGENT_LABEL: Record<string, string> = {
  ingest: 'Ingest',
  static: 'Static analysis',
  negative_space: 'Negative-space agent',
  architecture: 'Architecture agent',
  score: 'Scoring',
  report: 'Reporter',
};

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export const isActive = (status: string) => status === 'QUEUED' || status === 'RUNNING';

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
