import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { ISO_KA, ISO_TYPES, MARKER_KA, useIpcCatalog, type IsoType, type MdroRule, type MdroType } from './types';

/** ცნობარები (0067, infection): იზოლაციის ტიპები (PPE / კარის ნიშნის ტექსტი, ფერი), MDRO ტიპები, ამოცნობის წესები */
export default function IpcCatalogTab() {
  const cat = useIpcCatalog();
  const [iso, setIso] = useState<IsoType | null>(null);
  const [mt, setMt] = useState<MdroType | 'new' | null>(null);
  const [rule, setRule] = useState<MdroRule | 'new' | null>(null);
  if (cat.isLoading) return <div className="content"><Loading /></div>;
  const c = cat.data;
  if (!c) return <div className="content"><ErrorBox error={cat.error} /></div>;
  return (
    <div className="content">
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>იზოლაციის ტიპები</h2>
        <span className="hint">ტიპების სია ფიქსირებულია; ტექსტი (PPE, კარის ნიშანი), მოკლე სახელი და ფერი — კლინიკის. კარის ნიშანზე პაციენტის სახელი / დიაგნოზი არ იბეჭდება.</span>
        <table className="table">
          <thead><tr><th>ტიპი</th><th>დამცავი აღჭურვილობა</th><th>კარის ნიშანი</th><th /></tr></thead>
          <tbody>{c.isolation_types.map((t) => (
            <tr key={t.code}><td><span className="chip" style={{ background: t.color, color: '#fff', borderColor: t.color }}>{t.short_name}</span> {t.name}</td>
              <td className="small" style={{ whiteSpace: 'pre-line' }}>{t.ppe}</td><td className="small" style={{ whiteSpace: 'pre-line' }}>{t.door_text}</td>
              <td><button className="btn sm" type="button" onClick={() => setIso(t)}>შეცვლა</button></td></tr>))}</tbody>
        </table>
      </section>
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">MDRO ტიპები</h2><button className="btn sm primary" type="button" onClick={() => setMt('new')}>+ ტიპი</button></div>
        <table className="table">
          <thead><tr><th>კოდი</th><th>დასახელება</th><th>იზოლაცია</th><th>სასწრაფო</th><th>ვადა</th><th>აქტიური ფლაგი</th><th /></tr></thead>
          <tbody>{c.mdro_types.map((t) => (
            <tr key={t.code} style={t.is_active ? undefined : { opacity: 0.55 }}><td className="mono">{t.code.toUpperCase()}</td><td>{t.name}{!t.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშულია</span>}</td>
              <td className="small">{ISO_KA[t.isolation_type]}</td><td>{t.urgent ? <span className="chip danger">SMS / ელფოსტა</span> : '—'}</td>
              <td className="small">{t.expiry_days ? `${t.expiry_days} დღე` : 'ვადის გარეშე'}</td><td className="mono">{t.active_flags}</td>
              <td><button className="btn sm" type="button" onClick={() => setMt(t)}>შეცვლა</button></td></tr>))}</tbody>
        </table>
      </section>
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">ამოცნობის წესები</h2><button className="btn sm primary" type="button" onClick={() => setRule('new')}>+ წესი</button></div>
        <span className="hint">წესი ემთხვევა იზოლატს, თუ მიკროორგანიზმი (ან მისი ჯგუფი) ემთხვევა, და R არის ჩამოთვლილთაგან ერთ-ერთზე მაინც, და (თუ მითითებულია) იზოლატს აქვს მარკერი. მოწმდება მიკრობიოლოგიის საბოლოო პასუხისას.</span>
        <table className="table">
          <thead><tr><th>MDRO</th><th>მიკროორგანიზმი / ჯგუფი</th><th>R ანტიბიოტიკებზე</th><th>მარკერი</th><th>შენიშვნა</th><th /></tr></thead>
          <tbody>{c.rules.map((r) => (
            <tr key={r.id} style={r.is_active ? undefined : { opacity: 0.55 }}><td className="mono">{r.mdro_code.toUpperCase()}</td>
              <td className="small">{[...r.organism_codes.map((o) => c.organisms.find((x) => x.code.toLowerCase() === o)?.name ?? o), ...r.group_codes.map((g) => `ჯგუფი ${g}`)].join(', ')}</td>
              <td className="mono small">{r.abx_codes.join(', ') || '—'}</td><td className="small">{r.marker ? MARKER_KA[r.marker] : '—'}</td>
              <td className="small">{r.note}{!r.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშულია</span>}</td>
              <td><button className="btn sm" type="button" onClick={() => setRule(r)}>შეცვლა</button></td></tr>))}</tbody>
        </table>
      </section>
      {iso && <IsoDialog t={iso} onClose={() => setIso(null)} />}
      {mt && <MdroTypeDialog t={mt === 'new' ? null : mt} onClose={() => setMt(null)} />}
      {rule && <RuleDialog r={rule === 'new' ? null : rule} onClose={() => setRule(null)} />}
    </div>
  );
}

