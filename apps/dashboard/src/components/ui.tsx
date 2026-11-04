import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-duch-ink text-white hover:bg-black disabled:bg-stone-400',
  secondary: 'bg-white text-duch-ink border border-duch-line hover:bg-stone-50',
  ghost: 'bg-transparent text-stone-600 hover:bg-stone-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export function Button({
  variant = 'primary',
  className,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        // min-h-11 keeps every control at a comfortable thumb target on the
        // phones staff actually use at the till.
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold',
        'transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-duch-accent',
        BUTTON_STYLES[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// React 19 passes `ref` to function components as an ordinary prop, so no
// forwardRef wrapper is needed - it just has to be declared for TypeScript.
export function Input({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cx(
        'min-h-11 w-full rounded-lg border border-duch-line bg-white px-3 text-sm',
        'placeholder:text-stone-400',
        'focus:border-duch-accent focus:outline-none focus:ring-2 focus:ring-duch-accent/20',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'min-h-11 w-full rounded-lg border border-duch-line bg-white px-3 text-sm',
        'focus:border-duch-accent focus:outline-none focus:ring-2 focus:ring-duch-accent/20',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-stone-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-stone-500">{hint}</span> : null}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('rounded-xl border border-duch-line bg-white p-4 shadow-sm', className)}>
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const BADGE_STYLES: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  good: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  bad: 'bg-red-50 text-red-700',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        BADGE_STYLES[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * Where something stands, in one of five meanings used the same way on every
 * screen: waiting on us, on the road, done, a problem, closed.
 */
export type StatusTone = 'wait' | 'road' | 'done' | 'back' | 'closed';

const STATUS_STYLES: Record<StatusTone, string> = {
  wait: 'bg-amber-50 text-amber-800',
  road: 'bg-blue-50 text-blue-700',
  done: 'bg-emerald-50 text-emerald-700',
  back: 'bg-red-50 text-red-700',
  closed: 'bg-stone-100 text-stone-600',
};

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold',
        STATUS_STYLES[tone],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

/** An order number, SKU or shipment number: fixed-width and always left to right. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx('font-mono tracking-tight', className)}>
      {children}
    </bdi>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-8 text-sm text-stone-500" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-stone-300 border-t-duch-ink" />
      {label}
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-duch-line p-10 text-center">
      <Inbox className="mx-auto mb-3 size-8 text-stone-300" aria-hidden="true" />
      <p className="text-sm text-stone-500">{title}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** A gray bar holding a line of text's place while it loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-stone-200/80', className)} aria-hidden="true" />;
}

/**
 * Card-shaped rows holding a list's place, so the screen keeps its shape
 * while it loads instead of collapsing to a spinner and jumping back.
 */
export function ListSkeleton({ rows = 6, label }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-xl border border-duch-line bg-white p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="ms-auto h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
      {children}
    </p>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escape closes, same as the ✕. The backdrop deliberately does not: a
  // stray tap must not throw away a half-filled check-in form.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      {/*
        Capped in height with the body scrolling inside it. A return check-in
        for a multi-item parcel is taller than a phone screen, and without this
        the confirm button sits below the fold with no way to reach it - the
        packer can fill the whole form in and not be able to submit it.
        The title stays put so it is always clear what is being confirmed.
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-rise-in flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:max-h-[85dvh] sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-duch-line p-5 pb-3">
          <h2 className="text-base font-bold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close" className="min-h-9 px-2">
            ✕
          </Button>
        </div>
        <div className="overflow-y-auto overscroll-contain p-5">{children}</div>
      </div>
    </div>
  );
}

// --- Toasts ------------------------------------------------------------------------------------
//
// One way to say "done" on every screen: toast(t('...')) after the action
// lands, and a floating note appears for a few seconds where the thumb is not.
// Errors stay inline next to what failed (ErrorNote) - they must not vanish.

interface ToastItem {
  id: number;
  text: string;
}

let nextToastId = 1;
let pushToast: ((text: string) => void) | null = null;

/** Show a short success note. Safe to call from anywhere; no-op before the Layout mounts. */
export function toast(text: string) {
  pushToast?.(text);
}

/** The single host for toast(); the Layout mounts it once. */
export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    pushToast = (text) => {
      const id = nextToastId++;
      // At most three on screen, the oldest giving way.
      setItems((current) => [...current.slice(-2), { id, text }]);
      setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4000);
    };
    return () => {
      pushToast = null;
    };
  }, []);

  return (
    // Above the phone tab bar, under the thumb line on desktop.
    <div
      aria-live="polite"
      className="no-print pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="animate-rise-in flex max-w-full items-center gap-2 rounded-full bg-duch-ink px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
          <span className="truncate">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
