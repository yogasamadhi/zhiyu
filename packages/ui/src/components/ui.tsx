import type { ButtonHTMLAttributes, InputHTMLAttributes, PropsWithChildren } from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props} />;
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}

export function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Badge({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: string }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorNotice({ message }: { message?: string | null }) {
  return message ? <div className="notice notice-error">{message}</div> : null;
}
