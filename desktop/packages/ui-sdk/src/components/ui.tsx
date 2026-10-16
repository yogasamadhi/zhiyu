import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  HTMLAttributes,
  PropsWithChildren,
} from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCw } from 'lucide-react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`button ${className}`} {...props} />;
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}

export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card ${className}`} {...props}>
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: string }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorNotice({
  message,
  onRetry,
}: {
  message?: string | null | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return message ? (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          <RotateCw size={16} aria-hidden="true" /> {t('ux.retry')}
        </button>
      )}
    </div>
  ) : null;
}
