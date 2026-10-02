import type { Witness } from './types';

/** მოწმე: მეორე თანამშრომელი ადასტურებს საკუთარი მომხმარებლით და პაროლით (ნარკოტიკული / ფსიქოტროპული) */
export default function WitnessFields({ value, onChange, note }: { value: Witness; onChange: (w: Witness) => void; note?: string }) {
  return (
    <div className="alert warn stack" style={{ gap: 8 }}>
      <strong>მოწმე {note ? `— ${note}` : '(კონტროლირებადი საშუალება)'}</strong>
      <span className="small">მეორე თანამშრომელი (ექთანი, ექიმი, ფარმაცევტი) თავად შეიყვანს საკუთარ მომხმარებელს და პაროლს. პაროლი არ ინახება — მხოლოდ დადასტურების ფაქტი (აუდიტი).</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ width: 280, height: 38 }} aria-label="მოწმის მომხმარებელი" placeholder="მოწმის ელ-ფოსტა / მომხმარებელი" autoComplete="off"
          value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} />
        <input className="input" style={{ width: 220, height: 38 }} aria-label="მოწმის პაროლი" type="password" placeholder="მოწმის პაროლი" autoComplete="new-password"
          value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} />
      </div>
    </div>
  );
}
