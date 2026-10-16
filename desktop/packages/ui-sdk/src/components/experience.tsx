import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { X, ChevronDown, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from './ui.js';

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input ${className}`} {...props} />;
}
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <span id={`${id}-label`}>{label}</span>
      {Children.map(children, (child, index) => {
        if (
          !isValidElement(child) ||
          ![Input, Select, 'input', 'select', 'textarea'].includes(child.type as typeof Input)
        )
          return child;
        return cloneElement(child as ReactElement<Record<string, unknown>>, {
          id: `${id}-${index}`,
          'aria-labelledby': (child.props as Record<string, unknown>)['aria-label']
            ? undefined
            : `${id}-label`,
          'aria-describedby':
            [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') ||
            undefined,
          'aria-invalid': Boolean(error),
        });
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <small id={`${id}-error`} className="field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
export function Skeleton({ lines = 3 }: { lines?: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('ux.loading')} className="skeleton-group">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
export function Stepper({
  steps,
  current,
  onChange,
}: {
  steps: string[];
  current: number;
  onChange: (step: number) => void;
}) {
  return (
    <ol className="stepper">
      {steps.map((step, index) => (
        <li key={step} aria-current={index === current ? 'step' : undefined}>
          <button type="button" onClick={() => onChange(index)}>
            <span className="step-number">{index + 1}</span>
            <span>{step}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useTranslation();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
    return () => {
      if (el.open) el.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <div className="section-heading">
          <h2 id={titleId}>{title}</h2>
          <Button className="button-ghost" aria-label={t('ux.close')} onClick={onClose}>
            <X size={18} />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details
      ref={ref}
      className="menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (ref.current) {
            ref.current.open = false;
            ref.current.querySelector('summary')?.focus();
          }
        }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          if (ref.current) ref.current.open = true;
          const items = Array.from(
            ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a') ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
          items[
            (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
          ]?.focus();
        }
      }}
    >
      <summary className="button button-secondary">
        {label}
        <ChevronDown size={16} />
      </summary>
      <div
        className="menu-panel"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button,a') && ref.current)
            ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function StatusNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="status">
      <AlertCircle size={18} />
      {children}
    </div>
  );
}
