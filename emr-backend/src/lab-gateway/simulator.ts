/**
 * ვირტუალური ანალიზატორი — emr-lab-gateway-ის შესამოწმებლად (რეალური ანალიზატორის გარეშე).
 * იქცევა როგორც ანალიზატორი: ASTM E1381/E1394 (ENQ/ACK, ჩარჩოები, checksum, EOT) ან HL7 MLLP.
 *
 * გამოყენება (კონტეინერში):
 *   docker compose exec emr-lab-gateway node dist/lab-gateway/simulator.js --proto astm --connect 127.0.0.1:4100 \
 *       --query 1000123 \
 *       --result 1000123 GLU=5.4/mmol/L CREA=88 \
 *       --wait 10
 *   --connect HOST:PORT  ანალიზატორი უკავშირდება gateway-ს (gateway — „სერვერი“)
 *   --listen PORT        ანალიზატორი უსმენს (როგორც Moxa TCP Server / LAN ანალიზატორი; gateway — „კლიენტი“)
 *   --query BARCODE      host query: რა ტესტებია ამ სინჯარაზე? (პასუხს ბეჭდავს)
 *   --result BARCODE CODE=VALUE[/UNIT][!FLAG] …   შედეგების გაგზავნა
 *   --qc                 მომდევნო --result — QC ნიმუში
 *   --wait SECONDS       კავშირის შენარჩუნება და შემოსული შეკვეთების ბეჭდვა (push რეჟიმი)
 *   --json               გამოტანა JSON ხაზებით (ტესტებისთვის)
 */
import net from 'node:net';
import { AstmLink, astmNow, comps, delimsFrom, field, testCode } from './astm';
import * as hl7 from './hl7';

type Cmd = { k: 'query'; barcode: string } | { k: 'result'; barcode: string; items: { code: string; value: string; unit?: string; flag?: string }[]; qc: boolean } | { k: 'wait'; sec: number }
  | { k: 'text'; text: string };
/** სატესტო გრაფიკა: პატარა PNG და ჰისტოგრამა (გაუსი, 64 წერტილი) */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAIAAAAzn+mLAAAAzUlEQVR42u2XwQ6AIAxDt8X//+V5IEFEgY6awMFdjIctj7YgqrvLTmWyWR3poboeJVl1VO+rKiuygWV3d2wLmoLJmGYWJY8q4mIzNDxTiXIPr4X7+W35JsyUZamf2Y0Nm4JATzHSrKhIbZsiQP0F4UwjYTCgzhQ8TNmmrjARy1pTECZYGAAoLwthfTIB+Y0A4eHoZwuzaQQUXVm16aaEqa8fjOvvus4eVxYLMmJc3KY2EPNB4M/xGojz/qs73pUhFXdRFZel11n9/zoGdQIkDls2N+vzsAAAAABJRU5ErkJggg==';
const histogram = () => Array.from({ length: 64 }, (_, i) => Math.round(1000 * Math.exp(-((i - 24) ** 2) / 90))).join(',');
const args = process.argv.slice(2);
let proto: 'astm' | 'hl7' | 'text' = 'astm'; let dsrMode = false; let wrap = false; let connect: string | null = null; let listen: number | null = null; let json = false; let name = 'EMR-SIM';
const cmds: Cmd[] = []; let qc = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--proto') proto = args[++i] as 'astm' | 'hl7' | 'text';
  else if (a === '--dsr') dsrMode = true;
  else if (a === '--wrap') wrap = true;
  else if (a === '--text') cmds.push({ k: 'text', text: args[++i].replace(/\\n/g, '\n') });
  else if (a === '--histogram') { const b = args[++i]; const code = args[++i]; cmds.push({ k: 'result', barcode: b, items: [{ code, value: histogram() }], qc: false }); }
  else if (a === '--image') { const b = args[++i]; const code = args[++i]; cmds.push({ k: 'result', barcode: b, items: [{ code, value: proto === 'hl7' ? `^Image^PNG^Base64^${PNG_B64}` : PNG_B64 }], qc: false }); }
  else if (a === '--connect') connect = args[++i];
  else if (a === '--listen') listen = Number(args[++i]);
  else if (a === '--json') json = true;
  else if (a === '--name') name = args[++i];
  else if (a === '--qc') qc = true;
  else if (a === '--query') cmds.push({ k: 'query', barcode: args[++i] });
  else if (a === '--wait') cmds.push({ k: 'wait', sec: Number(args[++i]) });
  else if (a === '--result') {
    const barcode = args[++i]; const items: { code: string; value: string; unit?: string; flag?: string }[] = [];
    while (args[i + 1] && !args[i + 1].startsWith('--')) {
      const m = /^([^=]+)=([^/!]*)(?:\/([^!]*))?(?:!(.*))?$/.exec(args[++i]);
      if (!m) { console.error(`არასწორი: ${args[i]} (ფორმატი CODE=VALUE[/UNIT][!FLAG])`); process.exit(2); }
      items.push({ code: m[1], value: m[2], unit: m[3], flag: m[4] });
    }
    cmds.push({ k: 'result', barcode, items, qc }); qc = false;
  } else { console.error(`უცნობი პარამეტრი: ${a}`); process.exit(2); }
}
if (!connect && !listen) { console.error('მიუთითეთ --connect HOST:PORT ან --listen PORT'); process.exit(2); }

