import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, apiUpload, openBlob } from '../../api/client';
import type { DxImage, EndoIntervention, PathSpecimen, ReportDetail } from '../../api/types';
import { ErrorBox, Modal, useToast } from '../../components/ui';
import { hhmm, INTERVENTION_KA, SEDATION_KA, tsDate } from '../../lib/format';

const box: React.CSSProperties = { border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 };
const COLON = /COLON|SIGM/;

// ======================================================================= სურათები
function Thumb({ img, onOpen }: { img: DxImage; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null; let alive = true;
    api<Blob>(`/dx-images/${img.id}/file`, { raw: true }).then((b) => { if (!alive) return; u = URL.createObjectURL(b); setUrl(u); }).catch(() => undefined);
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [img.id]);
  return (
    <button type="button" onClick={onOpen} title="სრული ზომით" style={{ border: 0, padding: 0, background: 'var(--surface-2)', borderRadius: 8, overflow: 'hidden', aspectRatio: '4 / 3', cursor: 'zoom-in', width: '100%' }}>
      {url ? <img src={url} alt={img.caption ?? 'სურათი'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : null}
    </button>
  );
}

/** კვლევის სურათები: ატვირთვა, კადრი ვიდეოდან, „ბლანკზე“, წარწერა; წაშლის ნაცვლად — დეაქტივაცია მიზეზით */
export function ImagesBlock({ it, canEdit, onChange }: { it: ReportDetail; canEdit: boolean; onChange: () => void }) {
  const toast = useToast();
  const [capture, setCapture] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) { const fd = new FormData(); fd.append('file', f); fd.append('source', 'upload'); await apiUpload(`/dx-orders/${it.id}/images`, fd); }
      return files.length;
    },
    onSuccess: (n) => { toast.show(`ატვირთულია ${n} სურათი`); onChange(); },
  });
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/dx-images/${id}`, { method: 'PATCH', body }), onSuccess: onChange });
  const imgs = it.images;
  if (!canEdit && !imgs.length) return null;
  return (
    <div style={box}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <strong className="grow">სურათები {imgs.length ? `· ${imgs.length}` : ''} <span className="small muted">({imgs.filter((g) => g.in_report).length}/8 ბლანკზე)</span></strong>
        {canEdit && <>
          <input ref={file} type="file" accept="image/jpeg,image/png" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) upload.mutate(fs); }} />
          <button className="btn sm" type="button" disabled={upload.isPending} onClick={() => file.current?.click()}>ატვირთვა</button>
          <button className="btn sm" type="button" onClick={() => setCapture(true)}>კადრი ვიდეოდან</button>
        </>}
      </div>
      {imgs.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {imgs.map((g, i) => (
          <div key={g.id} className="stack" style={{ gap: 4 }}>
            <Thumb img={g} onOpen={() => void openBlob(`/dx-images/${g.id}/file`)} />
            <div className="row small" style={{ gap: 6 }}>
              <span className="muted">{i + 1}.</span>
              {canEdit ? <input aria-label="წარწერა" className="input grow" style={{ height: 26, fontSize: 12 }} defaultValue={g.caption ?? ''} placeholder="წარწერა"
                onBlur={(e) => { if ((e.target.value || null) !== g.caption) patch.mutate({ id: g.id, body: { caption: e.target.value || null } }); }} /> : <span className="grow">{g.caption}</span>}
            </div>
            <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
              <label className="row grow" style={{ gap: 4, whiteSpace: 'nowrap' }}><input type="checkbox" checked={g.in_report} disabled={!canEdit} onChange={(e) => patch.mutate({ id: g.id, body: { in_report: e.target.checked } })} /> ბლანკზე</label>
              {g.source === 'capture' && <span className="chip" style={{ height: 18, fontSize: 10 }}>კადრი</span>}
              {canEdit && <button className="icon-btn" type="button" aria-label="ამოღება" title="ამოღება (მიზეზით)" onClick={() => { const r = prompt('ამოღების მიზეზი (მაგ. ბუნდოვანი, სხვა პაციენტის):'); if (r && r.trim().length >= 5) patch.mutate({ id: g.id, body: { deactivate_reason: r.trim() } }); }}>×</button>}
            </div>
          </div>))}
      </div>}
      <ErrorBox error={upload.error ?? patch.error} />
      {capture && <CaptureDialog itemId={it.id} onCaptured={onChange} onClose={() => setCapture(false)} />}
      {toast.node}
    </div>
  );
}

/** კადრის გადაღება capture card-იდან (HDMI/SDI → USB). საჭიროებს HTTPS-ს ან localhost-ს (ბრაუზერის წესი) */
function CaptureDialog({ itemId, onCaptured, onClose }: { itemId: string; onCaptured: () => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [dev, setDev] = useState<string>(() => { try { return localStorage.getItem('emr.capture.device') ?? ''; } catch { return ''; } });
  const [err, setErr] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null; let alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: dev ? { deviceId: { exact: dev }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 } }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => undefined); }
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        setDevices(list); setErr(null);
      } catch (e) { setErr(`ვიდეო მოწყობილობა ვერ გაიხსნა: ${(e as Error).message}`); }
    })();
    return () => { alive = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [dev, supported]);

  const shoot = useMutation({
    mutationFn: async () => {
      const v = video.current; if (!v || !v.videoWidth) throw new Error('ვიდეო ჯერ არ არის');
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('კადრი ვერ შეიქმნა'))), 'image/jpeg', 0.9));
      const fd = new FormData(); fd.append('file', blob, 'capture.jpg'); fd.append('source', 'capture');
      return apiUpload(`/dx-orders/${itemId}/images`, fd);
    },
    onSuccess: () => { setCount((n) => n + 1); setFlash(true); setTimeout(() => setFlash(false), 150); onCaptured(); },
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.code === 'Space' || e.key === 'F9') && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); if (!shoot.isPending) shoot.mutate(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [shoot]);

  return (
    <Modal title="კადრი ვიდეოდან" onClose={onClose} width={980}
      footer={<><span className="grow small muted">Space / F9 ან ფეხის პედალი (კლავიშად დაპროგრამებული) — კადრი. გადაღებულია: {count}</span>
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={!supported || shoot.isPending} onClick={() => shoot.mutate()}>კადრი</button></>}>
      {!supported ? <div className="alert warn">ბრაუზერი კამერაზე/capture card-ზე წვდომას მხოლოდ დაცულ კავშირზე (HTTPS) იძლევა. სანამ EMR HTTPS-ზე გადავა, გამოიყენეთ „ატვირთვა“ — ან ენდოსკოპიის კომპიუტერზე Chrome-ში ჩართეთ <span className="mono">chrome://flags/#unsafely-treat-insecure-origin-as-secure</span> ამ მისამართისთვის.</div> : <>
        <select aria-label="ვიდეო წყარო" className="select" style={{ height: 34, maxWidth: 420 }} value={dev} onChange={(e) => { setDev(e.target.value); try { localStorage.setItem('emr.capture.device', e.target.value); } catch { /* */ } }}>
          <option value="">ნაგულისხმევი ვიდეო წყარო</option>{devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `კამერა ${i + 1}`}</option>)}
        </select>
        <video ref={video} muted playsInline style={{ width: '100%', background: '#000', borderRadius: 10, outline: flash ? '4px solid var(--accent)' : 'none', maxHeight: '60vh' }} />
        {err && <div className="alert danger">{err}</div>}
        <ErrorBox error={shoot.error} />
      </>}
    </Modal>
  );
}

// ======================================================================= ენდოსკოპია: მიგნებები / მანიპულაციები
export function EndoFindingsBlock({ it, canEdit, onChange }: { it: ReportDetail; canEdit: boolean; onChange: () => void }) {
  const e = it.endo;
  const colon = COLON.test(it.service_code);
  const [extent, setExtent] = useState(e?.extent_reached ?? '');
  const [withdraw, setWithdraw] = useState(e?.withdrawal_minutes ? String(Number(e.withdrawal_minutes)) : '');
  const [bbps, setBbps] = useState(e?.bbps_score != null ? String(e.bbps_score) : '');
  const [iv, setIv] = useState<EndoIntervention[]>(e?.interventions ?? []);
  const [cx, setCx] = useState<'none' | 'minor' | 'major'>(e?.complications ?? 'none');
  const [cxNote, setCxNote] = useState(e?.complication_note ?? '');
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api(`/dx-orders/${it.id}/endo`, { method: 'PUT', body: {
      extent_reached: extent || null, withdrawal_minutes: withdraw ? Number(withdraw.replace(',', '.')) : null, bbps_score: bbps ? Number(bbps) : null,
      interventions: iv.filter((x) => x.type), complications: cx, complication_note: cx === 'none' ? null : cxNote || null,
    } }),
    onSuccess: () => { toast.show('შენახულია'); onChange(); },
  });
  const dirty = JSON.stringify([extent, withdraw, bbps, iv, cx, cxNote]) !== JSON.stringify([e?.extent_reached ?? '', e?.withdrawal_minutes ? String(Number(e.withdrawal_minutes)) : '', e?.bbps_score != null ? String(e.bbps_score) : '', e?.interventions ?? [], e?.complications ?? 'none', e?.complication_note ?? '']);
  if (!e) return <div className="alert warn small">პროცედურის ჩანაწერი (ექთანი) არ არის.</div>;
  return (
    <div style={box}>
      <div className="small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px' }}>
        <span className="muted">სედაცია</span><span>{[SEDATION_KA[e.sedation_type ?? ''], e.sedation_drugs.map((d) => `${d.drug} ${d.dose} ${d.unit}`).join(', '), e.sedation_by].filter(Boolean).join(' · ') || '—'}</span>
        <span className="muted">ASA / უზმოზე</span><span>{e.asa_class ?? '—'} / {e.fasting_hours ? `${Number(e.fasting_hours)} სთ` : '—'}{e.anticoagulants && e.anticoagulants !== 'none' ? ` · ანტიკოაგულანტი: ${e.anticoagulants === 'stopped' ? 'შეწყვეტილი' : 'იღებს'}${e.anticoag_note ? ` (${e.anticoag_note})` : ''}` : ''}</span>
        <span className="muted">ენდოსკოპი</span><span>{e.scope_name ? `${e.scope_name} · S/N ${e.scope_serial}` : '—'}</span>
        <span className="muted">დრო</span><span>{e.started_at ? `${hhmm(e.started_at)}–${e.ended_at ? hhmm(e.ended_at) : '…'}` : '—'}{e.nurse_name ? ` · ექთანი: ${e.nurse_name}` : ''}</span>
        {e.monitoring.length > 0 && <><span className="muted">მონიტორინგი</span><span>{e.monitoring.map((m) => `${m.time} HR ${m.hr ?? '—'} SpO₂ ${m.spo2 ?? '—'}${m.sys ? ` ${m.sys}/${m.dia}` : ''}`).join(' · ')}</span></>}
      </div>
      <fieldset disabled={!canEdit} className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input aria-label="მიღწეული უბანი" className="input grow" style={{ height: 34, minWidth: 220 }} placeholder={colon ? 'მიღწეული უბანი (მაგ. ბრმა ნაწლავი, ტერმინალური ილეუმი)' : 'მიღწეული უბანი (მაგ. 12-გოჯა ნაწლავის II ნაწილი)'} value={extent} onChange={(ev) => setExtent(ev.target.value)} />
          {colon && <><label className="row small">გამოყვანა (წთ)<input className="input mono" style={{ width: 60, height: 32 }} inputMode="decimal" value={withdraw} onChange={(ev) => setWithdraw(ev.target.value)} /></label>
            <label className="row small">BBPS<select className="select" style={{ width: 70, height: 32 }} value={bbps} onChange={(ev) => setBbps(ev.target.value)}><option value="">—</option>{Array.from({ length: 10 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select></label></>}
        </div>
        <span className="label">მანიპულაციები</span>
        {iv.map((x, i) => (
          <div key={i} className="row">
            <select aria-label="ტიპი" className="select" style={{ width: 200, height: 32 }} value={x.type} onChange={(ev) => setIv(iv.map((y, j) => (j === i ? { ...y, type: ev.target.value } : y)))}>{Object.entries(INTERVENTION_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input aria-label="ლოკალიზაცია" className="input" style={{ width: 200, height: 32 }} placeholder="ლოკალიზაცია" value={x.site ?? ''} onChange={(ev) => setIv(iv.map((y, j) => (j === i ? { ...y, site: ev.target.value } : y)))} />
            <input aria-label="დეტალები" className="input grow" style={{ height: 32 }} placeholder="დეტალები (ზომა, მეთოდი…)" value={x.details ?? ''} onChange={(ev) => setIv(iv.map((y, j) => (j === i ? { ...y, details: ev.target.value } : y)))} />
            <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setIv(iv.filter((_, j) => j !== i))}>×</button>
          </div>))}
        {canEdit && <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setIv([...iv, { type: 'biopsy' }])}>+ მანიპულაცია</button>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="small">გართულება:</span>
          {([['none', 'არა'], ['minor', 'მსუბუქი'], ['major', 'მძიმე']] as const).map(([k, l]) => <label key={k} className="row small"><input type="radio" name={`cx-${it.id}`} checked={cx === k} onChange={() => setCx(k)} /> {l}</label>)}
          {cx !== 'none' && <input aria-label="გართულების აღწერა" className="input grow" style={{ height: 32 }} placeholder="აღწერა *" value={cxNote} onChange={(ev) => setCxNote(ev.target.value)} />}
        </div>
      </fieldset>
      {canEdit && <div className="row"><ErrorBox error={save.error} /><button className="btn sm" type="button" style={{ marginLeft: 'auto' }} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>მანიპულაციების შენახვა</button></div>}
      {toast.node}
    </div>
  );
}

// ======================================================================= ბიოფსია → გარე პათოლოგია
export function BiopsyBlock({ it, canEdit, onChange }: { it: ReportDetail; canEdit: boolean; onChange: () => void }) {
  const p = it.pathology && it.pathology.status !== 'cancelled' ? it.pathology : null;
  const draft = !p || p.status === 'draft';
  const suggested = (it.endo?.interventions ?? []).filter((x) => x.type === 'biopsy' || x.type === 'polypectomy' || x.type === 'emr');
  const [jars, setJars] = useState<PathSpecimen[]>(p?.specimens ?? []);
  const [info, setInfo] = useState(p?.clinical_info ?? it.clinical_note ?? '');
  const [lab, setLab] = useState(p?.external_lab ?? '');
  const toast = useToast();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api(`/dx-orders/${it.id}/pathology`, { method: 'PUT', body: { external_lab: lab || null, clinical_info: info || null, specimens: jars.map((j) => ({ ...j, description: j.description || null })) } }),
    onSuccess: () => { toast.show('ბიოფსია შენახულია'); onChange(); void qc.invalidateQueries({ queryKey: ['pathology'] }); },
  });
  const editable = canEdit && draft;
  if (!p && !suggested.length && !editable) return null;
  if (!p && !editable) return null;
  return (
    <div style={box}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <strong className="grow">ბიოფსია → ჰისტოლოგია {p && <span className="mono small muted">{p.request_no}</span>}</strong>
        {p && <span className={`chip ${p.status === 'resulted' ? 'ok' : p.status === 'sent' ? 'info' : 'warn'}`}>{p.status === 'draft' ? 'გასაგზავნი' : p.status === 'sent' ? `გაგზავნილია ${p.sent_at ? tsDate(p.sent_at) : ''}` : 'პასუხი მიღებულია'}</span>}
        {p && p.specimens.length > 0 && <><button className="btn sm" type="button" onClick={() => void openBlob(`/pathology/${p.id}/labels`)}>ეტიკეტები</button>
          <button className="btn sm" type="button" onClick={() => void openBlob(`/pathology/${p.id}/requisition`)}>მიმართვა</button></>}
      </div>
      {editable && suggested.length > 0 && !jars.length && (
        <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setJars(suggested.map((x, i) => ({ jar_no: i + 1, site: x.site ?? '', pieces: 1, description: [INTERVENTION_KA[x.type], x.details].filter(Boolean).join(', ') })))}>
          ქილები მანიპულაციებიდან ({suggested.length})</button>)}
      {jars.length > 0 && <table className="table small">
        <thead><tr><th style={{ width: 50 }}>ქილა</th><th>ლოკალიზაცია</th><th style={{ width: 70 }}>ფრაგმ.</th><th>აღწერა</th>{editable && <th />}</tr></thead>
        <tbody>{jars.map((j, i) => {
          const upd = (k: keyof PathSpecimen, v: string | number) => setJars(jars.map((x, n) => (n === i ? { ...x, [k]: v } : x)));
          return editable ? (
            <tr key={i}>
              <td><input aria-label="ქილის №" className="input mono" style={{ width: 44, height: 30 }} inputMode="numeric" value={j.jar_no} onChange={(e) => upd('jar_no', Number(e.target.value) || 0)} /></td>
              <td><input aria-label="ლოკალიზაცია" className={`input${!j.site.trim() ? ' invalid' : ''}`} style={{ height: 30 }} value={j.site} onChange={(e) => upd('site', e.target.value)} /></td>
              <td><input aria-label="ფრაგმენტები" className="input mono" style={{ width: 56, height: 30 }} inputMode="numeric" value={j.pieces} onChange={(e) => upd('pieces', Number(e.target.value) || 1)} /></td>
              <td><input aria-label="აღწერა" className="input" style={{ height: 30 }} value={j.description ?? ''} onChange={(e) => upd('description', e.target.value)} /></td>
              <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setJars(jars.filter((_, n) => n !== i))}>×</button></td>
            </tr>) : (
            <tr key={i}><td className="mono">{j.jar_no}</td><td>{j.site}</td><td>{j.pieces}</td><td>{j.description}</td></tr>);
        })}</tbody>
      </table>}
      {editable && <>
        <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setJars([...jars, { jar_no: (Math.max(0, ...jars.map((x) => x.jar_no)) + 1), site: '', pieces: 1, description: '' }])}>+ ქილა</button>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input aria-label="ლაბორატორია" className="input" style={{ height: 34, width: 240 }} placeholder="ლაბორატორია (შეიძლება მოგვიანებით)" value={lab} onChange={(e) => setLab(e.target.value)} />
          <input aria-label="კლინიკური მონაცემი" className="input grow" style={{ height: 34 }} placeholder="კლინიკური მონაცემი პათოლოგისთვის" value={info} onChange={(e) => setInfo(e.target.value)} />
        </div>
        <div className="row"><ErrorBox error={save.error} /><button className="btn sm" type="button" style={{ marginLeft: 'auto' }} disabled={save.isPending || jars.some((j) => !j.site.trim())} onClick={() => save.mutate()}>ბიოფსიის შენახვა</button></div>
        <span className="hint">გაგზავნა და პასუხის შეტანა — ჩანართი „პათოლოგია“.</span>
      </>}
      {p?.status === 'resulted' && <div className="stack small" style={{ gap: 4 }}>
        <strong>ჰისტოლოგიური პასუხი · {p.result_received_at && tsDate(p.result_received_at)}</strong>
        {p.result_text && <div style={{ whiteSpace: 'pre-wrap' }}>{p.result_text}</div>}
        {p.result_file_path && <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => void openBlob(`/pathology/${p.id}/file`)}>სკანი</button>}
      </div>}
      {toast.node}
    </div>
  );
}
