import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { AllergenGroup } from '../../api/types';
import { ErrorBox, Loading } from '../../components/ui';
import { tsDate } from '../../lib/format';

/** ალერგენული ჯგუფები: ტერმინები, ჯვარედინი კავშირები, ფარმაკოლოგის დამტკიცება */
export default function Allergens() {
  const q = useQuery({ queryKey: ['allergen-groups'], queryFn: () => api<AllergenGroup[]>('/allergen-groups') });
  const pending = q.data?.filter((g) => g.needs_review).length ?? 0;
  const names = Object.fromEntries((q.data ?? []).map((g) => [g.code, g.name]));
  return (
    <div className="content">
      <div className={`alert ${pending ? 'warn' : 'ok'}`}>
        {pending ? `${pending} ჯგუფი ელოდება დამტკიცებას. ტერმინის დამატება ან წაშლა ჯგუფს ხელახლა დასამტკიცებლად აბრუნებს.` : 'ყველა ჯგუფი დამტკიცებულია.'}
      </div>
      <span className="hint">ტერმინი არის სიტყვის ნაწილი (ფუძე): „ამოქსიცილინ“ ემთხვევა „ამოქსიცილინი“-ს და „ამოქსიცილინის“-ს. ძალიან მოკლე ტერმინი ყველა სახელს დაემთხვევა, რომელიც მას შეიცავს.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : q.data?.map((g) => <GroupCard key={g.code} g={g} names={names} />)}
    </div>
  );
}

function GroupCard({ g, names }: { g: AllergenGroup; names: Record<string, string> }) {
  const qc = useQueryClient(); const [term, setTerm] = useState('');
  const done = () => void qc.invalidateQueries({ queryKey: ['allergen-groups'] });
  const add = useMutation({ mutationFn: () => api(`/allergen-groups/${g.code}/terms`, { body: { term } }), onSuccess: () => { setTerm(''); done(); } });
  const del = useMutation({ mutationFn: (t: string) => api(`/allergen-groups/${g.code}/terms/${encodeURIComponent(t)}`, { method: 'DELETE' }), onSuccess: done });
  const approve = useMutation({ mutationFn: () => api(`/allergen-groups/${g.code}/approve`, { method: 'POST' }), onSuccess: done });
  return (
    <section className="card card-pad stack">
      <div className="row">
        <h2 className="grow">{g.name} <span className="mono small muted" style={{ fontWeight: 400 }}>{g.code}</span></h2>
        {g.needs_review
          ? <><span className="chip warn">დასამტკიცებელი</span><button className="btn sm primary" type="button" disabled={approve.isPending} onClick={() => { if (confirm(`დავამტკიცოთ „${g.name}“ (${g.terms.length} ტერმინი)?`)) approve.mutate(); }}>დამტკიცება</button></>
          : <span className="chip ok">დამტკიცებულია{g.reviewed_at ? ` · ${tsDate(g.reviewed_at)}` : ''}</span>}
      </div>
      {g.cross_reactive.length > 0 && <span className="small muted">ჯვარედინი რეაქცია: {g.cross_reactive.map((c) => names[c.code] ?? c.code).join(', ')}</span>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {g.terms.map((t) => (
          <span key={t.term} className="term">{t.term}<button type="button" aria-label={`წაშლა: ${t.term}`} onClick={() => { if (confirm(`წავშალოთ ტერმინი „${t.term}“?`)) del.mutate(t.term); }}>×</button></span>
        ))}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (term.trim().length >= 3) add.mutate(); }}>
        <input aria-label={`ახალი ტერმინი: ${g.name}`} className="input" style={{ maxWidth: 320, height: 36 }} placeholder="ახალი ტერმინი / სავაჭრო სახელი" value={term} onChange={(e) => setTerm(e.target.value)} />
        <button className="btn sm" type="submit" disabled={term.trim().length < 3 || add.isPending}>დამატება</button>
      </form>
      <ErrorBox error={add.error ?? del.error ?? approve.error} />
    </section>
  );
}
