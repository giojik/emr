import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { useModules, type LicenseStatus } from '../../lib/modules';

interface LicenseHistory { id: string; kid: string; clinic: string; modules: string[]; issued: string; expires: string | null; max_users: number | null; uploaded_at: string; removed_at: string | null; uploaded_by_name: string | null }
interface Verified { ok: boolean; clinic: string; modules: string[]; issued: string; expires: string | null; max_users: number | null; kid: string }

export const PHASE_KA: Record<string, [string, string]> = {
  valid: ['მოქმედია', 'ok'], warning: ['ვადა იწურება', 'warn'], grace: ['შეღავათიანი პერიოდი', 'warn'], expired: ['ვადა გავიდა — მხოლოდ წაკითხვა', 'danger'],
};

/** ადმინისტრირება → ლიცენზია (0085): სტატუსი, ინსტალაციის ID, ატვირთვა (შემოწმებით), ისტორია */
export default function License() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['license'], queryFn: () => api<{ status: LicenseStatus; history: LicenseHistory[] }>('/license') });
  const mods = useModules();
  const [file, setFile] = useState<{ name: string; json: unknown } | null>(null);
  const [parseErr, setParseErr] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['license'] }); void qc.invalidateQueries({ queryKey: ['license-status'] }); void qc.invalidateQueries({ queryKey: ['modules'] }); };
  const verify = useMutation({ mutationFn: (json: unknown) => api<Verified>('/license/verify', { body: { license: json } }) });
  const upload = useMutation({ mutationFn: () => api<LicenseStatus>('/license', { body: { license: file?.json } }),
    onSuccess: () => { setFile(null); verify.reset(); toast.show('ლიცენზია დაყენდა'); refresh(); } });
  const remove = useMutation({ mutationFn: () => api<LicenseStatus>('/license', { method: 'DELETE' }), onSuccess: () => { toast.show('ლიცენზია მოიხსნა'); refresh(); } });

  const pick = async (f: File | undefined) => {
    setParseErr(''); verify.reset(); upload.reset(); setFile(null);
    if (!f) return;
    if (f.size > 64 * 1024) { setParseErr('ფაილი ძალიან დიდია'); return; }
    try { const json = JSON.parse(await f.text()) as unknown; setFile({ name: f.name, json }); verify.mutate(json); }
    catch { setParseErr('ფაილი JSON არ არის'); }
  };
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const st = q.data?.status;
  const name = (c: string) => mods.data?.find((m) => m.code === c)?.name ?? c;
  const copy = () => { if (st?.install_id) void navigator.clipboard?.writeText(st.install_id).then(() => toast.show('დაკოპირდა')); };
  return (
    <div className="content">
      {toast.node}
      <ErrorBox error={q.error} />
      {st && <section className="card card-pad stack">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h2 className="grow" style={{ margin: 0 }}>{st.mode === 'licensed' ? st.clinic : st.mode === 'dev' ? 'სატესტო რეჟიმი (ლიცენზიის გარეშე)' : 'ლიცენზია არ არის'}</h2>
          {st.mode === 'licensed' && st.phase && <span className={`chip ${PHASE_KA[st.phase][1]}`}>{PHASE_KA[st.phase][0]}</span>}
          {st.mode === 'dev' && <span className="chip info">DEV — ყველა მოდული</span>}
          {st.mode === 'none' && <span className="chip danger">მხოლოდ ბირთვი</span>}
          {st.test_key && <span className="chip warn">სატესტო გასაღები</span>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 24 }}>
          <div className="stack" style={{ gap: 2 }}><span className="small muted">ინსტალაციის ID (ლიცენზიის მოთხოვნისთვის)</span>
            <span className="row"><span className="mono">{st.install_id}</span><button type="button" className="btn" onClick={copy}>კოპირება</button></span></div>
          {st.mode === 'licensed' && <>
            <div className="stack" style={{ gap: 2 }}><span className="small muted">გაცემა / ვადა</span>
              <span>{st.issued ? dateGe(st.issued) : '—'} — {st.expires ? `${dateGe(st.expires)}${st.days_left !== null && st.days_left !== undefined ? ` (${st.days_left >= 0 ? `დარჩა ${st.days_left} დღე` : `გავიდა ${-st.days_left} დღის წინ`})` : ''}` : 'უვადო'}</span></div>
            {st.phase === 'grace' && st.grace_until && <div className="stack" style={{ gap: 2 }}><span className="small muted">შეღავათი</span><span>{tsDate(st.grace_until)}-მდე</span></div>}
            <div className="stack" style={{ gap: 2 }}><span className="small muted">მომხმარებლები</span>
              <span className={st.users_warn ? 'hint err' : ''}>{st.users_active}{st.max_users ? ` / ${st.max_users}` : ' (ლიმიტის გარეშე)'}</span></div>
          </>}
        </div>
        {st.mode === 'licensed' && Array.isArray(st.modules) && <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">ლიცენზირებული მოდულები ({st.modules.length}) — ბირთვი ყოველთვის შედის</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{st.modules.map((m) => <span key={m} className="chip">{name(m)}</span>)}</div>
          {!!st.unknown_modules?.length && <span className="hint">ამ ვერსიისთვის უცნობი (იგნორირდება): {st.unknown_modules.join(', ')}</span>}
        </div>}
        <span className="hint">
          ვადამდე 30 დღით ადრე — გაფრთხილება; ვადის შემდეგ 30 დღე სისტემა სრულად მუშაობს; შემდეგ ოპციური მოდულები მხოლოდ წაკითხვის რეჟიმშია (ნახვა / ბეჭდვა — კი, ახალი ჩანაწერი — არა).
          ბირთვი (პაციენტები, რეგისტრატურა, ბილინგი) და კლინიკური ისტორია არასდროს იბლოკება.
        </span>
      </section>}

      <section className="card card-pad stack">
        <h2 style={{ margin: 0 }}>ახალი ლიცენზიის ატვირთვა</h2>
        <input className="input" type="file" accept=".json,application/json" aria-label="ლიცენზიის ფაილი" onChange={(e) => void pick(e.target.files?.[0])} />
        {parseErr && <span className="hint err">{parseErr}</span>}
        <ErrorBox error={verify.error} />
        {verify.data && <div className="stack" style={{ gap: 4 }}>
          <span className="chip ok" style={{ alignSelf: 'flex-start' }}>ხელმოწერა სწორია</span>
          <span><strong>{verify.data.clinic}</strong> · {dateGe(verify.data.issued)} — {verify.data.expires ? dateGe(verify.data.expires) : 'უვადო'} · მომხმარებლები: {verify.data.max_users ?? 'ლიმიტის გარეშე'}</span>
          <span className="small">მოდულები ({verify.data.modules.length}): {verify.data.modules.map(name).join(', ')}</span>
          <div className="row"><button className="btn primary" type="button" disabled={upload.isPending} onClick={() => upload.mutate()}>დაყენება</button>
            <span className="small muted">ძველი ლიცენზია ისტორიაში რჩება</span></div>
        </div>}
        <ErrorBox error={upload.error} />
      </section>

      <section className="card">
        <div className="card-pad row"><h2 className="grow" style={{ margin: 0 }}>ისტორია</h2>
          {st?.mode === 'licensed' && <button className="btn" type="button" disabled={remove.isPending} title="მხოლოდ სატესტო გარემოში"
            onClick={() => { if (window.confirm('მოიხსნას მიმდინარე ლიცენზია? (მხოლოდ სატესტო გარემო)')) remove.mutate(); }}>მოხსნა (dev)</button>}</div>
        <ErrorBox error={remove.error} />
        {!q.data?.history.length ? <div className="empty">ლიცენზია ჯერ არ ატვირთულა.</div> : (
          <table className="table">
            <thead><tr><th>ატვირთვა</th><th>კლინიკა</th><th>ვადა</th><th>მოდულები</th><th>გასაღები</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data.history.map((h, i) => (
              <tr key={h.id}>
                <td>{tsDate(h.uploaded_at)}<div className="small muted">{h.uploaded_by_name || 'CLI'}</div></td>
                <td>{h.clinic}</td><td>{h.expires ? dateGe(h.expires) : 'უვადო'}</td><td>{h.modules.length}</td><td className="mono small">{h.kid}</td>
                <td>{h.removed_at ? <span className="chip">მოხსნილი</span> : i === q.data.history.findIndex((x) => !x.removed_at) ? <span className="chip ok">მიმდინარე</span> : <span className="chip">ჩანაცვლებული</span>}</td>
              </tr>))}</tbody>
          </table>)}
      </section>
    </div>
  );
}
