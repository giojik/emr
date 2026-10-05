import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModules, type SystemModule } from '../../lib/modules';

/** მოდულები და პარამეტრები: სხვა კლინიკაში — ადგილობრივი წესებით; ნაგულისხმევი = მიმდინარე ქცევა */
export default function Modules() {
  const q = useModules();
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      <span className="hint">ჩართეთ / გამორთეთ მოდულები და შეცვალეთ მათი პარამეტრები კლინიკის წესების მიხედვით. გამორთული მოდული ქრება მენიუდან. ყოველი ცვლილება აუდიტშია (მიზეზით).</span>
      <ErrorBox error={q.error} />
      {q.data?.map((m) => <ModuleCard key={m.code} m={m} />)}
    </div>
  );
}

function ModuleCard({ m }: { m: SystemModule }) {
  const qc = useQueryClient(); const toast = useToast();
  const [s, setS] = useState<Record<string, unknown>>(m.settings);
  const [enabled, setEnabled] = useState(m.enabled);
  const [reason, setReason] = useState('');
  const dirty = enabled !== m.enabled || JSON.stringify(s) !== JSON.stringify(m.settings);
  const save = useMutation({
    mutationFn: () => api<SystemModule>(`/modules/${m.code}`, { method: 'PUT', body: { enabled, settings: s, reason: reason.trim() } }),
    onSuccess: () => { setReason(''); toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['modules'] }); },
  });
  return (
    <section className="card card-pad stack">
      {toast.node}
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{m.name}</h2>
        <label className="row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <strong>{enabled ? 'ჩართულია' : 'გამორთულია'}</strong></label></div>
      {m.description && <span className="small muted">{m.description}</span>}
      {m.code === 'asset_register' && <AssetSettings s={s} set={setS} />}
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <span className="small muted grow">ბოლო ცვლილება: {tsDate(m.updated_at)}</span>
        {dirty && <><input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ცვლილების მიზეზი" placeholder="ცვლილების მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn" type="button" onClick={() => { setS(m.settings); setEnabled(m.enabled); }}>გაუქმება</button>
          <button className="btn primary" type="button" disabled={save.isPending || reason.trim().length < 3} onClick={() => save.mutate()}>შენახვა</button></>}
      </div>
      <ErrorBox error={save.error} />
    </section>
  );
}

interface Person { id: string; name: string; department_name: string | null }
function AssetSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const [q, setQ] = useState('');
  const people = useQuery({ queryKey: ['asset-people', q], queryFn: () => api<Person[]>('/assets/people', { query: { search: q } }).catch(() => [] as Person[]), enabled: v<string>('writeoff_mode') === 'committee' });
  const committee = v<string[]>('writeoff_committee') ?? [];
  const known = useQuery({ queryKey: ['asset-people', ''], queryFn: () => api<Person[]>('/assets/people').catch(() => [] as Person[]) });
  const example = [v<string>('inv_prefix'), v<boolean>('inv_year') ? String(new Date().getFullYear()).slice(2) : '', '1'.padStart(v<number>('inv_digits') ?? 5, '0')].filter(Boolean).join('-');
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="ნომრის პრეფიქსი" htmlFor="ip" hint="დიდი ლათ. ასოები / ციფრები, ≤ 8; ცარიელი — პრეფიქსის გარეშე"><input id="ip" className="input mono" maxLength={8} value={v<string>('inv_prefix') ?? ''} onChange={(e) => upd('inv_prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></Field>
        <Field label="ციფრების რაოდენობა" htmlFor="id"><input id="id" className="input mono" type="number" min={3} max={9} value={v<number>('inv_digits') ?? 5} onChange={(e) => upd('inv_digits', Number(e.target.value))} /></Field>
        <div className="stack" style={{ gap: 4 }}><label className="row" style={{ marginTop: 26 }}><input type="checkbox" checked={!!v<boolean>('inv_year')} onChange={(e) => upd('inv_year', e.target.checked)} /> წელი ნომერში</label>
          <span className="small">მაგალითი: <strong className="mono">{example}</strong></span></div>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('require_room')} onChange={(e) => upd('require_room', e.target.checked)} /> ოთახი სავალდებულოა</label>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('require_responsible')} onChange={(e) => upd('require_responsible', e.target.checked)} /> პასუხისმგებელი სავალდებულოა</label>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('track_value')} onChange={(e) => upd('track_value', e.target.checked)} /> შეძენის ღირებულება / მომწოდებელი</label>
        <Field label="გადაადგილება" htmlFor="mm"><select id="mm" className="select" value={v<string>('move_mode')} onChange={(e) => upd('move_mode', e.target.value)}>
          <option value="confirm">მიმღების დადასტურებით</option><option value="direct">პირდაპირ (დადასტურების გარეშე)</option></select></Field>
        <Field label="ჩამოწერის აქტი" htmlFor="wm"><select id="wm" className="select" value={v<string>('writeoff_mode')} onChange={(e) => upd('writeoff_mode', e.target.value)}>
          <option value="single">ერთი დამმტკიცებელი (საწყობის მენეჯერი)</option><option value="committee">კომისია (კვორუმით)</option><option value="direct">პირდაპირ (დამტკიცების გარეშე)</option></select></Field>
        <Field label="ეტიკეტი" htmlFor="lb"><div className="row" style={{ gap: 6 }}>
          <select id="lb" className="select" value={v<string>('label_size')} onChange={(e) => upd('label_size', e.target.value)}><option value="50x25">50×25 მმ</option><option value="40x20">40×20 მმ</option><option value="70x35">70×35 მმ</option></select>
          <select className="select" aria-label="კოდის ტიპი" value={v<string>('label_code')} onChange={(e) => upd('label_code', e.target.value)}><option value="qr">QR</option><option value="code128">შტრიხკოდი (Code128)</option></select></div></Field>
      </div>
      {v<string>('writeoff_mode') === 'committee' && (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row"><strong className="grow">კომისიის წევრები</strong>
            <label className="row small">კვორუმი (დამტკიცებისთვის საჭირო ხმა) <input className="input mono" style={{ width: 70, height: 34 }} type="number" min={1} max={15} value={v<number>('committee_quorum') ?? 2} onChange={(e) => upd('committee_quorum', Number(e.target.value))} /></label></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{committee.map((id) => { const p = known.data?.find((x) => x.id === id);
            return <span key={id} className="term">{p?.name ?? id.slice(0, 8)}<button type="button" aria-label="მოხსნა" onClick={() => upd('writeoff_committee', committee.filter((x) => x !== id))}>×</button></span>; })}
            {!committee.length && <span className="small muted">წევრები არ არის</span>}</div>
          <input className="input" style={{ maxWidth: 360, height: 36 }} aria-label="თანამშრომლის ძებნა" placeholder="დაამატეთ: სახელი, გვარი" value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim().length >= 2 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{people.data?.filter((p) => !committee.includes(p.id)).slice(0, 10).map((p) =>
            <button key={p.id} className="btn sm" type="button" onClick={() => { upd('writeoff_committee', [...committee, p.id]); setQ(''); }}>+ {p.name}{p.department_name ? ` · ${p.department_name}` : ''}</button>)}</div>}
        </div>)}
    </div>
  );
}
