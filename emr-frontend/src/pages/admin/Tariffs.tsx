import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ReferralTypeTariff, Tariff } from '../../api/types';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { money, REFERRAL_KA } from '../../lib/format';

export default function Tariffs() {
  const [search, setSearch] = useState(''); const [inactive, setInactive] = useState(false); const [edit, setEdit] = useState<Tariff | 'new' | null>(null);
  const dq = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['tariffs', dq, inactive], queryFn: () => api<Tariff[]>('/tariffs', { query: { search: dq, include_inactive: inactive } }) });
  return (
    <div className="content">
      <ReferralMapping />
      <div className="row">
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 320 }} placeholder="კოდი ან დასახელება" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={() => setEdit('new')}>+ ტარიფი</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          {q.data?.length === 0 ? <div className="empty">ტარიფი არ არის.</div> : (
            <table className="table">
              <thead><tr><th>კოდი</th><th>დასახელება</th><th className="num">ფასი</th><th>სტატუსი</th></tr></thead>
              <tbody>{q.data?.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setEdit(t)}>
                  <td className="mono">{t.code}</td><td>{t.title}</td><td className="num">{money(t.base_price)}</td>
                  <td>{t.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}
      {edit && <TariffDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TariffDialog({ t, onClose }: { t: Tariff | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(t?.code ?? ''); const [title, setTitle] = useState(t?.title ?? ''); const [price, setPrice] = useState(t?.base_price ?? ''); const [active, setActive] = useState(t?.is_active ?? true);
  const m = useMutation({
    mutationFn: () => t ? api(`/tariffs/${t.id}`, { method: 'PATCH', body: { title, base_price: Number(price), is_active: active } }) : api('/tariffs', { body: { code, title, base_price: Number(price) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tariffs'] }); void qc.invalidateQueries({ queryKey: ['doctors'] }); onClose(); },
  });
  return (
    <Modal title={t ? t.code : 'ახალი ტარიფი'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="tf" disabled={m.isPending}>შენახვა</button></>}>
      <form id="tf" className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="კოდი" htmlFor="tc" required hint={t ? 'კოდი არ იცვლება' : 'მაგ. CONS_CARDIO'}><input id="tc" className="input mono" value={code} disabled={!!t} onChange={(e) => setCode(e.target.value.toUpperCase())} required /></Field>
        <Field label="დასახელება" htmlFor="tt" required><input id="tt" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="ფასი (₾)" htmlFor="tp" required hint={t ? 'ცვლილება არ ეხება უკვე გამოწერილ ინვოისებს' : undefined}><input id="tp" className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></Field>
        {t && <label className="row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

/** მიმართვის ტიპი → ტარიფი (ავტომატური ინვოისის ხაზისთვის) */
function ReferralMapping() {
  const qc = useQueryClient(); const toast = useToast();
  const map = useQuery({ queryKey: ['referral-types'], queryFn: () => api<ReferralTypeTariff[]>('/tariffs/referral-types') });
  const all = useQuery({ queryKey: ['tariffs', '', false], queryFn: () => api<Tariff[]>('/tariffs') });
  const m = useMutation({
    mutationFn: (v: { type: string; tariff_id: string }) => api('/tariffs/referral-types', { method: 'PUT', body: v }),
    onSuccess: () => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['referral-types'] }); },
  });
  return (
    <section className="card card-pad stack">
      <h2>მიმართვების ტარიფები</h2>
      <span className="hint">მიმართვის შექმნისას ეს ტარიფი ავტომატურად ემატება ინვოისს. ტარიფის გარეშე მიმართვის ტიპი ექიმისთვის მიუწვდომელია.</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {Object.entries(REFERRAL_KA).map(([type, label]) => {
          const cur = map.data?.find((x) => x.type === type);
          return (
            <Field key={type} label={label} htmlFor={`rt-${type}`}>
              <select id={`rt-${type}`} className="select" value={cur?.tariff_id ?? ''} onChange={(e) => e.target.value && m.mutate({ type, tariff_id: e.target.value })}>
                <option value="">— არ არის მინიჭებული —</option>
                {all.data?.map((t) => <option key={t.id} value={t.id}>{t.title} — {money(t.base_price)}</option>)}
              </select>
            </Field>
          );
        })}
      </div>
      <ErrorBox error={m.error} />{toast.node}
    </section>
  );
}
