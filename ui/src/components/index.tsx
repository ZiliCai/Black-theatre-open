import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, type InputHTMLAttributes } from 'react';
import './components.css';

export { Icon, type IconName } from './Icon';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  on?: 'good' | 'acc' | false;
};
export function Button({ variant = 'default', size = 'md', on = false, className, ...rest }: ButtonProps) {
  return <button type="button" className={cx('c-btn', variant !== 'default' && variant, size !== 'md' && size, on && `on-${on}`, className)} {...rest} />;
}

export type Option<T extends string> = { value: T; label: string };
export function Segmented<T extends string>({ options, value, onChange, wide = false, id }: {
  options: Option<T>[]; value: T; onChange: (v: T) => void; wide?: boolean; id?: string;
}) {
  return (
    <div className={cx('c-seg', wide && 'wide')} id={id} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} data-value={o.value}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('c-field', className)}>
      <span className="c-label"><span>{label}</span>{hint ? <span className="hint">{hint}</span> : null}</span>
      {children}
    </label>
  );
}

export function TextInput({ className, small, ...rest }: InputHTMLAttributes<HTMLInputElement> & { small?: boolean }) {
  return <input className={cx('c-input', small && 'sm', className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('c-textarea', className)} spellCheck={false} {...rest} />;
}

export function Select({ className, small, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { small?: boolean }) {
  return <select className={cx('c-select', small && 'sm', className)} {...rest} />;
}

export function Pill({ tone = 'muted', children, onClick, id }: { tone?: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode; onClick?: () => void; id?: string }) {
  const Tag = onClick ? 'button' : 'span';
  return <Tag id={id} className={cx('c-pill', tone)} onClick={onClick}><span className="dot" />{children}</Tag>;
}

export function Modal({ title, children, actions, onClose, wide = false, id }: { title: ReactNode; children: ReactNode; actions?: ReactNode; onClose: () => void; wide?: boolean; id?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="c-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx('c-modal', wide && 'wide')} role="dialog" aria-modal="true" id={id}>
        <header>{title}</header>
        <div className="body">{children}</div>
        {actions ? <footer>{actions}</footer> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="c-empty">
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

// ---------- toasts ----------
type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'info'; action?: { label: string; run: () => void } };
type ToastApi = (text: string, opts?: { tone?: Toast['tone']; action?: Toast['action']; ms?: number }) => void;
const ToastContext = createContext<ToastApi>(() => {});

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback<ToastApi>((text, opts = {}) => {
    if (!text) return;
    const id = ++seq.current;
    setToasts((all) => [...(all[all.length - 1]?.text === text ? all.slice(0, -1) : all).slice(-2), { id, text, tone: opts.tone || 'info', action: opts.action }]);
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), opts.ms ?? (opts.tone === 'bad' ? 6000 : 3000));
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="c-toasts" id="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={cx('c-toast', t.tone)} role="status">
            <span>{t.text}</span>
            {t.action ? <Button size="sm" onClick={t.action.run}>{t.action.label}</Button> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
