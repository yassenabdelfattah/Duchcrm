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
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={cx(
        // min-h-11 keeps every control at a comfortable thumb target on the
        // phones staff actually use at the till.
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
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
      <p className="text-sm text-stone-500">{title}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
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
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-base font-bold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close" className="min-h-9 px-2">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
