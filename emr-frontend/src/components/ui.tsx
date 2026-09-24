import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head"><h2 className="grow">{title}</h2><CloseButton onClick={onClose} /></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const CloseButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="icon-btn" aria-label="დახურვა" onClick={onClick}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
  </button>
);

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return <div className="alert danger" role="alert">{msg}</div>;
}

export const Spinner = () => <div className="spinner" role="status" aria-label="იტვირთება" />;
export const Loading = () => <div className="empty"><Spinner /></div>;

export function Field({ label, htmlFor, required, hint, error, children }: { label: string; htmlFor: string; required?: boolean; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}{required && <span className="req"> *</span>}</label>
      {children}
      {error ? <span className="hint err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export const WarnIcon = ({ color = 'currentColor' }: { color?: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18h.01" />
  </svg>
);

/** მოკლე შეტყობინება ეკრანის კუთხეში */
export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3500); return () => clearTimeout(t); }, [msg]);
  return { show: setMsg, node: msg ? <div className="toast" role="status">{msg}</div> : null };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const STATUS: Record<string, [string, string]> = {
  scheduled: ['info', 'დაჯავშნილი'], confirmed: ['info', 'დადასტურებული'], checked_in: ['warn', 'მოსულია'],
  completed: ['', 'დასრულებული'], cancelled: ['', 'გაუქმებული'], no_show: ['', 'არ გამოცხადდა'],
  planned: ['warn', 'გადასახდელი'], active: ['ok', 'ექიმთან'], discharged: ['', 'დასრულებული'],
  unpaid: ['warn', 'გადაუხდელი'], partially_paid: ['warn', 'ნაწილობრივ'], paid: ['ok', 'გადახდილი'],
  requested: ['info', 'მოთხოვნილი'], in_progress: ['warn', 'მიმდინარე'],
};
export const StatusChip = ({ status }: { status: string }) => {
  const [cls, label] = STATUS[status] ?? ['', status];
  return <span className={`chip ${cls}`}>{label}</span>;
};
