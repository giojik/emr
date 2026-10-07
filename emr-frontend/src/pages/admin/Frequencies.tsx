import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';

interface Freq { code: string; name: string; times_of_day: string[] | null; interval_hours: number | null; per_day: string; is_active: boolean; sort_order: number }

/** ადმინისტრირება → დანიშნულების სიხშირეები (0042): სტანდარტული საათები (MAR-ის განრიგი) ან ინტერვალი */
export default function Frequencies() {
  const q = useQuery({ queryKey: ['med-freqs', 'all'], queryFn: () => api<Freq[]>('/inpatient/orders/frequencies', { query: { all: true } }) });
  const [edit, setEdit] = useState<Freq | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row"><h2 style={{ margin: 0 }} className="grow">დანიშნულების სიხშირეები</h2><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ დამატება</button></div>
      <span className="small muted">საათები განსაზღვრავს მედიკამენტის მიცემის განრიგს (MAR); დღიური რაოდენობა — დოზის შემოწმებისთვის.</span>
      <ErrorBox error={q.error} />
      <div className="card">{q.isLoading ? <Loading /> : (
        <table className="table"><thead><tr><th>კოდი</th><th>დასახელება</th><th>საათები / ინტერვალი</th><th className="num">დღეში</th><th>სტატუსი</th><th /></tr></thead>
          <tbody>{q.data?.map((f) => <tr key={f.code} style={{ opacity: f.is_active ? 1 : 0.55 }}><td className="mono">{f.code}</td><td>{f.name}</td>
            <td className="mono small">{f.times_of_day ? f.times_of_day.join(', ') : `ყოველ ${f.interval_hours} სთ`}</td><td className="num">{Number(f.per_day)}</td>
            <td>{f.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
            <td style={{ textAlign: 'right' }}><button className="btn sm" type="button" onClick={() => setEdit(f)}>რედაქტირება</button></td></tr>)}</tbody></table>)}</div>
      {edit && <EditDialog item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EditDialog({ item, onClose }: { item: Freq | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: item?.code ?? '', name: item?.name ?? '', mode: item?.interval_hours ? 'interval' : 'times', times: (item?.times_of_day ?? ['08:00']).join(', '),
    interval: String(item?.interval_hours ?? 8), is_active: item?.is_active ?? true, sort_order: String(item?.sort_order ?? 100) });
  const times = f.times.split(/[,\s]+/).filter(Boolean);
  const valid = times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  const m = useMutation({
    mutationFn: () => api('/inpatient/orders/frequencies', { method: item ? 'PATCH' : 'POST', body: { code: f.code, name: f.name, is_active: f.is_active, sort_order: Number(f.sort_order),
      ...(f.mode === 'times' ? { times_of_day: times } : { interval_hours: Number(f.interval) }) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['med-freqs'] }); onClose(); },
  });
  return (
    <Modal title={item ? `სიხშირე — ${item.code}` : 'ახალი სიხშირე'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button"
        disabled={m.isPending || !f.code || f.name.trim().length < 1 || (f.mode === 'times' ? !times.length || !valid : !(Number(f.interval) >= 1))} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="კოდი" htmlFor="fq-c" required><input id="fq-c" className="input mono" disabled={!!item} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="fq-n" required><input id="fq-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <div className="seg" role="group" aria-label="ტიპი" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={f.mode === 'times'} onClick={() => setF({ ...f, mode: 'times' })}>საათები</button>
          <button type="button" aria-pressed={f.mode === 'interval'} onClick={() => setF({ ...f, mode: 'interval' })}>ინტერვალი</button>
        </div>
        {f.mode === 'times' ? <Field label="საათები" htmlFor="fq-t" hint="მაგ. 08:00, 14:00, 20:00" error={valid ? undefined : 'ფორმატი: HH:MM'}>
          <input id="fq-t" className="input mono" value={f.times} onChange={(e) => setF({ ...f, times: e.target.value })} /></Field>
          : <Field label="ყოველ N საათში" htmlFor="fq-i"><input id="fq-i" className="input mono" type="number" min={1} max={72} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} /></Field>}
        <div className="row" style={{ gap: 12 }}>
          <Field label="რიგი" htmlFor="fq-s"><input id="fq-s" className="input mono" type="number" min={0} value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
          <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        </div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
