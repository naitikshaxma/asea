import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent/90 shadow-sm',
  secondary: 'bg-surface text-fg border border-border hover:bg-surface-2 shadow-sm',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:bg-danger/90 shadow-sm',
};
const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx('rounded-lg border border-border bg-surface shadow-sm', className)}>{children}</section>;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('p-4', className)}>{children}</div>;
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'high' | 'danger' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent border-accent/20',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  high: 'bg-high/10 text-high border-high/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  info: 'bg-info/10 text-info border-info/25',
};

export function Badge({ tone = 'neutral', className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

const FIELD = 'block w-full rounded-md border border-border bg-surface px-3 text-sm text-fg placeholder:text-subtle shadow-sm transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(FIELD, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(FIELD, 'py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(FIELD, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton h-4', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-label="Loading" className={cx('h-4 w-4 animate-spin text-muted', className)} />;
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code title={title} className={cx('rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.75rem] text-fg', className)}>
      {children}
    </code>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      icon={copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked; the value stays visible to copy by hand
        }
      }}
    />
  );
}
