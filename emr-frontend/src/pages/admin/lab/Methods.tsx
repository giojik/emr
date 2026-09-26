import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../../components/ui';
import { METHOD_KIND_KA, useLabMethods, useLabPermissions, type LabMethod } from './common';
import { ConnChip, GatewayBanner, InstrumentPanel, useInstruments } from './Instruments';

/** ანალიზატორები / მეთოდები — ნორმის კრიტერიუმი, ანალიზის ნაგულისხმევი, ბლანკზე ჩვენება */
export default function Methods() {
  const [inactive, setInactive] = useState(false);
  const q = useLabMethods(inactive); const perm = useLabPermissions();
  const [edit, setEdit] = useState<LabMethod | 'new' | null>(null);
  const canEdit = !!perm.data?.methods;
  const inst = useInstruments();
  const byMethod = new Map((inst.data ?? []).map((r) => [r.method_id, r]));
  return (
    <div className="stack">
      <GatewayBanner />
      <div className="row">
        <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        <span className="hint grow">ანალიზს მიეთითება ნაგულისხმევი ანალიზატორი (კვლევის ფორმაში); ლაბორანტს შედეგის შეტანისას შეუძლია შეცვალოს. ნორმა შეიძლება იყოს კონკრეტული ანალიზატორისთვის.</span>
        {canEdit && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ანალიზატორი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">ანალიზატორები ჯერ არ არის დამატებული.</div> : (
        <div className="card"><table className="table">
          <thead><tr><th>დასახელება</th><th>ტიპი</th><th>მწარმოებელი / S/N</th><th className="num">ანალიზები</th><th>კავშირი (ASTM / HL7)</th><th>სტატუსი</th></tr></thead>
          <tbody>{q.data.map((m) => (
            <tr key={m.id} className={canEdit ? 'clickable' : undefined} onClick={() => canEdit && setEdit(m)} style={m.is_active ? undefined : { opacity: 0.55 }}>
              <td><strong>{m.name}</strong>{m.note && <div className="small muted">{m.note}</div>}</td>
              <td className="small">{METHOD_KIND_KA[m.kind]}</td>
              <td className="small">{[m.manufacturer, m.serial_number && `S/N ${m.serial_number}`].filter(Boolean).join(' · ') || '—'}</td>
              <td className="num">{m.services}</td>
              <td className="small">{(() => { const r = byMethod.get(m.id); return r ? <div className="stack" style={{ gap: 2 }}><ConnChip r={r} />
                {r.id && <span className="muted mono">{r.protocol?.toUpperCase()} · {r.conn_mode === 'client' ? `${r.host}:${r.port}` : `:${r.port}`}</span>}
                {Number(r.unmatched) > 0 && <span style={{ color: 'var(--warn-ink)' }}>დასამუშავებელი: {r.unmatched}</span>}</div> : null; })()}</td>
              <td>{m.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {edit && <MethodDialog m={edit === 'new' ? null : edit} canEdit={canEdit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function MethodDialog({ m, onClose, canEdit }: { m: LabMethod | null; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'main' | 'conn'>('main');
  const [f, setF] = useState({ name: m?.name ?? '', kind: m?.kind ?? 'analyzer', manufacturer: m?.manufacturer ?? '', serial_number: m?.serial_number ?? '', note: m?.note ?? '', is_active: m?.is_active ?? true });
  const save = useMutation({
    mutationFn: () => api(m ? `/lab/methods/${m.id}` : '/lab/methods', { method: m ? 'PATCH' : 'POST', body: { ...f, manufacturer: f.manufacturer || null, serial_number: f.serial_number || null, note: f.note || null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lab-methods'] }); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={m ? m.name : 'ახალი ანალიზატორი / მეთოდი'} onClose={onClose} width={m ? 980 : 620}
      footer={tab === 'main' ? <><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={f.name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>შენახვა</button></>
        : <button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      {m && <div className="seg" role="group" aria-label="ხედი">
        <button type="button" aria-pressed={tab === 'main'} onClick={() => setTab('main')}>ძირითადი</button>
        <button type="button" aria-pressed={tab === 'conn'} onClick={() => setTab('conn')}>კავშირი ანალიზატორთან</button>
      </div>}
      {m && tab === 'conn' ? <InstrumentPanel methodId={m.id} canEdit={canEdit} /> : <>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <Field label="დასახელება" htmlFor="mn" required hint="მაგ. Mindray BC-6200, Cobas c311, „ხელით — მიკროსკოპია“"><input id="mn" className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="ტიპი" htmlFor="mk"><select id="mk" className="select" value={f.kind} onChange={set('kind')}>{Object.entries(METHOD_KIND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="მწარმოებელი" htmlFor="mm"><input id="mm" className="input" value={f.manufacturer} onChange={set('manufacturer')} /></Field>
        <Field label="სერიული №" htmlFor="ms"><input id="ms" className="input mono" value={f.serial_number} onChange={set('serial_number')} /></Field>
        <div style={{ gridColumn: '1 / -1' }}><Field label="შენიშვნა" htmlFor="mnote"><input id="mnote" className="input" value={f.note} onChange={set('note')} /></Field></div>
      </div>
      {m && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური (გათიშული არ ჩანს არჩევანში; ძველი შედეგები და ნორმები რჩება)</label>}
      <ErrorBox error={save.error} />
      </>}
    </Modal>
  );
}
