import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { useErMeta } from './Er';

/**
 * 0091 — ER-ის მომსახურების ტარიფის წესები (ადმინისტრირება → მოდულები → ER → ბილინგი).
 * სახე: visit — ვიზიტი; level — ტრიაჟის დონე; time_band — ხანგრძლივობის ზოლი (წთ-დან / წთ-მდე); time_hour — ყოველი დაწყებული საათი (წთ-დან).
 * ფასი — ტარიფის ჩანაწერიდან (ფასთა ნუსხები: საბაზო / განყოფილება / გადამხდელი). განყოფილების წესი ფარავს საერთოს (სახის მიხედვით).
 */
type Kind = 'visit' | 'level' | 'time_band' | 'time_hour';
interface Rule { id: string; kind: Kind; department_id: string | null; department_name: string | null; scale_code: string | null; level: number | null; from_min: number | null; to_min: number | null;
  tariff_id: string; tariff_code: string; tariff_title: string; base_price: string; is_active: boolean; note: string | null }
interface Resp { fee_mode: string; rules: Rule[]; tariffs: { id: string; code: string; title: string; base_price: string }[] }
const KIND_KA: Record<Kind, string> = { visit: 'ვიზიტი', level: 'ტრიაჟის დონე', time_band: 'ხანგრძლივობის ზოლი', time_hour: 'საათობრივი (ზოლის შემდეგ)' };
const MODE_KIND: Record<string, Kind[]> = { visit: ['visit'], level: ['level'], time: ['time_band', 'time_hour'], none: [] };
const cond = (r: Rule) => r.kind === 'level' ? `${r.scale_code}-${r.level}` : r.kind === 'time_band' ? `${r.from_min}–${r.to_min ?? '∞'} წთ` : r.kind === 'time_hour' ? `${r.from_min} წთ-დან, საათი` : '—';

export function ErFeeRules() {
  const q = useQuery({ queryKey: ['er-fee-rules'], queryFn: () => api<Resp>('/er/fee-rules') });
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const qc = useQueryClient();
  const del = useMutation({ mutationFn: (id: string) => api(`/er/fee-rules/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['er-fee-rules'] }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const used = MODE_KIND[q.data.fee_mode] ?? [];
  return (
    <section className="stack" style={{ gap: 8 }} data-testid="er-fee-rules">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="label">ტარიფის წესები {q.data.fee_mode === 'none' && <span className="muted">— ტარიფი გამორთულია</span>}</span>
        <button className="btn sm" type="button" onClick={() => setEdit('new')}>+ წესი</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>შენახული პარამეტრით მოქმედებს: {used.length ? used.map((k) => KIND_KA[k]).join(', ') : '—'}. ფასი — ტარიფებში (ფასთა ნუსხები).</p>
      <table className="table"><thead><tr><th>სახე</th><th>პირობა</th><th>განყოფილება</th><th>ტარიფი</th><th className="num">საბაზო ფასი</th><th /></tr></thead>
        <tbody>{q.data.rules.map((r) => <tr key={r.id} style={{ opacity: r.is_active && used.includes(r.kind) ? 1 : 0.55 }}>
          <td>{KIND_KA[r.kind]}{!r.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}</td><td className="mono small">{cond(r)}</td>
          <td className="small">{r.department_name ?? 'ყველა'}</td><td className="small"><span className="mono">{r.tariff_code}</span> {r.tariff_title}</td>
          <td className="num mono">{Number(r.base_price).toFixed(2)}</td>
          <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => setEdit(r)}>შეცვლა</button>{' '}
            <button className="btn sm" type="button" onClick={() => del.mutate(r.id)}>{r.is_active ? 'წაშლა' : '×'}</button></td></tr>)}
          {!q.data.rules.length && <tr><td colSpan={6} className="muted">წესი არ არის</td></tr>}</tbody></table>
      <ErrorBox error={del.error} />
      {edit && <RuleDialog rule={edit === 'new' ? null : edit} tariffs={q.data.tariffs} onClose={() => setEdit(null)} />}
    </section>
  );
}

function RuleDialog({ rule, tariffs, onClose }: { rule: Rule | null; tariffs: Resp['tariffs']; onClose: () => void }) {
  const meta = useErMeta(); const qc = useQueryClient();
  const [f, setF] = useState({ kind: rule?.kind ?? 'visit' as Kind, tariff_id: rule?.tariff_id ?? '', department_id: rule?.department_id ?? '', scale_code: rule?.scale_code ?? meta.data?.settings.triage_scale ?? 'ESI',
    level: String(rule?.level ?? 1), from_min: String(rule?.from_min ?? 0), to_min: rule?.to_min != null ? String(rule.to_min) : '', is_active: rule?.is_active ?? true, note: rule?.note ?? '' });
  const scale = meta.data?.scales.find((x) => x.code === f.scale_code);
  const m = useMutation({
    mutationFn: () => {
      const body = { kind: f.kind, tariff_id: f.tariff_id, department_id: f.department_id || null, note: f.note.trim() || null, is_active: f.is_active,
        ...(f.kind === 'level' ? { scale_code: f.scale_code, level: Number(f.level) } : {}),
        ...(f.kind === 'time_band' || f.kind === 'time_hour' ? { from_min: Number(f.from_min) } : {}), ...(f.kind === 'time_band' && f.to_min ? { to_min: Number(f.to_min) } : {}) };
      return rule ? api(`/er/fee-rules/${rule.id}`, { method: 'PUT', body }) : api('/er/fee-rules', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['er-fee-rules'] }); onClose(); },
  });
  return (
    <Modal title={rule ? 'ტარიფის წესი — შეცვლა' : 'ტარიფის წესი — ახალი'} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!f.tariff_id || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="სახე" htmlFor="fr-k"><select id="fr-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
          {(Object.keys(KIND_KA) as Kind[]).map((k) => <option key={k} value={k}>{KIND_KA[k]}</option>)}</select></Field>
        <Field label="განყოფილება" htmlFor="fr-d"><select id="fr-d" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა</option>{meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <div style={{ gridColumn: '1 / -1' }}><Field label="ტარიფი" htmlFor="fr-t" required><select id="fr-t" className="select" value={f.tariff_id} onChange={(e) => setF({ ...f, tariff_id: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{tariffs.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({Number(t.base_price).toFixed(2)})</option>)}</select></Field></div>
        {f.kind === 'level' && <>
          <Field label="სკალა" htmlFor="fr-s"><select id="fr-s" className="select" value={f.scale_code} onChange={(e) => setF({ ...f, scale_code: e.target.value })}>
            {meta.data?.scales.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>
          <Field label="დონე" htmlFor="fr-l"><select id="fr-l" className="select" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
            {scale?.levels.map((l) => <option key={l.level} value={l.level}>{l.level} — {l.name}</option>)}</select></Field></>}
        {(f.kind === 'time_band' || f.kind === 'time_hour') && <Field label="წთ-დან" htmlFor="fr-f"><input id="fr-f" className="input mono" type="number" min={0} value={f.from_min} onChange={(e) => setF({ ...f, from_min: e.target.value })} /></Field>}
        {f.kind === 'time_band' && <Field label="წთ-მდე" htmlFor="fr-to" hint="ცარიელი — შეუზღუდავი"><input id="fr-to" className="input mono" type="number" min={1} value={f.to_min} onChange={(e) => setF({ ...f, to_min: e.target.value })} /></Field>}
        <div style={{ gridColumn: '1 / -1' }}><Field label="შენიშვნა" htmlFor="fr-n"><input id="fr-n" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
        <label className="row small"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
      </div>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
