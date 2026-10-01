import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiUpload } from '../../api/client';
import { ErrorBox } from '../../components/ui';

interface ImportResult {
  commit: boolean; rows: number; created: number; generics_created: number; skipped: number; errors: number;
  report: { row: number; status: 'create' | 'skip' | 'error'; name: string; message?: string; generic?: 'new' | 'existing' }[];
}
const ST: Record<string, [string, string]> = { create: ['ok', 'დაემატება'], skip: ['', 'გამოტოვებული'], error: ['danger', 'შეცდომა'] };

/** კატალოგის პირველადი შევსება: Excel (.xlsx) ან CSV; ჯერ შემოწმება, შემდეგ — იმპორტი */
export default function ImportPage() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: (commit: boolean) => { const fd = new FormData(); fd.append('file', file!); return apiUpload<ImportResult>(`/stock/import?commit=${commit}`, fd); },
    onSuccess: (r) => { setRes(r); if (r.commit) { void qc.invalidateQueries({ queryKey: ['stock-items'] }); void qc.invalidateQueries({ queryKey: ['med-generics'] }); } },
  });
  const tpl = useMutation({
    mutationFn: async () => {
      const blob = await api<Blob>('/stock/import/template', { raw: true });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = 'საქონლის-იმპორტის-შაბლონი.xlsx'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  return (
    <div className="content">
      <section className="card card-pad stack">
        <h2>იმპორტი Excel-იდან</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>გადმოწერეთ შაბლონი და შეავსეთ (პირველი სტრიქონი — სათაურები, მეორე — მინიშნებები, შეიძლება წაიშალოს).</li>
          <li>მედიკამენტზე სავალდებულოა INN და ფორმა — ჯენერიკი იქმნება ავტომატურად ან ებმება არსებულს (INN + ფორმა + დოზა).</li>
          <li>„შემოწმება“ არაფერს ინახავს — აჩვენებს, რა დაემატება და რა არის შესასწორებელი. შემდეგ — „იმპორტი“.</li>
          <li>არსებული (იგივე შტრიხკოდი, კოდი ან დასახელება + მწარმოებელი) გამოტოვდება — არ განახლდება.</li>
        </ol>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" type="button" disabled={tpl.isPending} onClick={() => tpl.mutate()}>შაბლონის გადმოწერა</button>
          <input type="file" aria-label="ფაილი" accept=".xlsx,.csv,.txt" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); run.reset(); }} />
          <span className="grow" />
          <button className="btn" type="button" disabled={!file || run.isPending} onClick={() => run.mutate(false)}>შემოწმება</button>
          <button className="btn primary" type="button" disabled={!file || run.isPending || !res || res.commit || res.created === 0}
            onClick={() => { if (confirm(`დაემატება ${res!.created} საქონელი. გავაგრძელოთ?`)) run.mutate(true); }}>იმპორტი</button>
        </div>
        <ErrorBox error={run.error ?? tpl.error} />
      </section>
      {res && (
        <section className="card">
          <div className={`alert ${res.errors ? 'warn' : 'ok'}`} style={{ margin: 12 }}>
            {res.commit ? 'იმპორტირებულია' : 'შემოწმება (არაფერი შენახულა)'}: {res.created} {res.commit ? 'დაემატა' : 'დაემატება'}{res.generics_created ? ` (ახალი ჯენერიკი: ${res.generics_created})` : ''}, გამოტოვებული {res.skipped}, შეცდომა {res.errors}
          </div>
          <table className="table">
            <thead><tr><th className="num">სტრიქონი</th><th>დასახელება</th><th>სტატუსი</th><th>შენიშვნა</th></tr></thead>
            <tbody>{res.report.map((r) => (
              <tr key={r.row}><td className="num mono">{r.row}</td><td>{r.name || '—'}</td><td><span className={`chip ${ST[r.status][0]}`}>{ST[r.status][1]}</span></td>
                <td className="small">{r.message ?? (r.generic === 'new' ? 'ახალი ჯენერიკი' : r.generic === 'existing' ? 'არსებულ ჯენერიკზე' : '')}</td></tr>))}</tbody>
          </table>
        </section>)}
    </div>
  );
}