const out = (type: string, data: Record<string, unknown>) => {
  if (json) console.log(JSON.stringify({ type, ...data }));
  else console.log(`[${type}] ${Object.entries(data).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join(' ')}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function socket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (connect) {
      const [h, p] = connect.split(':');
      const s = net.createConnection({ host: h, port: Number(p) }, () => { out('connected', { to: connect }); resolve(s); });
      s.once('error', reject);
    } else {
      const srv = net.createServer((s) => { out('connected', { from: `${s.remoteAddress}:${s.remotePort}` }); srv.close(); resolve(s); });
      srv.listen(listen!, () => out('listening', { port: listen }));
      setTimeout(() => reject(new Error('gateway არ დაუკავშირდა 60 წამში')), 60_000).unref();
    }
  });
}

// ======================================================================= ASTM
async function runAstm(s: net.Socket) {
  const link = new AstmLink((b) => s.write(b), { instrument: true });
  s.on('data', (d) => link.feed(d));
  const orders: { barcode: string; codes: string[]; none: boolean }[] = [];
  let waiter: (() => void) | null = null;
  link.on('message', (recs: string[]) => {
    const d = delimsFrom(recs.find((r) => r.startsWith('H')));
    for (const r of recs.filter((x) => x.startsWith('O'))) {
      const barcode = comps(field(r, d, 3), d).find((x) => x) ?? '';
      const codes = field(r, d, 5).split(d.repeat).map((t) => testCode(t, d, 4)).filter(Boolean);
      const o = { barcode, codes, none: field(r, d, 26) === 'Y' };
      orders.push(o); out('orders', o);
    }
    waiter?.();
  });
  link.on('log', (t: string) => out('log', { text: t }));
  const H = `H|\\^&|||${name}^1.0|||||||P|1|${astmNow()}`;
  for (const c of cmds) {
    if (c.k === 'result') {
      const recs = [H, 'P|1', `O|1|${c.barcode}||${c.items.map((x) => `^^^${x.code}`).join('\\')}|R|${astmNow()}|||||${c.qc ? 'Q' : 'N'}||||||||||||||F`,
        ...c.items.map((x, i) => `R|${i + 1}|^^^${x.code}|${x.value}|${x.unit ?? ''}||${x.flag ?? ''}||F||||${astmNow()}`), 'L|1|N'];
      await link.send(recs); out('sent', { barcode: c.barcode, results: c.items.map((x) => `${x.code}=${x.value}`) });
      await sleep(300);
    } else if (c.k === 'query') {
      const before = orders.length;
      await link.send([H, `Q|1|^${c.barcode}||ALL||||||||O`, 'L|1|N']); out('sent', { query: c.barcode });
      const t0 = Date.now();
      while (orders.length === before && Date.now() - t0 < 20_000) await new Promise<void>((r) => { waiter = r; setTimeout(r, 500); });
      if (orders.length === before) { out('error', { text: `ქვერის პასუხი არ მოვიდა (${c.barcode})` }); process.exitCode = 1; }
    } else if (c.k === 'wait') await sleep(c.sec * 1000);
  }
  await sleep(300); s.end();
}

// ======================================================================= HL7
async function runHl7(s: net.Socket) {
  const inbox: hl7.Hl7[] = []; let waiter: (() => void) | null = null;
  const dec = new hl7.MllpDecoder((raw) => {
    const m = hl7.parse(raw); inbox.push(m);
    if (m.type === 'ORM' || m.type === 'OML') {
      const barcode = hl7.comp(hl7.f(m.segs.find((x) => x[0] === 'OBR'), 2), m.cs) || hl7.comp(hl7.f(m.segs.find((x) => x[0] === 'ORC'), 2), m.cs);
      const codes = m.segs.filter((x) => x[0] === 'OBR').map((x) => hl7.comp(hl7.f(x, 4), m.cs)).filter(Boolean);
      out('orders', { barcode, codes, none: false });
      s.write(hl7.mllp(hl7.ack(m, 'AA')));
    } else if (m.type === 'ACK') out('ack', { code: hl7.f(m.segs.find((x) => x[0] === 'MSA'), 1), text: hl7.f(m.segs.find((x) => x[0] === 'MSA'), 3) });
    waiter?.();
  });
  s.on('data', (d) => dec.feed(d));
  const waitFor = async (pred: (m: hl7.Hl7) => boolean, ms: number) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) return null;
      await new Promise<void>((r) => { waiter = r; setTimeout(r, 300); });
    }
  };
  for (const c of cmds) {
    if (c.k === 'result') {
      s.write(hl7.mllp(hl7.oru(c.barcode, c.items))); out('sent', { barcode: c.barcode, results: c.items.map((x) => `${x.code}=${x.value}`) });
      if (!(await waitFor((m) => m.type === 'ACK', 10_000))) { out('error', { text: 'ACK არ მოვიდა' }); process.exitCode = 1; }
    } else if (c.k === 'query') {
      s.write(hl7.mllp(hl7.qry(c.barcode))); out('sent', { query: c.barcode });
      if (dsrMode) {   // QCK^Q02 → DSR^Q03 (DSP სეგმენტები: 21 — შტრიხკოდი, 29+ — ტესტები „კოდი^^^“)
        const q = await waitFor((m) => m.type === 'QCK', 10_000);
        const d = q && hl7.f(q.segs.find((x) => x[0] === 'QAK'), 2) === 'OK' ? await waitFor((m) => m.type === 'DSR', 10_000) : null;
        const dsp = (d?.segs ?? []).filter((x) => x[0] === 'DSP');
        out('orders', { barcode: dsp.find((x) => x[1] === '21')?.[3] ?? c.barcode, codes: dsp.filter((x) => Number(x[1]) >= 29 && x[3]?.endsWith('^^^')).map((x) => x[3].replace(/\^+$/, '')), none: !d, dsr: true });
        continue;
      }
      await waitFor((m) => m.type === 'ACK', 10_000);
      if (!(await waitFor((m) => m.type === 'ORM' || m.type === 'OML', 8_000))) out('orders', { barcode: c.barcode, codes: [], none: true });
    } else if (c.k === 'wait') await sleep(c.sec * 1000);
  }
  await sleep(300); s.end();
}

async function runText(s: net.Socket) {
  s.on('data', (d) => out('received', { bytes: d.length, ack: d[0] === 0x06 }));
  for (const c of cmds) {
    if (c.k === 'text') { s.write(wrap ? Buffer.concat([Buffer.from([0x02]), Buffer.from(c.text, 'latin1'), Buffer.from([0x03])]) : Buffer.from(c.text, 'latin1')); out('sent', { text: c.text.length }); await sleep(2500); }
    else if (c.k === 'wait') await sleep(c.sec * 1000);
  }
  await sleep(300); s.end();
}
socket().then((s) => (proto === 'astm' ? runAstm(s) : proto === 'text' ? runText(s) : runHl7(s)))
  .then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200))
  .catch((e: Error) => { out('error', { text: e.message }); process.exit(1); });