const useInval = () => { const qc = useQueryClient(); return () => void qc.invalidateQueries({ queryKey: ['ipc-catalog'] }); };

function IsoDialog({ t, onClose }: { t: IsoType; onClose: () => void }) {
  const inval = useInval();
  const [f, setF] = useState({ name: t.name, short_name: t.short_name, color: t.color, ppe: t.ppe, door_text: t.door_text });
  const m = useMutation({ mutationFn: () => api(`/ipc/isolation-types/${t.code}`, { method: 'PATCH', body: f }), onSuccess: () => { inval(); onClose(); } });
  return (
    <Modal title={`იზოლაციის ტიპი — ${ISO_KA[t.code]}`} onClose={onClose} width={640} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="დასახელება" htmlFor="it-n"><input id="it-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="მოკლე (დაფა)" htmlFor="it-s"><input id="it-s" className="input" maxLength={12} value={f.short_name} onChange={(e) => setF({ ...f, short_name: e.target.value })} /></Field>
          <Field label="ფერი" htmlFor="it-c"><input id="it-c" type="color" className="input" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value.toUpperCase() })} /></Field>
        </div>
        <Field label="დამცავი აღჭურვილობა (ხაზი = პუნქტი)" htmlFor="it-p"><textarea id="it-p" className="textarea" rows={4} value={f.ppe} onChange={(e) => setF({ ...f, ppe: e.target.value })} /></Field>
        <Field label="კარის ნიშნის დამატებითი ინსტრუქცია (ხაზი = პუნქტი)" htmlFor="it-d"><textarea id="it-d" className="textarea" rows={4} value={f.door_text} onChange={(e) => setF({ ...f, door_text: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function MdroTypeDialog({ t, onClose }: { t: MdroType | null; onClose: () => void }) {
  const inval = useInval();
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', isolation_type: t?.isolation_type ?? 'contact', urgent: t?.urgent ?? false,
    expiry: t?.expiry_days ? String(t.expiry_days) : '', is_active: t?.is_active ?? true, sort_order: t?.sort_order ?? 100 });
  const m = useMutation({ mutationFn: () => {
    const body = { name: f.name.trim(), isolation_type: f.isolation_type, urgent: f.urgent, expiry_days: f.expiry ? Number(f.expiry) : null, sort_order: Number(f.sort_order), ...(t ? { is_active: f.is_active } : { code: f.code.trim() }) };
    return t ? api(`/ipc/mdro-types/${t.code}`, { method: 'PATCH', body }) : api('/ipc/mdro-types', { body });
  }, onSuccess: () => { inval(); onClose(); } });
  return (
    <Modal title={t ? `MDRO ტიპი — ${t.code.toUpperCase()}` : 'ახალი MDRO ტიპი'} onClose={onClose} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!t && f.code.length < 2)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        {!t && <Field label="კოდი" htmlFor="mt-c" hint="ლათინური პატარა ასოები / ციფრები, მაგ. crkp"><input id="mt-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase() })} /></Field>}
        <Field label="დასახელება" htmlFor="mt-n"><input id="mt-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="შეთავაზებული იზოლაცია" htmlFor="mt-i"><select id="mt-i" className="select" value={f.isolation_type} onChange={(e) => setF({ ...f, isolation_type: e.target.value })}>
            {ISO_TYPES.map((x) => <option key={x} value={x}>{ISO_KA[x]}</option>)}</select></Field>
          <Field label="ფლაგის ვადა (დღე)" htmlFor="mt-e" hint="ცარიელი — ვადის გარეშე; 30–3650"><input id="mt-e" className="input" inputMode="numeric" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> სასწრაფო — SMS / ელფოსტა ინფექციის კონტროლს (თუ ჩართულია პარამეტრებში)</label>
        {t && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      </div>
    </Modal>
  );
}

function RuleDialog({ r, onClose }: { r: MdroRule | null; onClose: () => void }) {
  const inval = useInval(); const cat = useIpcCatalog();
  const [f, setF] = useState({ mdro_code: r?.mdro_code ?? '', organisms: r?.organism_codes.join(', ') ?? '', groups: r?.group_codes.join(', ') ?? '', abx: r?.abx_codes.join(', ') ?? '',
    marker: r?.marker ?? '', note: r?.note ?? '', is_active: r?.is_active ?? true });
  const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const m = useMutation({ mutationFn: () => {
    const body = { mdro_code: f.mdro_code, organism_codes: list(f.organisms), group_codes: list(f.groups), abx_codes: list(f.abx), marker: f.marker || null, note: f.note.trim() || null, is_active: f.is_active };
    return r ? api(`/ipc/mdro-rules/${r.id}`, { method: 'PATCH', body }) : api('/ipc/mdro-rules', { body });
  }, onSuccess: () => { inval(); onClose(); } });
  return (
    <Modal title={r ? 'ამოცნობის წესი' : 'ახალი წესი'} onClose={onClose} width={640} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.mdro_code} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <Field label="MDRO" htmlFor="ru-m"><select id="ru-m" className="select" value={f.mdro_code} onChange={(e) => setF({ ...f, mdro_code: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{cat.data?.mdro_types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
        <Field label="მიკროორგანიზმის კოდები (WHONET)" htmlFor="ru-o" hint={`მაგ. sau, kpn · ცნობარში: ${cat.data?.organisms.length ?? 0}`}>
          <input id="ru-o" className="input mono" list="ru-orgs" value={f.organisms} onChange={(e) => setF({ ...f, organisms: e.target.value })} /></Field>
        <datalist id="ru-orgs">{cat.data?.organisms.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}</datalist>
        <Field label="ან ჯგუფი" htmlFor="ru-g" hint={cat.data?.groups.join(', ')}><input id="ru-g" className="input mono" value={f.groups} onChange={(e) => setF({ ...f, groups: e.target.value.toUpperCase() })} /></Field>
        <Field label="R რომელიმე ანტიბიოტიკზე (კოდები)" htmlFor="ru-a" hint="მაგ. ETP, IPM, MEM; ცარიელი — პირობის გარეშე (მხოლოდ მიკროორგანიზმი / მარკერი)">
          <input id="ru-a" className="input mono" value={f.abx} onChange={(e) => setF({ ...f, abx: e.target.value.toUpperCase() })} /></Field>
        <Field label="ლაბ. მარკერი" htmlFor="ru-k"><select id="ru-k" className="select" value={f.marker} onChange={(e) => setF({ ...f, marker: e.target.value })}>
          <option value="">— არ არის —</option>{Object.entries(MARKER_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="შენიშვნა" htmlFor="ru-n"><input id="ru-n" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        {r && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      </div>
    </Modal>
  );
}
