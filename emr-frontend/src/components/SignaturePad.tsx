import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface SignaturePadHandle { toDataURL: () => string | null; clear: () => void }

/** ხელმოწერა თითით / სტილუსით / მაუსით (pointer events — ტაბლეტი, სენსორული ეკრანი, ხელმოწერის პადი) */
const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (empty: boolean) => void }>(function SignaturePad({ onChange }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const points = useRef(0);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current!; const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d')!; ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1B221F';
  }, []);

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const clear = () => {
    const c = canvas.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    points.current = 0; setEmpty(true); onChange?.(true);
  };
  useImperativeHandle(ref, () => ({
    clear,
    // ცარიელი ან თითქმის ცარიელი (შემთხვევითი შეხება) ხელმოწერად არ ითვლება
    toDataURL: () => (points.current < 12 ? null : canvas.current!.toDataURL('image/png')),
  }));

  return (
    <div className="stack" style={{ gap: 6 }}>
      <canvas ref={canvas} aria-label="ხელმოწერის ველი" role="img"
        style={{ width: '100%', height: 180, border: '1px dashed var(--control)', borderRadius: 10, background: '#fff', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={(e) => { drawing.current = true; canvas.current!.setPointerCapture(e.pointerId); const [x, y] = pos(e); const ctx = canvas.current!.getContext('2d')!; ctx.beginPath(); ctx.moveTo(x, y); }}
        onPointerMove={(e) => {
          if (!drawing.current) return; const [x, y] = pos(e); const ctx = canvas.current!.getContext('2d')!;
          ctx.lineTo(x, y); ctx.stroke(); points.current++;
          if (empty && points.current >= 12) { setEmpty(false); onChange?.(false); }
        }}
        onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }} />
      <div className="row"><span className="hint grow">{empty ? 'მოაწერეთ ხელი ჩარჩოში' : 'ხელმოწერა მიღებულია'}</span><button type="button" className="btn sm" onClick={clear}>გასუფთავება</button></div>
    </div>
  );
});
export default SignaturePad;
