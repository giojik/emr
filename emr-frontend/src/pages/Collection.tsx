import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, openBlob } from '../api/client';
import type { CollectedSpecimen, CollectionDetail, PendingCollection } from '../api/types';
import { ErrorBox, Loading, WarnIcon, useDebounced, useToast } from '../components/ui';
import { age, dateGe, hhmm } from '../lib/format';

const SPECIMEN_KA: Record<string, string> = { blood: 'სისხლი', serum: 'შრატი', plasma: 'პლაზმა', urine: 'შარდი', stool: 'განავალი', swab: 'ნაცხი', other: 'სხვა' };
/** საცობის ფერი — ვიზუალური მინიშნება; ფაქტობრივი ფერი მწარმოებლის სტანდარტზეა დამოკიდებული */
const CAP: Record<string, string> = { citrate: '#5DA9E9', serum: '#E4B429', heparin: '#3FA66B', edta: '#9B59B6', fluoride: '#8E9AA6' };
const capColor = (c: string | null) => { const k = Object.keys(CAP).find((x) => (c ?? '').toLowerCase().includes(x)); return k ? CAP[k] : '#C9C6BC'; };
const PAID: Record<string, [string, string]> = { paid: ['ok', 'გადახდილი'], partially_paid: ['warn', 'ნაწილობრივ'], unpaid: ['danger', 'გადაუხდელი'] };

