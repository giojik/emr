import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../../components/ui';
import { tsDate, unitFmt } from '../../../lib/format';
import { criteria, fromRow, rangeAgeText, RangesEditor, rowErrors, toRow, useLabMethods, useLabPermissions, valueText, type NormRange, type RangeRow } from './common';

interface NormAnalyte {
  id: string; code: string; name: string; unit: string; result_type: 'numeric' | 'text' | 'select'; critical_low: string | null; critical_high: string | null;
  norm_version: number; service_id: string; service_name: string; service_code: string; group_name: string; service_active: boolean;
  changed_at: string | null; last_reason: string | null; changed_by_name: string | null; ranges: NormRange[]; gaps: string[];
}
interface NormVersion { version: number; ranges: NormRange[]; critical_low: string | null; critical_high: string | null; unit: string; reason: string; changed_at: string; recalculated: number; changed_by_name: string | null }
interface NormHistory { id: string; name: string; code: string; unit: string; result_type: string; norm_version: number; service_name: string; versions: NormVersion[] }

/** ნორმები: ყველა კომპონენტი ერთ ცხრილში; შეცვლა — ლაბორატორიის ხელმძღვანელი, მიზეზით; ისტორია */
export default function Norms() {
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 250);
  const [group, setGroup] = useState(''); const [onlyGaps, setOnlyGaps] = useState(false);
  const [open, setOpen] = useState<NormAnalyte | null>(null);
  const perm = useLabPermissions(); const methods = useLabMethods(true);
  const q = useQuery({ queryKey: ['lab-norms', ds, group], queryFn: () => api<NormAnalyte[]>('/lab/norms', { query: { search: ds, group } }) });
  const groups = useQuery({ queryKey: ['dx-groups', 'lab'], queryFn: () => api<string[]>('/dx/catalog/groups', { query: { section: 'lab' } }) });
  const mName = (id: string) => methods.data?.find((m) => m.id === id)?.name ?? 'ანალიზატორი';
  const rows = (q.data ?? []).filter((a) => !onlyGaps || a.gaps.length);
  const gapCount = q.data?.filter((a) => a.gaps.length).length ?? 0;
  let lastService = '';
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 300, height: 38 }} placeholder="კომპონენტი, ანალიზი ან კოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="ჯგუფი" className="select" style={{ maxWidth: 220, height: 38 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">ყველა ჯგუფი</option>{groups.data?.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <label className="row small"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> მხოლოდ დაუფარავი ასაკებით ({gapCount})</label>
        <span className="hint grow" style={{ textAlign: 'right' }}>{perm.data?.norms ? 'კომპონენტზე დაჭერით — ნორმების შეცვლა და ისტორია' : 'ნორმებს ცვლის ლაბორატორიის ხელმძღვანელი; აქ — ნახვა და ისტორია'}</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !rows.length ? <div className="card empty">სია ცარიელია.</div> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>კომპონენტი</th><th>ერთეული</th><th>ნორმები</th><th>კრიტიკული</th><th>ვერსია</th></tr></thead>
            <tbody>{rows.map((a) => {
              const head = a.service_id !== lastService; lastService = a.service_id;
              return [
                head && <tr key={`s-${a.service_id}`}><td colSpan={5} style={{ background: 'var(--bg)', fontWeight: 600 }}>{a.service_name} <span className="small muted mono">{a.service_code} · {a.group_name}</span>{!a.service_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}</td></tr>,
                <tr key={a.id} className="clickable" onClick={() => setOpen(a)}>
                  <td><strong>{a.name}</strong> <span className="mono small muted">{a.code}</span>
                    {a.gaps.length > 0 && <div className="small" style={{ color: 'var(--warn-ink)' }}>დაუფარავი: {a.gaps.join('; ')}</div>}</td>
                  <td className="small">{unitFmt(a.unit)}</td>
                  <td className="small">{a.ranges.length ? a.ranges.map((r, i) => <div key={i}><span className="muted">{criteria(r, mName)} · {rangeAgeText(r)}:</span> <strong>{valueText(r)}</strong></div>) : <span className="chip warn">ნორმა არ არის</span>}</td>
                  <td className="small mono">{a.critical_low ?? ''}{a.critical_low || a.critical_high ? ' / ' : '—'}{a.critical_high ?? ''}</td>
                  <td className="small">v{a.norm_version}{a.changed_at && <div className="muted">{tsDate(a.changed_at)}{a.changed_by_name ? ` · ${a.changed_by_name}` : ''}</div>}</td>
                </tr>,
              ];
            })}</tbody>
          </table>
        </div>
      )}
      {open && <NormDialog a={open} canEdit={!!perm.data?.norms} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NormDialog({ a, canEdit, onClose }: { a: NormAnalyte; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const methods = useLabMethods(true);
  const [tab, setTab] = useState<'edit' | 'history'>(canEdit ? 'edit' : 'history');
  const numeric = a.result_type === 'numeric';
  const [rows, setRows] = useState<RangeRow[]>(() => a.ranges.map(toRow));
  const [cl, setCl] = useState(a.critical_low === null ? '' : String(Number(a.critical_low)));
  const [ch, setCh] = useState(a.critical_high === null ? '' : String(Number(a.critical_high)));
  const [reason, setReason] = useState('');
  const hist = useQuery({ queryKey: ['norm-history', a.id], queryFn: () => api<NormHistory>(`/lab/analytes/${a.id}/norm-history`), enabled: tab === 'history' });
  const errs = useMemo(() => rowErrors(rows, numeric), [rows, numeric]);
  const save = useMutation({
    mutationFn: () => api<{ version: number; recalculated: number }>(`/lab/analytes/${a.id}/norms`, { method: 'PUT', body: {
      ranges: rows.map((r) => fromRow(r, numeric)), reason: reason.trim(),
      ...(numeric ? { critical_low: cl.trim() === '' ? null : Number(cl.replace(',', '.')), critical_high: ch.trim() === '' ? null : Number(ch.replace(',', '.')) } : {}),
    } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['lab-norms'] }); void qc.invalidateQueries({ queryKey: ['norm-history', a.id] }); void qc.invalidateQueries({ queryKey: ['dx-service'] });
      toast.show(`შენახულია — ვერსია ${r.version}${r.recalculated ? `; ${r.recalculated} დაუმტკიცებელი შედეგი გადაითვალა` : ''}`);
      setReason(''); setTab('history');
    },
  });
  const mName = (id: string) => methods.data?.find((m) => m.id === id)?.name ?? 'ანალიზატორი';
  return (
    <Modal title={`${a.name} — ${a.service_name}`} onClose={onClose} width={1000}
      footer={tab === 'edit' && canEdit ? <>
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={errs.length > 0 || reason.trim().length < 5 || save.isPending} onClick={() => save.mutate()}>შენახვა (ვერსია {a.norm_version + 1})</button>
      </> : <button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <div className="row">
        <div className="seg" role="group" aria-label="ხედი">
          {canEdit && <button type="button" aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>შეცვლა</button>}
          <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>ისტორია</button>
        </div>
        <span className="small muted grow" style={{ textAlign: 'right' }}>{unitFmt(a.unit) || 'ერთეულის გარეშე'} · მიმდინარე ვერსია v{a.norm_version}</span>
      </div>
      {tab === 'edit' ? (<>
        <RangesEditor rows={rows} onChange={setRows} numeric={numeric} methods={methods.data ?? []} />
        {numeric && <div className="row" style={{ gap: 12 }}>
          <Field label="კრიტიკული ქვედა" htmlFor="ncl"><input id="ncl" className="input mono" style={{ width: 120 }} inputMode="decimal" value={cl} onChange={(e) => setCl(e.target.value)} /></Field>
          <Field label="კრიტიკული ზედა" htmlFor="nch"><input id="nch" className="input mono" style={{ width: 120 }} inputMode="decimal" value={ch} onChange={(e) => setCh(e.target.value)} /></Field>
          <span className="hint grow">კრიტიკული მნიშვნელობა — ↑↑/↓↓, საჭიროებს ექიმის დაუყოვნებლივ ინფორმირებას.</span>
        </div>}
        {errs.length > 0 && <div className="alert warn">{errs.join(' · ')}</div>}
        <Field label="ცვლილების მიზეზი" htmlFor="nr" required hint="მაგ. „ახალი რეაგენტი — მწარმოებლის ინსტრუქცია, 2026“; ჩანს ისტორიასა და აუდიტში">
          <textarea id="nr" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="alert info">მოქმედებს მაშინვე. ვალიდირებულ შედეგებს არ ეხება; დაუმტკიცებელი შედეგები (აღებული, მიმდინარე, ვალიდაციას ელოდება) ახალი ნორმით გადაითვლება.</div>
        <ErrorBox error={save.error} />
      </>) : (
        hist.isLoading || !hist.data ? <Loading /> : <History h={hist.data} mName={mName} />
      )}
      {toast.node}
    </Modal>
  );
}

const key = (r: NormRange) => JSON.stringify([r.sex, r.pregnancy, r.method_id, r.age_min_days, r.age_max_days, r.low === null ? null : Number(r.low), r.high === null ? null : Number(r.high), r.normal_text]);

function History({ h, mName }: { h: NormHistory; mName: (id: string) => string }) {
  return (
    <div className="stack">
      {h.versions.map((v, i) => {
        const prev = h.versions[i + 1];
        const pk = new Set(prev?.ranges.map(key) ?? []); const ck = new Set(v.ranges.map(key));
        const removed = prev ? prev.ranges.filter((r) => !ck.has(key(r))) : [];
        const critChanged = prev && (String(prev.critical_low) !== String(v.critical_low) || String(prev.critical_high) !== String(v.critical_high));
        return (
          <section key={v.version} className="card card-pad stack" style={{ gap: 6 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <strong>v{v.version}</strong>{i === 0 && <span className="chip ok">მიმდინარე</span>}
              <span className="small muted">{tsDate(v.changed_at)} · {v.changed_by_name ?? 'სისტემა'}{v.recalculated ? ` · გადაითვალა ${v.recalculated} შედეგი` : ''}</span>
            </div>
            <span className="small">მიზეზი: {v.reason}</span>
            <table className="table">
              <tbody>
                {v.ranges.map((r, j) => {
                  const added = prev && !pk.has(key(r));
                  return <tr key={j} style={added ? { background: 'var(--ok-weak)' } : undefined}><td className="small" style={{ width: 24 }}>{added ? '+' : ''}</td><td className="small">{criteria(r, mName)} · {rangeAgeText(r)}</td><td className="small mono">{valueText(r)}</td></tr>;
                })}
                {removed.map((r, j) => <tr key={`x${j}`} style={{ background: 'var(--danger-weak)', textDecoration: 'line-through' }}><td className="small">−</td><td className="small">{criteria(r, mName)} · {rangeAgeText(r)}</td><td className="small mono">{valueText(r)}</td></tr>)}
                {!v.ranges.length && !removed.length && <tr><td className="small muted" colSpan={3}>ნორმა არ არის</td></tr>}
              </tbody>
            </table>
            <span className="small muted">კრიტიკული: {v.critical_low ?? '—'} / {v.critical_high ?? '—'}{critChanged && <strong style={{ color: 'var(--warn-ink)' }}> (შეიცვალა: {prev.critical_low ?? '—'} / {prev.critical_high ?? '—'} → ეს)</strong>}</span>
          </section>
        );
      })}
    </div>
  );
}
