import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './primitives';

/** A modal dialog: Escape and the backdrop close it; focus moves into it when it opens. */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean;
  size?: 'md' | 'lg';
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-lg'} rounded-t-xl border border-border bg-surface shadow-xl sm:rounded-xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<X className="h-4 w-4" />} onClick={onClose} />
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
