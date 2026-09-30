import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import net from 'node:net';
import os from 'node:os';
import { InjectDb, type Database } from '../database/database.module';
import { AstmLink, buildNoOrder, buildOrder, DEFAULT_ASTM, delimsFrom, parseMessage, type AstmSettings } from './astm';
import * as hl7 from './hl7';
import { LabAlertsService } from './lab-alerts.service';
import { LabIngestService, type OrderInfo } from './lab-ingest.service';
import { DEFAULT_TEXT, parseText, TextFramer, type TextSettings } from './text';

interface InstrumentCfg {
  id: string; name: string; protocol: 'astm' | 'hl7' | 'text'; conn_mode: 'client' | 'server'; host: string | null; port: number;
  order_mode: 'none' | 'query' | 'push'; settings: Record<string, unknown>; updated_at: Date; listen_only: boolean;
}
const RECONNECT_MS = 5_000;
const PUSH_EVERY_MS = 5_000;
const RELOAD_EVERY_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const RETENTION_DAYS = 30;
const COMMANDS_EVERY_MS = 2_000;
const ALERTS_EVERY_MS = 60_000;

/** TCP-ის შემოწმება (+ ASTM: ENQ → ACK → EOT) — ახალ, დროებით კავშირზე */
function tcpTest(host: string, port: number, astmProbe: boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const s = net.createConnection({ host, port });
    const finish = (r: Record<string, unknown>) => { if (done) return; done = true; s.destroy(); resolve({ host, port, ...r }); };
    s.setTimeout(5000, () => finish({ ok: false, error: 'timeout (5 წმ) — მისამართი/პორტი მიუწვდომელია ან firewall ბლოკავს' }));
    s.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code === 'ECONNREFUSED' ? 'კავშირი უარყოფილია (პორტზე არაფერი უსმენს ან დაკავებულია)' : e.message }));
    s.once('connect', () => {
      const ms = Date.now() - t0;
      if (!astmProbe) { finish({ ok: true, ms }); return; }
      s.once('data', (d) => {
        const b = d[0];
        if (b === 0x06) s.write(Buffer.from([0x04]));
        finish({ ok: true, ms, astm: b === 0x06 ? 'ACK' : b === 0x15 ? 'NAK (დაკავებულია)' : b === 0x05 ? 'ENQ (აგზავნის)' : `უცნობი პასუხი 0x${b.toString(16)}` });
      });
      s.write(Buffer.from([0x05]));
      setTimeout(() => finish({ ok: true, ms, astm: null, warning: 'TCP კავშირი არის, მაგრამ ENQ-ზე პასუხი არ მოვიდა (5 წმ) — შეამოწმეთ პროტოკოლი / სერიული პარამეტრები' }), 5000);
    });
  });
}

/** ერთი ანალიზატორი: TCP კავშირი (კლიენტი ან სერვერი) + პროტოკოლის სესია */
class Runner {
  private sock: net.Socket | null = null;
  private server: net.Server | null = null;
  private stopped = false;
  private reconnect: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private astm: AstmLink | null = null;
  private hl7Waiter: { resolve: (ok: boolean, text?: string) => void; timer: NodeJS.Timeout } | null = null;
  private pushing = false;
  private readonly log: Logger;

  constructor(readonly cfg: InstrumentCfg, private readonly m: GatewayManager) { this.log = new Logger(`Lab:${cfg.name}`); }

  get sendName() { return this.cfg.settings.send_patient_name === true; }
  private get astmSettings(): AstmSettings {
    const s = this.cfg.settings;
    return { specimen_field: Number(s.specimen_field) || DEFAULT_ASTM.specimen_field, code_component: Number(s.code_component) || DEFAULT_ASTM.code_component,
      query_component: Number(s.query_component) || null };
  }

