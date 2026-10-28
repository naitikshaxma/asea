import { CheckCircle2, CircleDashed, Loader2, XCircle, Ban } from 'lucide-react';
import { VERDICT_LABEL, titleCase } from '../format';
import { Badge, cx } from './primitives';

type Tone = 'ok' | 'warn' | 'high' | 'danger' | 'info' | 'neutral' | 'accent';

export const VERDICT_TONE: Record<string, Tone> = { ALLOW: 'ok', REVIEW: 'warn', HIGH_RISK: 'high', BLOCK: 'danger' };
export const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: 'danger', HIGH: 'high', MEDIUM: 'warn', LOW: 'info' };
const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  high: 'text-high',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-subtle',
  accent: 'text-accent',
};

export function VerdictBadge({ verdict, className }: { verdict: string | null; className?: string }) {
  if (!verdict) return <Badge className={className}>No verdict</Badge>;
  return (
    <Badge tone={VERDICT_TONE[verdict] ?? 'neutral'} className={cx('uppercase tracking-wide', className)}>
      {VERDICT_LABEL[verdict] ?? verdict}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'} className="uppercase tracking-wide">
      {severity.toLowerCase()}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const icon =
    status === 'RUNNING' ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : status === 'QUEUED' ? (
      <CircleDashed className="h-3 w-3" />
    ) : status === 'COMPLETED' ? (
      <CheckCircle2 className="h-3 w-3" />
    ) : status === 'FAILED' ? (
      <XCircle className="h-3 w-3" />
    ) : (
      <Ban className="h-3 w-3" />
    );
  const tone: Tone = status === 'COMPLETED' ? 'neutral' : status === 'FAILED' ? 'danger' : status === 'CANCELLED' ? 'neutral' : 'accent';
  return (
    <Badge tone={tone}>
      {icon}
      {titleCase(status)}
    </Badge>
  );
}

/** Circular gauge of a 0-100 score, coloured by verdict. */
export function ScoreRing({ score, verdict, size = 120 }: { score: number | null; verdict: string | null; size?: number }) {
  const stroke = Math.max(6, Math.round(size / 13));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = score ?? 0;
  const tone = verdict ? VERDICT_TONE[verdict] ?? 'neutral' : 'neutral';
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={score === null ? 'Not scored yet' : `Score ${score} out of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-surface-2" />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
            className={cx('transition-[stroke-dasharray] duration-700', TONE_TEXT[tone])}
            stroke="currentColor"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-fg">{score === null ? '—' : Math.round(value)}</span>
        <span className="text-2xs uppercase tracking-wider text-subtle">/ 100</span>
      </div>
    </div>
  );
}

export function SeverityDot({ severity }: { severity: string }) {
  const tone = SEVERITY_TONE[severity] ?? 'neutral';
  return <span aria-hidden className={cx('inline-block h-2 w-2 rounded-full bg-current', TONE_TEXT[tone])} />;
}
