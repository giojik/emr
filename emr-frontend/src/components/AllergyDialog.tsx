import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { ErrorBox, Field, Modal } from './ui';

export default function AllergyDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [substance, setSubstance] = useState('');
  const [type, setType] = useState<'allergy' | 'intolerance'>('allergy');
  const [severity, setSeverity] = useState('');
  const [reaction, setReaction] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/patients/${patientId}/allergies`, { body: { substance, allergy_type: type, severity, reaction_type: reaction || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['patient', patientId] }); void qc.invalidateQueries({ queryKey: ['encounter'] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal title="ალერგიის დამატება" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="alg" disabled={!substance || !severity || m.isPending}>დამატება</button></>}>
      <form id="alg" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <Field label="ნივთიერება / მედიკამენტი" htmlFor="sub" required hint="მაგ. პენიცილინი, იბუპროფენი, იოდშემცველი კონტრასტი">
          <input id="sub" className="input" value={substance} onChange={(e) => setSubstance(e.target.value)} required />
        </Field>
        <div className="field">
          <span className="label">ტიპი <span className="req">*</span></span>
          <div className="seg" role="group" aria-label="ტიპი">
            <button type="button" aria-pressed={type === 'allergy'} onClick={() => setType('allergy')}>ალერგია</button>
            <button type="button" aria-pressed={type === 'intolerance'} onClick={() => setType('intolerance')}>აუტანლობა</button>
          </div>
          <span className="hint">აუტანლობა (მაგ. გულისრევა) არ არის იმუნური რეაქცია — სისტემა მხოლოდ ინფორმაციულ გაფრთხილებას აჩვენებს.</span>
        </div>
        <Field label="სიმძიმე" htmlFor="sev" required>
          <select id="sev" className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} required>
            <option value="">— აირჩიეთ —</option>
            <option value="mild">მსუბუქი (გამონაყარი, ქავილი)</option>
            <option value="moderate">საშუალო (ჭინჭრის ციება, შეშუპება)</option>
            <option value="severe">მძიმე (ანაფილაქსია, ქვინკეს შეშუპება)</option>
          </select>
        </Field>
        <Field label="რეაქცია" htmlFor="rx"><input id="rx" className="input" value={reaction} onChange={(e) => setReaction(e.target.value)} placeholder="მაგ. ანაფილაქსია" /></Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