  start() {
    if (this.cfg.conn_mode === 'server') {
      this.server = net.createServer((s) => this.attach(s));
      this.server.on('error', (e) => { void this.m.status(this.cfg.id, 'error', null, e.message); this.log.error(e.message); });
      this.server.listen(this.cfg.port, () => { void this.m.status(this.cfg.id, 'listening', null, null); this.log.log(`უსმენს :${this.cfg.port}`); });
    } else this.connect();
    this.pushTimer = setInterval(() => void this.pushTick(), PUSH_EVERY_MS);
  }
  stop() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.astm?.close(); this.sock?.destroy(); this.server?.close();
  }

  private connect() {
    if (this.stopped) return;
    void this.m.status(this.cfg.id, 'connecting', `${this.cfg.host}:${this.cfg.port}`, null);
    const s = net.createConnection({ host: this.cfg.host ?? '', port: this.cfg.port });
    s.setTimeout(10_000, () => { if (!this.sock) s.destroy(new Error('კავშირის timeout')); });
    s.once('connect', () => { s.setTimeout(0); this.attach(s); });
    s.once('error', (e) => { if (!this.sock) { void this.m.status(this.cfg.id, 'error', `${this.cfg.host}:${this.cfg.port}`, e.message); this.retry(); } });
  }
  private retry() { if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), RECONNECT_MS); }

  /** ახალი სოკეტი (კლიენტის კავშირი ან სერვერზე შემოსული) — ძველი იცვლება ახლით */
  private attach(s: net.Socket) {
    if (this.sock) { this.log.warn('ახალი კავშირი — ძველი იხურება'); this.astm?.close(); this.sock.destroy(); }
    this.sock = s; s.setKeepAlive(true, 30_000); s.setNoDelay(true);
    const peer = `${s.remoteAddress?.replace('::ffff:', '')}:${s.remotePort}`;
    void this.m.status(this.cfg.id, 'connected', peer, null);
    this.log.log(`დაკავშირდა ${peer}`);
    if (this.cfg.protocol === 'text') {
      const framer = new TextFramer(this.textSettings, (t) => void this.onText(t));
      s.on('data', (d) => framer.feed(d));
      s.once('close', () => framer.close());
    } else if (this.cfg.protocol === 'astm') {
      const link = new AstmLink((b) => s.write(b));
      this.astm = link;
      link.on('message', (recs: string[]) => void this.onAstm(recs));
      link.on('log', (t: string) => this.log.warn(t));
      link.on('error', (e: Error) => this.log.warn(e.message));
      s.on('data', (d) => link.feed(d));
    } else {
      const dec = new hl7.MllpDecoder((msg) => void this.onHl7(msg));
      s.on('data', (d) => dec.feed(d));
    }
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null; this.astm?.close(); this.astm = null;
      if (this.hl7Waiter) { clearTimeout(this.hl7Waiter.timer); this.hl7Waiter.resolve(false, 'კავშირი გაწყდა'); this.hl7Waiter = null; }
      void this.m.status(this.cfg.id, this.cfg.conn_mode === 'server' ? 'listening' : 'offline', null, null);
      this.log.warn('კავშირი დაიხურა');
      if (this.cfg.conn_mode === 'client') this.retry();
    });
    s.on('error', (e) => this.log.warn(e.message));
  }

  // ---------------------------------------------------------------- ASTM
  private async onAstm(recs: string[]) {
    try {
      const p = parseMessage(recs, this.astmSettings);
      const kind = p.queries.length ? 'query' : p.results.length ? 'results' : 'other';
      const msgId = await this.m.message(this.cfg.id, 'in', kind, recs.join('\n'),
        kind === 'results' ? `${p.results.length} შედეგი · ${[...new Set(p.results.map((r) => r.barcode))].join(', ')}` : kind === 'query' ? `ქვერი: ${p.queries.map((q) => q.barcode).join(', ')}` : null);
      await this.m.seen(this.cfg.id, p.results);
      if (p.results.length && !this.cfg.listen_only) {
        const r = await this.m.ingest.ingest(this.cfg.id, msgId, p.results);
        this.log.log(`შედეგები: მიბმული ${r.applied}, დასამუშავებელი ${r.unmatched}`);
      }
      const d = delimsFrom(recs.find((r) => r.startsWith('H')));
      for (const q of p.queries) {
        const o = this.cfg.order_mode === 'none' || this.cfg.listen_only ? null : await this.m.ingest.ordersForBarcode(this.cfg.id, q.barcode, this.sendName);
        const out = o?.codes.length ? buildOrder({ ...o, reportType: 'Q' }, d) : buildNoOrder(q.barcode, d);
        await this.m.message(this.cfg.id, 'out', 'orders', out.join('\n'), o?.codes.length ? `${q.barcode}: ${o.codes.join(', ')}` : `${q.barcode}: შეკვეთა არ არის`);
        await this.astm?.send(out).catch((e: Error) => this.m.message(this.cfg.id, 'out', 'orders', out.join('\n'), null, e.message));
      }
    } catch (e) {
      this.log.error((e as Error).message);
      await this.m.message(this.cfg.id, 'in', 'other', recs.join('\n'), null, (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- ცალმხრივი ტექსტი
  get textSettings(): TextSettings { return { ...DEFAULT_TEXT, ...(this.cfg.settings as Partial<TextSettings>) }; }
  private async onText(text: string) {
    try {
      const p = parseText(text, this.textSettings);
      const id = await this.m.message(this.cfg.id, 'in', 'results', text, p.error ? null : `${p.results.length} შედეგი · ${p.barcode}`, p.error ?? undefined);
      if (this.textSettings.ack) this.sock?.write(Buffer.from([0x06]));
      await this.m.seen(this.cfg.id, p.results);
      if (!p.error && p.results.length && !this.cfg.listen_only) {
        const r = await this.m.ingest.ingest(this.cfg.id, id, p.results);
        this.log.log(`შედეგები: მიბმული ${r.applied}, დასამუშავებელი ${r.unmatched}`);
      }
    } catch (e) { this.log.error((e as Error).message); }
  }

  // ---------------------------------------------------------------- HL7
  private async onHl7(raw: string) {
    let m: hl7.Hl7;
    try { m = hl7.parse(raw); } catch { return; }
    try {
      if (m.type === 'ACK') {
        await this.m.message(this.cfg.id, 'in', 'ack', raw.replace(/\r/g, '\n'), null);
        const msa = m.segs.find((s) => s[0] === 'MSA');
        if (this.hl7Waiter) { clearTimeout(this.hl7Waiter.timer); this.hl7Waiter.resolve(hl7.f(msa, 1) === 'AA' || hl7.f(msa, 1) === 'CA', hl7.f(msa, 3)); this.hl7Waiter = null; }
        return;
      }
      const settings = { barcode_field: (this.cfg.settings.barcode_field as hl7.Hl7Settings['barcode_field']) || hl7.DEFAULT_HL7.barcode_field,
        code_component: Number(this.cfg.settings.code_component) || hl7.DEFAULT_HL7.code_component };
      if (m.type === 'ORU' || m.type === 'OUL') {
        const res = hl7.results(m, settings);
        const id = await this.m.message(this.cfg.id, 'in', 'results', raw.replace(/\r/g, '\n'), `${res.length} შედეგი · ${[...new Set(res.map((r) => r.barcode))].join(', ')}`);
        await this.m.seen(this.cfg.id, res);
        if (!this.cfg.listen_only) {
          const r = await this.m.ingest.ingest(this.cfg.id, id, res);
          this.log.log(`შედეგები: მიბმული ${r.applied}, დასამუშავებელი ${r.unmatched}`);
        }
        this.write(hl7.ack(m, 'AA'));
        return;
      }
      if (m.type === 'QRY' || m.type === 'QBP') {
        const b = hl7.queryBarcode(m);
        await this.m.message(this.cfg.id, 'in', 'query', raw.replace(/\r/g, '\n'), `ქვერი: ${b ?? '?'}`);
        if (this.cfg.settings.hl7_query_reply !== 'dsr') this.write(hl7.ack(m, 'AA'));
        const o = b && this.cfg.order_mode !== 'none' && !this.cfg.listen_only ? await this.m.ingest.ordersForBarcode(this.cfg.id, b, this.sendName) : null;
        if (this.cfg.settings.hl7_query_reply === 'dsr') {   // Mindray-ის ტიპი: QCK^Q02 + DSR^Q03 (ACK-ის ნაცვლად)
          const found = !!o?.codes.length;
          this.write(hl7.qck(m, found));
          if (found) { const d = hl7.dsr(m, o!); await this.m.message(this.cfg.id, 'out', 'orders', d.replace(/\r/g, '\n'), `${b}: ${o!.codes.join(', ')} (DSR)`); this.write(d); }
          else await this.m.message(this.cfg.id, 'out', 'orders', `${b ?? '?'}: შეკვეთა არ არის (QAK NF)`, `${b ?? '?'}: შეკვეთა არ არის`);
          return;
        }
        if (o?.codes.length) await this.sendOrm(o);
        else await this.m.message(this.cfg.id, 'out', 'orders', `${b ?? '?'}: შეკვეთა არ არის`, `${b ?? '?'}: შეკვეთა არ არის`);
        return;
      }
      await this.m.message(this.cfg.id, 'in', 'other', raw.replace(/\r/g, '\n'), `${m.type}^${m.event}`);
      this.write(hl7.ack(m, 'AA'));
    } catch (e) {
      this.log.error((e as Error).message);
      await this.m.message(this.cfg.id, 'in', 'other', raw.replace(/\r/g, '\n'), null, (e as Error).message);
      this.write(hl7.ack(m, 'AE', (e as Error).message));
    }
  }
  private write(msg: string) { this.sock?.write(hl7.mllp(msg)); }

  /** მართვის პანელის „შემოწმება“: არსებული კავშირით (ASTM — ENQ/ACK), ან ახალი TCP ცდით */
  async test(): Promise<Record<string, unknown>> {
    if (this.sock) {
      const peer = `${this.sock.remoteAddress?.replace('::ffff:', '')}:${this.sock.remotePort}`;
      if (this.cfg.protocol !== 'astm') return { ok: true, via: 'existing', peer, note: 'კავშირი არის (HL7-ში ცალკე „ping“ არ არსებობს — იხ. ბოლო შეტყობინება)' };
      if (!this.astm || this.astm.busy) return { ok: true, via: 'existing', peer, note: 'კავშირი არის, ახლა მიმდინარეობს მონაცემთა გაცვლა' };
      const a = await this.astm.probe();
      return a ? { ok: true, via: 'existing', peer, astm: a } : { ok: false, via: 'existing', peer, error: 'TCP კავშირი არის, მაგრამ ENQ-ზე პასუხი არ მოვიდა — შეამოწმეთ ანალიზატორი / სერიული პარამეტრები' };
    }
    if (this.cfg.conn_mode === 'server') return { ok: false, listening: !!this.server?.listening, error: `ანალიზატორი ჯერ არ დაკავშირებულა — gateway ელოდება :${this.cfg.port}-ზე` };
    return tcpTest(this.cfg.host ?? '', this.cfg.port, this.cfg.protocol === 'astm');
  }
  private sendOrm(o: OrderInfo): Promise<boolean> {
    const msg = hl7.orm(o, { app: '', fac: '' }, String(this.cfg.settings.hl7_version ?? '2.3.1'));
    return new Promise((resolve) => {
      if (!this.sock) { resolve(false); return; }
      void this.m.message(this.cfg.id, 'out', 'orders', msg.replace(/\r/g, '\n'), `${o.barcode}: ${o.codes.join(', ')}`);
      const timer = setTimeout(() => { this.hl7Waiter = null; resolve(false); }, 15_000);
      this.hl7Waiter = { resolve: (ok) => resolve(ok), timer };
      this.write(msg);
    });
  }

  // ---------------------------------------------------------------- push: მიღებული სინჯარების შეკვეთები
  private async pushTick() {
    if (this.cfg.order_mode !== 'push' || this.cfg.listen_only || !this.sock || this.pushing) return;
    if (this.astm?.busy) return;
    this.pushing = true;
    try {
      for (const o of await this.m.ingest.pendingPush(this.cfg.id, this.sendName)) {
        if (!this.sock) break;
        let ok = false; let err: string | undefined;
        if (this.cfg.protocol === 'astm') {
          const recs = buildOrder({ ...o, reportType: 'O' });
          await this.m.message(this.cfg.id, 'out', 'orders', recs.join('\n'), `${o.barcode}: ${o.codes.join(', ')}`);
          try { await this.astm?.send(recs); ok = !!this.astm; } catch (e) { err = (e as Error).message; }
        } else {
          ok = await this.sendOrm(o); if (!ok) err = 'ACK არ მოვიდა ან უარყოფილია';
        }
        await this.m.ingest.markOrder(o.order_id, ok, err);
      }
    } catch (e) { this.log.error((e as Error).message); } finally { this.pushing = false; }
  }
}

@Injectable()
export class GatewayManager implements OnApplicationShutdown {
  private readonly log = new Logger('LabGateway');
  private runners = new Map<string, Runner>();
  private timers: NodeJS.Timeout[] = [];
  private cmdBusy = false;
  constructor(@InjectDb() private readonly db: Database, readonly ingest: LabIngestService, private readonly alerts: LabAlertsService) {}

  async start() {
    const now = new Date();
    await this.db.insertInto('lab_gateway_state').values({ id: 1, heartbeat_at: now, started_at: now, version: process.env.npm_package_version ?? null, hostname: os.hostname() })
      .onConflict((oc) => oc.column('id').doUpdateSet({ heartbeat_at: now, started_at: now, hostname: os.hostname() })).execute();
    // წინა გაშვების სტატუსები აღარ არის აქტუალური
    await this.db.updateTable('lab_instruments').set({ status: 'offline', peer: null, status_at: now }).execute();
    await this.reload();
    this.timers.push(setInterval(() => void this.reload().catch((e) => this.log.error(e.message)), RELOAD_EVERY_MS));
    this.timers.push(setInterval(() => void this.db.updateTable('lab_gateway_state').set({ heartbeat_at: new Date() }).where('id', '=', 1).execute().catch(() => undefined), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.purge(), 3_600_000));
    this.timers.push(setInterval(() => void this.commands(), COMMANDS_EVERY_MS));
    this.timers.push(setInterval(() => void this.alerts.evaluateInstruments().catch((e) => this.log.error(`გაფრთხილებები: ${(e as Error).message}`)), ALERTS_EVERY_MS));
    void this.purge();
    this.log.log('emr-lab-gateway გაეშვა');
  }

  /** კონფიგურაციის სინქრონიზაცია: ახალი → ჩართვა; გათიშული/წაშლილი → გაჩერება; შეცვლილი → გადატვირთვა */
  private async reload() {
    const rows = await this.db.selectFrom('lab_instruments as i').innerJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['i.id', 'm.name', 'i.protocol', 'i.conn_mode', 'i.host', 'i.port', 'i.order_mode', 'i.settings', 'i.updated_at', 'i.listen_only'])
      .where('i.is_enabled', '=', true).where('m.is_active', '=', true).execute();
    const want = new Map(rows.map((r) => [r.id, r as unknown as InstrumentCfg]));
    for (const [id, run] of this.runners) {
      const c = want.get(id);
      if (!c || new Date(c.updated_at).getTime() !== new Date(run.cfg.updated_at).getTime()) {
        run.stop(); this.runners.delete(id);
        if (!c) await this.status(id, 'offline', null, null);
      }
    }
    for (const [id, c] of want) {
      if (this.runners.has(id)) continue;
      const r = new Runner(c, this); this.runners.set(id, r); r.start();
    }
  }

  async status(id: string, status: 'offline' | 'connecting' | 'listening' | 'connected' | 'error', peer: string | null, error: string | null) {
    const up = status === 'connected' || status === 'listening';
    await this.db.updateTable('lab_instruments').set({ status, peer, status_at: sql`now()`, down_since: up ? null : sql`coalesce(down_since, now())`,
      ...(error !== null ? { last_error: error } : status === 'connected' ? { last_error: null } : {}) })
      .where('id', '=', id).execute().catch(() => undefined);
  }
  async message(id: string, direction: 'in' | 'out', kind: string, raw: string, summary: string | null, error?: string) {
    const r = await this.db.insertInto('lab_instrument_messages').values({ instrument_id: id, direction, kind, raw, summary, error: error ?? null }).returning('id').executeTakeFirst();
    if (direction === 'in') await this.db.updateTable('lab_instruments').set({ last_message_at: sql`now()` }).where('id', '=', id).execute();
    return r ? String(r.id) : null;
  }
  /** ანალიზატორის მიერ გამოგზავნილი კოდები (რუკის შესავსებად) */
  async seen(id: string, results: { code: string; value: string; unit: string }[]) {
    const last = new Map<string, { value: string; unit: string }>();
    for (const r of results) if (r.code) last.set(r.code.slice(0, 40), { value: r.value.slice(0, 100), unit: r.unit.slice(0, 40) });
    for (const [code, v] of last) {
      await this.db.insertInto('lab_instrument_seen_codes').values({ instrument_id: id, code, last_value: v.value, last_unit: v.unit || null })
        .onConflict((oc) => oc.columns(['instrument_id', 'code']).doUpdateSet({ last_value: v.value, last_unit: v.unit || null, seen_count: sql`lab_instrument_seen_codes.seen_count + 1`, last_seen: sql`now()` }))
        .execute().catch(() => undefined);
    }
  }

  /** მართვის პანელის ბრძანებები (ბაზის რიგით): tcp_test / link_test / reconnect */
  private async commands() {
    if (this.cmdBusy) return;
    this.cmdBusy = true;
    try {
      for (;;) {
        const c = await sql<{ id: string; instrument_id: string | null; kind: string; params: Record<string, unknown> }>`
          UPDATE lab_gateway_commands SET status = 'running' WHERE id = (SELECT id FROM lab_gateway_commands WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, instrument_id, kind, params`.execute(this.db);
        const cmd = c.rows[0]; if (!cmd) break;
        let result: Record<string, unknown>;
        try {
          const run = cmd.instrument_id ? this.runners.get(cmd.instrument_id) : undefined;
          if (cmd.kind === 'reconnect') {
            if (run) { run.stop(); this.runners.delete(cmd.instrument_id!); }
            await this.reload(); result = { ok: true, note: 'კავშირი თავიდან იწყება' };
          } else if (run) result = await run.test();
          else if (cmd.params.host && cmd.params.port) result = await tcpTest(String(cmd.params.host), Number(cmd.params.port), cmd.params.protocol === 'astm');
          else result = { ok: false, error: cmd.instrument_id ? 'ანალიზატორი გამორთულია — ჩართეთ, ან შეამოწმეთ მისამართით' : 'მიუთითეთ მისამართი და პორტი' };
        } catch (e) { result = { ok: false, error: (e as Error).message }; }
        await this.db.updateTable('lab_gateway_commands').set({ status: result.ok === false ? 'failed' : 'done', result: JSON.stringify(result), finished_at: sql`now()` }).where('id', '=', cmd.id).execute();
      }
    } catch (e) { this.log.error(`ბრძანებები: ${(e as Error).message}`); } finally { this.cmdBusy = false; }
  }

  private async purge() {
    await this.db.deleteFrom('lab_instrument_messages').where('created_at', '<', sql<Date>`now() - make_interval(days => ${RETENTION_DAYS})`).execute().catch(() => undefined);
    await this.db.deleteFrom('lab_gateway_commands').where('created_at', '<', sql<Date>`now() - interval '7 days'`).execute().catch(() => undefined);
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.runners.values()) r.stop();
  }
}