/** ფლებოტომია: რიგი → პაციენტის არჩევა → იდენტიფიკაცია → სისხლის აღება → სტიკერები */
export default function Collection() {
  const [search, setSearch] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['collection', ds], queryFn: () => api<PendingCollection[]>('/dx/collection', { query: { search: ds } }), refetchInterval: 15_000 });
  const rows = q.data ?? [];
  return (
    <>
      <header className="topbar">
        <h1>ნიმუშის აღება</h1>
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 320, marginLeft: 16 }} placeholder="გვარი ან პირადი ნომერი" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <span className="muted" style={{ marginLeft: 'auto' }}>{rows.length} რიგში</span>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav aria-label="რიგი" style={{ width: 380, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--surface)', overflow: 'auto' }}>
          <ErrorBox error={q.error} />
          {q.isLoading && <Loading />}
          {q.data && !rows.length && <div className="empty">რიგში არავინ არის.</div>}
          {rows.map((p) => {
            const [pc, pl] = PAID[p.paid_status ?? 'unpaid'] ?? ['', ''];
            return (
              <button key={p.encounter_id} type="button" onClick={() => setSelId(p.encounter_id)}
                style={{ width: '100%', textAlign: 'left', padding: '12px 16px', border: 0, borderBottom: '1px solid var(--line-soft)', background: p.encounter_id === selId ? 'var(--accent-weak)' : 'transparent', font: 'inherit', color: 'var(--ink)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="row" style={{ gap: 8 }}>
                  <strong className="grow">{p.last_name} {p.first_name}</strong>
                  {p.urgent && <span className="chip danger">სასწრაფო</span>}
                  <span className={`chip ${pc}`}>{pl}</span>
                </span>
                <span className="small muted">{dateGe(p.birth_date)} · {p.tests} ანალიზი · {hhmm(p.ordered_at)}{p.visit_kind === 'lab' ? ' · ლაბ. ვიზიტი' : ''}</span>
                {p.collection_issue && <span className="small" style={{ color: 'var(--warn-ink)' }}>⚠ {p.collection_issue}</span>}
              </button>
            );
          })}
        </nav>
        <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {selId ? <CollectPanel key={selId} encounterId={selId} onDone={() => { setSelId(null); setSearch(''); }} /> : <div className="empty">აირჩიეთ პაციენტი რიგიდან.</div>}
        </main>
      </div>
    </>
  );
}

function CollectPanel({ encounterId, onDone }: { encounterId: string; onDone: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const d = useQuery({ queryKey: ['collection-detail', encounterId], queryFn: () => api<CollectionDetail>(`/dx/collection/${encounterId}`) });
  const [idOk, setIdOk] = useState(false);
  const [unpaidOk, setUnpaidOk] = useState(false);
  const [done, setDone] = useState<CollectedSpecimen[] | null>(null);
  const labels = useMutation({ mutationFn: (ids: string[]) => openBlob(`/dx/labels?ids=${ids.join(',')}`) });
  const collect = useMutation({
    mutationFn: () => api<CollectedSpecimen[]>(`/encounters/${encounterId}/dx-collect`, { body: { identity_confirmed: idOk, unpaid_ack: unpaidOk || undefined } }),
    onSuccess: (sp) => { setDone(sp); labels.mutate(sp.map((s) => s.id)); void qc.invalidateQueries({ queryKey: ['collection'] }); },
  });
  const issue = useMutation({
    mutationFn: (reason: string) => api(`/dx/collection/${encounterId}/issue`, { body: { reason } }),
    onSuccess: () => { toast.show('მიზეზი შენახულია — შეკვეთა ღია რჩება'); void qc.invalidateQueries({ queryKey: ['collection'] }); onDone(); },
  });

  if (d.isLoading) return <Loading />;
  if (d.error || !d.data) return <div className="content"><ErrorBox error={d.error ?? 'ვერ მოიძებნა'} /></div>;
  const x = d.data;
  const unpaid = x.paid_status === 'unpaid';
  const notes = [...new Set(x.items.map((i) => i.clinical_note).filter(Boolean))] as string[];

  if (done) {
    return (
      <div className="content" style={{ maxWidth: 760 }}>
        <div className="alert ok"><strong>სტიკერები იბეჭდება.</strong> დააკარით თითოეული სინჯარას და გაგზავნეთ ლაბორატორიაში.</div>
        <h2>{x.last_name} {x.first_name}</h2>
        {done.map((s, i) => (
          <div key={s.id} className="card row" style={{ padding: '12px 14px', gap: 14 }}>
            <span className="mono muted">{i + 1}.</span>
            <span aria-hidden="true" style={{ width: 16, height: 34, borderRadius: 4, background: capColor(s.container), flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{s.barcode}</span>
            <span className="chip">{s.container ?? SPECIMEN_KA[s.specimen_type]}</span>
            <span className="grow small">{s.tests.join(', ')}</span>
            {s.external && <span className="chip warn">გარე ლაბ.</span>}
          </div>
        ))}
        <ErrorBox error={labels.error} />
        <div className="row">
          <button className="btn" type="button" onClick={() => labels.mutate(done.map((s) => s.id))}>სტიკერების ხელახლა ბეჭდვა</button>
          <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={onDone}>შემდეგი პაციენტი</button>
        </div>
        {toast.node}
      </div>
    );
  }

  return (
    <div className="content" style={{ maxWidth: 820 }}>
      <section className="card card-pad stack" style={{ gap: 6 }}>
        <span className="small muted">პაციენტის იდენტიფიკაცია</span>
        <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{x.last_name} {x.first_name}</div>
        <div className="row" style={{ gap: 20, fontSize: 18, flexWrap: 'wrap' }}>
          <span>დაბ.: <strong className="mono">{dateGe(x.birth_date)}</strong> ({age(x.birth_date)} წ)</span>
          <span>{x.gender === 'male' ? 'მამრობითი' : x.gender === 'female' ? 'მდედრობითი' : ''}</span>
          <span className="mono muted">{x.personal_number ?? x.passport_number}</span>
        </div>
        <span className="small muted">{x.visit_kind === 'lab' ? `ლაბორატორიული ვიზიტი${x.external_referral ? ` · მიმართვა: ${x.external_referral}` : ''}` : `ექიმი: ${x.doctor_name ?? '—'}`}</span>
      </section>

      {notes.length > 0 && <div className="alert warn"><WarnIcon color="var(--warn-ink)" /><div><strong>შენიშვნა:</strong> {notes.join(' · ')}</div></div>}
      {x.items.some((i) => i.collection_issue) && <div className="alert info">წინა მცდელობა: {x.items.find((i) => i.collection_issue)?.collection_issue}</div>}

      <section className="card">
        <div className="card-head"><h2 className="grow">სინჯარები — აღების რიგით</h2><span className="small muted">{x.tubes.length} სინჯარა · {x.items.length} ანალიზი</span></div>
        {x.tubes.map((t, i) => (
          <div key={i} className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', gap: 14 }}>
            <span className="mono muted" style={{ width: 20 }}>{i + 1}.</span>
            <span aria-hidden="true" style={{ width: 16, height: 34, borderRadius: 4, background: capColor(t.container), flexShrink: 0 }} />
            <div className="stack grow" style={{ gap: 2 }}>
              <strong>{t.container ?? SPECIMEN_KA[t.specimen_type]} <span className="small muted" style={{ fontWeight: 400 }}>· {SPECIMEN_KA[t.specimen_type]}</span></strong>
              <span className="small">{t.tests.join(', ')}</span>
            </div>
            {t.external && <span className="chip warn">გარე ლაბ.</span>}
          </div>
        ))}
        {x.items.some((i) => i.priority === 'urgent') && <div className="alert danger" style={{ margin: 12 }}>სასწრაფო (cito)</div>}
      </section>

      <section className="card card-pad stack">
        <label className="row" style={{ fontSize: 16, alignItems: 'flex-start' }}>
          <input type="checkbox" style={{ width: 20, height: 20, marginTop: 2 }} checked={idOk} onChange={(e) => setIdOk(e.target.checked)} />
          <span>პაციენტმა <strong>თავად დაასახელა</strong> სახელი, გვარი და დაბადების თარიღი — ემთხვევა ეკრანს</span>
        </label>
        {unpaid && (
          <div className="alert danger" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <strong>ანალიზები გადახდილი არ არის.</strong>
            <label className="row"><input type="checkbox" checked={unpaidOk} onChange={(e) => setUnpaidOk(e.target.checked)} /> მაინც აღება (მაგ. სასწრაფო შემთხვევა, გადახდა მოგვიანებით)</label>
          </div>
        )}
        <ErrorBox error={collect.error instanceof ApiError && collect.error.code === 'UNPAID' ? null : collect.error} />
        <ErrorBox error={issue.error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={() => { const r = prompt('რატომ ვერ აიღეთ? (მაგ. ვენა ვერ მოიძებნა, პაციენტმა უარი თქვა, არ არის უზმოზე)'); if (r && r.trim().length >= 5) issue.mutate(r.trim()); }}>ვერ აიღო</button>
          <button className="btn primary lg" type="button" style={{ marginLeft: 'auto' }} disabled={!idOk || (unpaid && !unpaidOk) || collect.isPending} onClick={() => collect.mutate()}>
            სისხლი აღებულია — სტიკერების ბეჭდვა
          </button>
        </div>
      </section>
      {toast.node}
    </div>
  );
}
