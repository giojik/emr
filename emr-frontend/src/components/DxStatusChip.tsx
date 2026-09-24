import { DX_STATUS, FLAG_UI } from '../lib/format';
export const DxStatusChip = ({ status }: { status: string }) => { const [c, l] = DX_STATUS[status] ?? ['', status]; return <span className={`chip ${c}`}>{l}</span>; };
export const FlagBadge = ({ flag }: { flag: string | null }) => {
  if (!flag || flag === 'N') return null;
  const f = FLAG_UI[flag]; return <span className={`chip ${f.cls}`} title={f.label} style={{ height: 20, padding: '0 6px' }}>{f.sym} {f.label}</span>;
};
